const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "jobbot123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

// In-memory application state tracker
const applicationState = {};

// Helper: Log every message exchange to Google Sheets monitoring tab
async function logToMonitor(sessionId, channel, sender, messageText, responseTimeMs = 0, status = "200 OK") {
  try {
    const url = process.env.GOOGLE_SHEET_URL;
    if (!url) return;
    await axios.post(url, {
      type: "log",
      timestamp: new Date().toISOString(),
      channel: channel,
      session_id: sessionId,
      sender: sender,
      message_text: messageText,
      input_tokens: 0, // Groq handles tokens on server-side cache
      output_tokens: 0,
      responseTimeMs: responseTimeMs,
      status: status
    });
  } catch (err) {
    console.warn("⚠️ Monitor log failed:", err.message);
  }
}

// Helper: Ask Groq Cloud (Llama 3.3 70B) — High-Velocity Free Tier
async function askGroq(userMessage) {
  if (!GROQ_API_KEY) {
    console.error("🚨 CRITICAL: GROQ_API_KEY environment variable is missing!");
    throw new Error("Groq API key not configured");
  }

  try {
    console.log(`🚀 Sending request to Groq Cloud (Llama 3.3 70B)...`);
    const startTime = Date.now();

    const response = await axios.post(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        model: "llama-3.3-70b-versatile",
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userMessage }
        ],
        temperature: 0.2 // Kept low for predictable structural JSON outputs
      },
      {
        headers: {
          "Authorization": `Bearer ${GROQ_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const responseTimeMs = Date.now() - startTime;
    const replyText = response.data.choices[0].message.content;
    
    console.log(`✅ Groq Response Received successfully in ${responseTimeMs}ms!`);
    return { replyText, responseTimeMs };

  } catch (error) {
    console.error(`❌ Groq API Call Failed: ${error.response?.data?.error?.message || error.message}`);
    throw error;
  }
}

// Helper: Send structured leads straight to your specific Apps Script routing channel
async function sendToGoogleSheets(phone, name, education, chatSummary, priority, channel) {
  try {
    const url = process.env.GOOGLE_SCRIPT_URL || process.env.GOOGLE_SHEET_URL;
    if (!url) return console.warn("⚠️ Google Sheets routing URL environment variable missing.");
    
    // SAFEGUARD: Prevent Google Sheets from treating "+2" as a mathematical formula error
    let safeEducation = education ? education.trim() : "";
    if (safeEducation.startsWith('+') || safeEducation.startsWith('=')) {
      safeEducation = `'${safeEducation}`; 
    }
    
    const targetChannel = channel || "WhatsApp";
    
    await axios.post(url, {
      type: "lead",
      channel: targetChannel, // Passes 'WhatsApp' or 'Messenger' cleanly to drive your Apps Script router
      phone: phone, 
      name: name || "Unknown Candidate", 
      education: safeEducation || "Not Provided",
      priority: priority || "MEDIUM", 
      summary: chatSummary || "No transcript brief generated."
    });
    console.log(`🚀 [LEAD DEPLOY] ${targetChannel} lead logged to sheet for: ${phone}`);
  } catch (error) {
    console.error("❌ Failed to push lead to Google Sheets:", error.message);
  }
}

// Helper: Send WhatsApp message (Cleaned up from old duplication dependencies)
async function sendWhatsApp(to, text) {
  try {
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
    console.log(`📲 Outbound WhatsApp ping delivered to ${to}`);
  } catch (err) {
    console.error("❌ WhatsApp dispatch failed:", err.response?.data || err.message);
  }
}

