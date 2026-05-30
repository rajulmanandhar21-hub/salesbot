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
      console.warn(`⚠️ Key index [${i}] is not configured in environment variables. Skipping...`);
      continue;
    }

    try {
      const label = i === 0 ? "PRIMARY" : i === 1 ? "FIRST BACKUP" : "SECOND BACKUP";
      console.log(`🚀 Attempting Gemini API call using the [${label}] key...`);

      const geminiRes = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${currentKey}`,
        {
          contents: [{ role: "user", parts: [{ text: userMessage }] }],
          systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
        }
      );

      console.log(`✅ Success! Response fetched using the [${label}] key.`);
      return geminiRes.data.candidates[0].content.parts[0].text;

    } catch (error) {
      const label = i === 0 ? "PRIMARY" : i === 1 ? "FIRST BACKUP" : "SECOND BACKUP";
      console.warn(`❌ [${label}] key failed or rate-limited. Error: ${error.message}`);
      
      if (i === apiKeys.length - 1) {
        console.error("🚨 CRITICAL: All primary and backup Gemini API keys have been completely exhausted!");
        throw error;
      }
      
      console.log("🔄 Shifting down the pipeline to the next backup key...");
    }
  }
}

// Helper: Condense historic chat data array into a professional HR profile snippet
async function generateChatSummary(chatHistoryArray) {
  if (!chatHistoryArray || chatHistoryArray.length === 0) return "No conversation log available.";

  // Transform your chat log array into a single plain-text transcript block
  const formattedTranscript = chatHistoryArray
    .map(msg => `${msg.role === "user" ? "Candidate" : "Bot"}: ${msg.text}`)
    .join("\n");

  // Dynamic injection combining your Render instructions with the live chat text
  const payloadMessage = `${process.env.SUMMARY_PROMPT}\n\nTRANSCRIPT TO EVALUATE:\n${formattedTranscript}`;

  try {
    console.log("🧠 Generating applicant profile summary snippet via Gemini...");
    // Fires an execution call to your existing askGemini runner
    const rawSummaryOutput = await askGemini(payloadMessage);
    return rawSummaryOutput.trim();
  } catch (err) {
    console.warn("⚠️ Summary engine failed to execute. Falling back to default baseline string.");
    return "Profile registration completed successfully.";
  }
}

// Helper: Send data to Google Sheets Web App
async function sendToGoogleSheets(phone, name, education, chatSummary) {
  try {
    const url = process.env.GOOGLE_SHEET_URL;
    if (!url) {
      console.warn("⚠️ GOOGLE_SHEET_URL environment variable is missing.");
      return;
    }

    // Pass all four parameters cleanly to your Google Apps Script
    await axios.post(url, {
      phone: phone,
      name: name,
      education: education,
      summary: chatSummary // Your brand-new data column field
    });

    console.log(`📊 Spreadsheet successfully updated for user: ${phone}`);
  } catch (error) {
    console.error("❌ Failed to push data row to Google Sheets:", error.message);
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
// =====================================================================
// REPLACE ONLY THIS BLOCK FROM YOUR FILE (FROM app.post DOWN TO THE END OF ITS BLOCK)
// =====================================================================
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

    // 1. Initialize or Reset state for conversations
    if (!applicationState[from]) {
      applicationState[from] = { stage: 0, name: "", education: "", status: "Active", lastInteraction: now };
    }

    const currentState = applicationState[from];

    // 2. TIMEOUT / "LEFT ON SEEN" LOGIC (4-Hour Check)
    const hoursDifference = (now - new Date(currentState.lastInteraction)) / (1000 * 60 * 60);
    if (hoursDifference > 4) {
      console.log(`User ${from} was left on seen for over 4 hours. Resetting session context.`);
      currentState.stage = 0;
      currentState.name = "";
      currentState.education = "";
      currentState.status = "Active"; 
    }

    // Always update interaction time whenever they message
    currentState.lastInteraction = now;

    // 3. HARD-CODED KILL KEYWORDS (Immediate escape hatch)
    const exitKeywords = ["don't want to apply", "cancel", "stop", "i don't want to apply anymore", "thank you no", "bhayo pardaina"];
    if (exitKeywords.some(keyword => lowerMessage.includes(keyword))) {
      currentState.stage = 0;
      currentState.status = "Closed";
      await sendWhatsApp(from, "Understood. I have canceled your application setup. Let me know if you need anything else!");
      return res.sendStatus(200);
    }

    // 4. IF CONVERSATION IS CLOSED, MULTIPLE REPLIES PROTECTOR
    if (currentState.status === "Closed") {
      console.log(`User ${from} has opted out. Ignoring message to preserve quota.`);
      return res.sendStatus(200);
    }

    let botResponseText = "";

    // 5. STAGE 1: HANDLING INPUT FOR NAME
    if (currentState.stage === 1) {
      const classificationPrompt = `The user is in the middle of a form-filling process for a job application. They were asked for their name. They responded with: "${userMessage}". If they are trying to back out, cancel, or say they aren't interested anymore (even casually), reply with the word "CANCEL". Otherwise, reply with "CONTINUE".`;
      const checkCancel = await askGemini(classificationPrompt);

      if (checkCancel.includes("CANCEL")) {
        currentState.stage = 0;
        currentState.status = "Closed";
        await sendWhatsApp(from, "No problem at all! I have stopped the application process. Feel free to reach out whenever you're ready.");
        return res.sendStatus(200);
      }

      currentState.name = userMessage;
      currentState.stage = 2;
      botResponseText = "Got it! And what is your highest educational qualification? (e.g., +2 Pass, Bachelor's in BBA, BBS, etc.)";

    // 6. STAGE 2: HANDLING INPUT FOR EDUCATION
    } else if (currentState.stage === 2) {
  // 1. Save the education details the user just sent
  currentState.education = userMessage.trim();
  
  console.log(`🎯 Funnel data gathering complete for: ${from}. Extracting summary...`);
  
  try {
    // 2. Pass the entire chat history array to your new helper function
    const candidateSummarySnippet = await generateChatSummary(currentState.history);

    // 3. Send ALL 4 pieces of data to Google Sheets
    await sendToGoogleSheets(
      from,
      currentState.name,
      currentState.education,
      candidateSummarySnippet // <-- Your new summary string injected here!
    );

    botResponseText = "Thank you so much! Your application profile details have been securely logged into our system database. Our HR recruitment coordination team will reach out directly to your phone number within the next 24 hours. Have a wonderful day!";
    currentState.stage = "Closed";

  } catch (error) {
    console.error("🚨 Error during Stage 2 completion pipeline:", error.message);
    botResponseText = "Thank you! Your details have been submitted.";
    currentState.stage = "Closed";
  }

    // 7. STAGE 0: NORMAL CONVERSATION MODE
} else {
  botResponseText = await askGemini(userMessage);

  if (botResponseText.includes("[START_APPLICATION]")) {
    console.log(`Smart intercept: Gemini initiated form-filling mode for ${from}`);
    
    // Strip the structural tag out
    let transitionMessage = botResponseText.replace("[START_APPLICATION]", "").trim();
    
    // Smoothly shift the state directly into Stage 1
    currentState.stage = 1;
    
    // FIX: Instead of just transitioning, attach the clear question asking for their name right away!
    botResponseText = transitionMessage + "\n\nGreat! Let's get your application registered for the hiring team. To start, what is your full name?";
  }
}

    // 🛑 GLOBAL INTERCEPT: Strips the tag if Gemini appended it anywhere in Stage 0
    if (botResponseText.includes("[CLOSE_CONVERSATION]")) {
      console.log(`Global intercept: Gemini signaled a close conversation event for ${from}`);
      botResponseText = botResponseText.replace("[CLOSE_CONVERSATION]", "").trim();
      currentState.stage = 0;
      currentState.status = "Closed";
    }

    await sendWhatsApp(from, botResponseText);
    res.sendStatus(200);

  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.sendStatus(500);
  }
});
// =====================================================================
// END OF REPLACEMENT BLOCK (Leave the app.listen line below it untouched)
// =====================================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
