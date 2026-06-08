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

// Helper: Ask Gemini with Automatic Backup Fallback & Rate-Limit Cool Down
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

      // CRITICAL ADDITION: Wait 1.5 seconds before hitting the next backup key
      console.log("⏱️ Rate limit safeguard activated. Cooling down for 1.5s before switching keys...");
      await new Promise(resolve => setTimeout(resolve, 1500));
      console.log("🔄 Switching to next backup key...");
    }
  }
}

// Helper: Send data to Google Sheets
async function sendToGoogleSheets(phone, name, education, chatSummary, priority) {
  try {
    const url = process.env.GOOGLE_SHEET_URL;
    if (!url) return console.warn("⚠️ GOOGLE_SHEET_URL missing.");
    
    await axios.post(url, {
      type: "lead",
      phone: phone, 
      name: name, 
      education: education,
      priority: priority, 
      summary: chatSummary
    });
    console.log(`📊 Lead logged with priority [${priority}] for: ${phone}`);
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

    // ==========================================
    // STAGE 1: Collect Name
    // ==========================================
    if (currentState.stage === 1) {
      const classificationPrompt = `You are a strict classifier. A user filling out a job application was asked for their full name. Their response: "${userMessage}".
      Classify into exactly one category:
      - CANCEL: if they want to stop, back out, or are not interested
      - QUESTION: if they are asking something or expressing confusion
      - NAME: if they are providing their name
      
      Rules:
      - Reply with only the single word: CANCEL, QUESTION, or NAME
      - No punctuation, no explanation, nothing else`;
      const result = await askGemini(classificationPrompt);
      const stage1Class = result.replyText.trim().toUpperCase().split(/\s+/)[0];
      inputTokens += result.inputTokens;
      outputTokens += result.outputTokens;
      responseTimeMs += result.responseTimeMs;

      if (stage1Class === "CANCEL") {
        currentState.stage = 0;
        currentState.status = "Closed";
        botResponseText = "No problem at all! I have stopped the application process. Feel free to reach out whenever you're ready.";
      } else if (stage1Class === "QUESTION") {
        const answerResult = await askGemini(`You are an HR assistant. A job applicant asked this during the application process: "${userMessage}". Answer helpfully, then remind them to please provide their full name to continue.`);
        botResponseText = answerResult.replyText;
      } else {
        currentState.name = userMessage;
        currentState.stage = 2;
        botResponseText = "Got it! And what is your highest educational qualification? (e.g., +2 Pass, Bachelor's in BBA, BBS, etc.)";
      }

    // ==========================================
    // STAGE 2: Collect Education & Score Priority (Optimized)
    // ==========================================
   // ==========================================
    // STAGE 2: Collect Education & Score Priority (Fault-Tolerant)
    // ==========================================
    } else if (currentState.stage === 2) {
      let classification = "ANSWER"; // Safe default baseline

      try {
        const classificationPrompt = `You are a strict single-word classifier. Nothing else.
        A job applicant was asked: "What is your highest educational qualification?"
        Their reply was: "${userMessage}"
        Your job:
        - If their reply is ONLY stating a degree or education level, output: ANSWER
        - If their reply contains ANY question mark or doubt, output: QUESTION  
        - If they want to stop or cancel, output: CANCEL
        STRICT RULES: Output exactly one word only.`;

        console.log("🔍 Classifying Stage 2 message...");
        const classResult = await askGemini(classificationPrompt);
        classification = classResult.replyText.trim().toUpperCase().split(/\s+/)[0];
      } catch (classError) {
        console.warn("⚠️ Classification API failed due to Rate Limits. Defaulting to ANSWER to prevent freeze.");
        classification = "ANSWER"; 
      }

      if (classification === "CANCEL") {
        currentState.stage = 0;
        currentState.status = "Closed";
        botResponseText = "No problem at all! I have stopped the application process. Feel free to reach out whenever you're ready.";
      } else if (classification === "QUESTION") {
        try {
          const answerPrompt = `You are an HR assistant. A job applicant asked this question about their qualification during an application: "${userMessage}". Answer their concern helpfully and honestly based on the job details you know. At the end of your answer, remind them to please provide their highest educational qualification to continue their application.`;
          const answerResult = await askGemini(answerPrompt);
          botResponseText = answerResult.replyText;
        } catch (error) {
          botResponseText = "I received your question, but our system is currently experiencing a minor delay. Could you please state your highest qualification directly so we can process your application details?";
        }
      } else {
        console.log(`🎯 Funnel complete for: ${from}. Running evaluation pipeline...`);

        try {
          const formattedTranscript = currentState.history
            .map(msg => `${msg.role === "user" ? "Candidate" : "Bot"}: ${msg.text}`)
            .join("\n");

          const combinedEvaluationPrompt = `
=========================================
EVALUATION TASK INSTRUCTIONS:
You are an internal HR data assistant. Analyze the transcript below and output exactly three things formatted precisely as JSON text. 

Expected JSON format:
{
  "education": "1-3 words extraction of highest degree (e.g. BBA Finance, +2 Pass)",
  "priority": "HIGH, MEDIUM, or LOW based on the system criteria",
  "summary": "Your concise 2-sentence professional summary."
}

TRANSCRIPT TO EVALUATE:
${formattedTranscript}
`;

          console.log("🧠 Executing unified evaluation call...");
          const evaluationResult = await askGemini(combinedEvaluationPrompt);
          
          let parsedData;
          try {
            let cleanJsonText = evaluationResult.replyText.replace(/```json|```/g, "").trim();
            parsedData = JSON.parse(cleanJsonText);
          } catch (jsonErr) {
            console.warn("⚠️ JSON parse failed, running text matching fallback...");
            parsedData = {
              education: userMessage.trim().substring(0, 30),
              priority: evaluationResult.replyText.includes("HIGH") ? "HIGH" : evaluationResult.replyText.includes("LOW") ? "LOW" : "MEDIUM",
              summary: "Profile submitted via automated text fallback."
            };
          }

          currentState.education = parsedData.education || userMessage.trim();
          let detectedPriority = parsedData.priority ? parsedData.priority.toUpperCase() : "MEDIUM";
          let finalSummary = parsedData.summary || "Profile evaluation completed.";

          console.log(`✨ Priority Engine Determined: [${detectedPriority}]`);

          // Deliver data directly to your Sheet layout
          await sendToGoogleSheets(from, currentState.name, currentState.education, finalSummary, detectedPriority);
          
          botResponseText = "Thank you so much! Your application profile details have been securely logged into our system. Our HR team will reach out within 24 hours. Have a wonderful day!";
          currentState.stage = "Closed";

        } catch (error) {
          console.error("🚨 API Limit Hit During Summary Evaluation! Running Safeguard Bypass...", error.message);
          
          // Safeguard Bypass: Extract data locally from memory variables instead of crashing
          let fallbackEducation = userMessage.length > 25 ? "Provided Profile Details" : userMessage.trim();
          let fallbackPriority = "MEDIUM"; // Baseline priority
          let fallbackSummary = "Application logged via rate-limit backup safety engine.";

          console.log(`🛡️ Safeguard Activated! Pushing fallback profile for ${currentState.name}`);

          await sendToGoogleSheets(from, currentState.name, fallbackEducation, fallbackSummary, fallbackPriority);

          botResponseText = "Thank you! Your details have been successfully received and submitted to our hiring pipeline. Our HR team will get in touch with you shortly.";
          currentState.stage = "Closed";
        }
      }
    // ==========================================
    // STAGE 0: Normal Conversation
    // ==========================================
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
       botResponseText = "Great! Let's get your application registered. To start, what is your full name?";
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
