const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "jobbot123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

// In-memory application state tracker
const applicationState = {};

// Helper: Log every message exchange to Google Sheets monitoring tab
async function logToMonitor(sessionId, sender, messageText, inputTokens = 0, outputTokens = 0, responseTimeMs = 0, status = "200 OK") {
  try {
    const url = process.env.GOOGLE_SHEET_URL;
    if (!url) return;
    await axios.post(url, {
      type: "log",
      timestamp: new Date().toISOString(),
      channel: "WhatsApp",
      session_id: sessionId,
      sender: sender,
      message_text: messageText,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      response_time_ms: responseTimeMs,
      status: status
    });
  } catch (err) {
    console.warn("⚠️ Monitor log failed:", err.message);
  }
}

// Helper: Ask Gemini with Automatic Backup Fallback
async function askGemini(userMessage) {
  const apiKeys = [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_BACKUP,
    process.env.GEMINI_API_KEY_BACKUP_2
  ];

  for (let i = 0; i < apiKeys.length; i++) {
    const currentKey = apiKeys[i];

    if (!currentKey) {
      console.warn(`⚠️ Key index [${i}] is not configured. Skipping...`);
      continue;
    }

    try {
      const label = i === 0 ? "PRIMARY" : i === 1 ? "FIRST BACKUP" : "SECOND BACKUP";
      console.log(`🚀 Attempting Gemini API call using [${label}] key...`);

      const startTime = Date.now();

      const geminiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${currentKey}`,
        {
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
        }
      );

      const responseTimeMs = Date.now() - startTime;
      const inputTokens = geminiRes.data.usageMetadata?.promptTokenCount || 0;
      const outputTokens = geminiRes.data.usageMetadata?.candidatesTokenCount || 0;
      const replyText = geminiRes.data.candidates[0].content.parts[0].text;

      console.log(`✅ Success! [${label}] key. Tokens: ${inputTokens} in / ${outputTokens} out. Time: ${responseTimeMs}ms`);

      return { replyText, inputTokens, outputTokens, responseTimeMs };

    } catch (error) {
      const label = i === 0 ? "PRIMARY" : i === 1 ? "FIRST BACKUP" : "SECOND BACKUP";
      console.warn(`❌ [${label}] key failed. Error: ${error.message}`);

      if (i === apiKeys.length - 1) {
        console.error("🚨 CRITICAL: All Gemini API keys exhausted!");
        throw error;
      }
      console.log("🔄 Switching to next backup key...");
    }
  }
}

// Helper: Generate chat summary
async function generateChatSummary(chatHistoryArray) {
  if (!chatHistoryArray || chatHistoryArray.length === 0) return "No conversation log available.";

  const formattedTranscript = chatHistoryArray
    .map(msg => `${msg.role === "user" ? "Candidate" : "Bot"}: ${msg.text}`)
    .join("\n");

  const payloadMessage = `${process.env.SUMMARY_PROMPT}\n\nTRANSCRIPT TO EVALUATE:\n${formattedTranscript}`;

  try {
    console.log("🧠 Generating applicant profile summary...");
    const { replyText } = await askGemini(payloadMessage);
    return replyText.trim();
  } catch (err) {
    console.warn("⚠️ Summary generation failed. Using fallback.");
    return "Profile registration completed successfully.";
  }
}

// Helper: Send data to Google Sheets (leads)
async function sendToGoogleSheets(phone, name, education, chatSummary) {
  try {
    const url = process.env.GOOGLE_SHEET_URL;
    if (!url) return console.warn("⚠️ GOOGLE_SHEET_URL missing.");
    await axios.post(url, {
      type: "lead",
      phone, name, education,
      summary: chatSummary
    });
    console.log(`📊 Lead logged for: ${phone}`);
  } catch (error) {
    console.error("❌ Failed to push lead to Google Sheets:", error.message);
  }
}

// Helper: Send WhatsApp message
async function sendWhatsApp(to, text) {
  await axios.post(
    `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
    {
      messaging_product: "whatsapp",
      to: to,
      type: "text",
      text: { body: text }
    },
    {
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
    }
  );
}

// Meta webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === VERIFY_TOKEN) {
    console.log('Webhook verified!');
    res.status(200).send(challenge);
  } else {
    res.sendStatus(403);
  }
});