// Helper: Send Messenger message
async function sendMessenger(to, text) {
  try {
    await axios.post(
      `https://graph.facebook.com/v19.0/me/messages?access_token=${process.env.MESSENGER_TOKEN}`,
      {
        recipient: { id: to },
        message: { text: text }
      }
    );
    console.log(`💬 Outbound Messenger ping delivered to ${to}`);
  } catch (err) {
    console.error("❌ Messenger dispatch failed:", err.response?.data || err.message);
  }
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

// Centralized Inbound Processing Engine
app.post('/webhook', async (req, res) => {
  try {
    const entry = req.body.entry?.[0];
    if (!entry) return res.sendStatus(200);

    // ==========================================
    // CHANNEL DETECTION — WhatsApp vs Messenger
    // ==========================================
    let userMessage, from, channel;

    const change = entry?.changes?.[0];
    const waMessage = change?.value?.messages?.[0];
    const messaging = entry?.messaging?.[0];

    if (waMessage && waMessage.type === 'text') {
      userMessage = waMessage.text.body.trim();
      from = waMessage.from;
      channel = "WhatsApp";
    } else if (messaging && messaging.message && messaging.message.text) {
      userMessage = messaging.message.text.trim();
      from = String(messaging.sender.id);
      channel = "Messenger";
    } else {
      return res.sendStatus(200);
    }

    const lowerMessage = userMessage.toLowerCase();
    const now = new Date();

    // Initialize state
    if (!applicationState[from]) {
      applicationState[from] = { stage: 0, name: "", education: "", history: [], status: "Active", lastInteraction: now };
    }
    const currentState = applicationState[from];
    if (!currentState.history) currentState.history = [];

    // Log incoming user message to monitor
    await logToMonitor(from, channel, "User", userMessage);
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
      await logToMonitor(from, channel, "Bot", exitMsg);
      channel === "Messenger" ? await sendMessenger(from, exitMsg) : await sendWhatsApp(from, exitMsg);
      return res.sendStatus(200);
    }

    // Closed session protector
    if (currentState.status === "Closed") {
      console.log(`User ${from} opted out. Ignoring message.`);
      return res.sendStatus(200);
    }

    let botResponseText = "";
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
      
      const result = await askGroq(classificationPrompt);
      const stage1Class = result.replyText.trim().toUpperCase().split(/\s+/)[0];
      responseTimeMs += result.responseTimeMs;

      if (stage1Class === "CANCEL") {
        currentState.stage = 0;
        currentState.status = "Closed";
        botResponseText = "No problem at all! I have stopped the application process. Feel free to reach out whenever you're ready.";
      } else if (stage1Class === "QUESTION") {
        const answerResult = await askGroq(`You are an HR assistant. A job applicant asked this during the application process: "${userMessage}". Answer helpfully, then remind them to please provide their full name to continue.`);
        botResponseText = answerResult.replyText;
      } else {
        currentState.name = userMessage;
        currentState.stage = 2;
        botResponseText = "Got it! And what is your highest educational qualification? (e.g., +2 Pass, Bachelor's in BBA, BBS, etc.)";
      }

    // ==========================================
    // STAGE 2: Collect Education & Score Priority
    // ==========================================
    } else if (currentState.stage === 2) {
      let classification = "ANSWER"; 

      try {
        const classificationPrompt = `You are a strict single-word classifier. Nothing else.
        A job applicant was asked: "What is your highest educational qualification?"
        Their reply was: "${userMessage}"
        Your job:
        - If their reply is ONLY stating a degree or education level, output: ANSWER
        - If their reply contains ANY question mark or doubt, output: QUESTION  
        - If they want to stop or cancel, output: CANCEL
        STRICT RULES: Output exactly one word only.`;

        console.log("🔍 Classifying Stage 2 message via Groq...");
        const classResult = await askGroq(classificationPrompt);
        classification = classResult.replyText.trim().toUpperCase().split(/\s+/)[0];
      } catch (classError) {
        console.warn("⚠️ Classification failed, assuming ANSWER placeholder.");
        classification = "ANSWER"; 
      }

      if (classification === "CANCEL") {
        currentState.stage = 0;
        currentState.status = "Closed";
        botResponseText = "No problem at all! I have stopped the application process. Feel free to reach out whenever you're ready.";
      } else if (classification === "QUESTION") {
        try {
          const answerPrompt = `You are an HR assistant. A job applicant asked this question about their qualification during an application: "${userMessage}". Answer their concern help