// Handle incoming WhatsApp messages
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    const change = entry?.changes?.[0];
    const message = change?.value?.messages?.[0];

    if (!message || message.type !== 'text') {
      return res.sendStatus(200);
    }

    const userMessage = message.text.body.trim();
    const lowerMessage = userMessage.toLowerCase();
    const from = message.from;
    const now = new Date();

    // Initialize state
    if (!applicationState[from]) {
      applicationState[from] = { stage: 0, name: "", education: "", history: [] };
    }
    const currentState = applicationState[from];
    if (!currentState.history) currentState.history = [];

    // Log incoming user message to monitor
    await logToMonitor(from, "User", userMessage);
    currentState.history.push({ role: "user", text: userMessage });

    // 4-hour timeout reset
    const hoursDifference = (now - new Date(currentState.lastInteraction)) / (1000 * 60 * 60);
    if (hoursDifference > 4) {
      console.log(`User ${from} timed out. Resetting session.`);
      currentState.stage = 0;
      currentState.name = "";
      currentState.education = "";
      currentState.status = "Active";
    }
    currentState.lastInteraction = now;

    // Kill keywords
    const exitKeywords = ["don't want to apply", "cancel", "stop", "i don't want to apply anymore", "thank you no", "bhayo pardaina"];
    if (exitKeywords.some(keyword => lowerMessage.includes(keyword))) {
      currentState.stage = 0;
      currentState.status = "Closed";
      const exitMsg = "Understood. I have canceled your application setup. Let me know if you need anything else!";
      await logToMonitor(from, "Bot", exitMsg);
      await sendWhatsApp(from, exitMsg);
      return res.sendStatus(200);
    }

    // Closed session protector
    if (currentState.status === "Closed") {
      console.log(`User ${from} opted out. Ignoring message.`);
      return res.sendStatus(200);
    }

    let botResponseText = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let responseTimeMs = 0;

    // Stage 1: Collect name
    if (currentState.stage === 1) {
      const classificationPrompt = `The user is filling out a job application form and was asked for their name. They responded: "${userMessage}". If they want to cancel or back out, reply "CANCEL". Otherwise reply "CONTINUE".`;
      const result = await askGemini(classificationPrompt);
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      responseTimeMs += result.responseTimeMs;

      if (result.replyText.includes("CANCEL")) {
        currentState.stage = 0;
        currentState.status = "Closed";
        botResponseText = "No problem at all! I have stopped the application process. Feel free to reach out whenever you're ready.";
      } else {
        currentState.name = userMessage;
        currentState.stage = 2;
        botResponseText = "Got it! And what is your highest educational qualification? (e.g., +2 Pass, Bachelor's in BBA, BBS, etc.)";
      }

    // Stage 2: Collect education
    } else if (currentState.stage === 2) {
      currentState.education = userMessage.trim();
      console.log(`🎯 Funnel complete for: ${from}`);

      try {
        const candidateSummary = await generateChatSummary(currentState.history);
        await sendToGoogleSheets(from, currentState.name, currentState.education, candidateSummary);
        botResponseText = "Thank you so much! Your application profile details have been securely logged into our system. Our HR team will reach out within 24 hours. Have a wonderful day!";
        currentState.stage = "Closed";
      } catch (error) {
        console.error("🚨 Stage 2 error:", error.message);
        botResponseText = "Thank you! Your details have been submitted.";
        currentState.stage = "Closed";
      }

    // Stage 0: Normal conversation
    } else {
      const result = await askGemini(userMessage);
      botResponseText = result.replyText;
      inputTokens = result.inputTokens;
      outputTokens = result.outputTokens;
      responseTimeMs = result.responseTimeMs;

      if (botResponseText.includes("[START_APPLICATION]")) {
        console.log(`Smart intercept: application funnel triggered for ${from}`);
        let transitionMessage = botResponseText.replace("[START_APPLICATION]", "").trim();
        currentState.stage = 1;
        botResponseText = transitionMessage + "\n\nGreat! Let's get your application registered. To start, what is your full name?";
      }
    }

    // Global close intercept
    if (botResponseText.includes("[CLOSE_CONVERSATION]")) {
      console.log(`Close intercept triggered for ${from}`);
      botResponseText = botResponseText.replace("[CLOSE_CONVERSATION]", "").trim();
      currentState.stage = 0;
      currentState.status = "Closed";
    }

    currentState.history.push({ role: "model", text: botResponseText });

    // Log bot response to monitor
    await logToMonitor(from, "Bot", botResponseText, inputTokens, outputTokens, responseTimeMs, "200 OK");

    await sendWhatsApp(from, botResponseText);
    res.sendStatus(200);

  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
