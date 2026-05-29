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

// Helper: Ask Gemini
async function askGemini(userMessage) {
  const geminiRes = await axios.post(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_API_KEY}`,
    {
      contents: [{ role: "user", parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
    }
  );
  return geminiRes.data.candidates[0].content.parts[0].text;
}

// Helper: Send to Google Sheets
async function sendToGoogleSheets(phone, name, education) {
    try {
        const url = process.env.GOOGLE_SHEET_URL;
        if (!url) return console.error("GOOGLE_SHEET_URL missing!");

        // We stringify the JSON payload to ensure Google's doPost apps script parses it smoothly
        await axios.post(url, JSON.stringify({
            phone: phone,
            name: name,
            education: education
        }), {
            headers: {
                'Content-Type': 'text/plain' // Using text/plain completely bypasses CORS pre-flight blocks on Google Apps Script
            }
        });
        console.log(`Successfully logged lead to Google Sheets: ${name}`);
    } catch (err) {
        console.error("Error pushing data to Google Sheets:", err.message);
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
    const from = message.from;

    // Initialize state for new conversations
    if (!applicationState[from]) {
      applicationState[from] = { stage: 0, name: "", education: "" };
    }

    const currentState = applicationState[from];
    let botResponseText = "";

    if (currentState.stage === 1) {
      // Waiting for name
      currentState.name = userMessage;
      currentState.stage = 2;
      botResponseText = "Got it! And what is your highest educational qualification? (e.g., +2 Pass, Bachelor's in BBA, BBS, etc.)";

    } else if (currentState.stage === 2) {
      // Waiting for education
      currentState.education = userMessage;
      currentState.stage = 3;
      botResponseText = `Thank you, ${currentState.name}! Your application has been submitted successfully to our hiring team. We will contact you soon.`;

      // Log to Google Sheets in background
      sendToGoogleSheets(from, currentState.name, currentState.education);

      // Reset state
      applicationState[from] = { stage: 0, name: "", education: "" };

    } else {
      // Normal conversation — send to Gemini
      botResponseText = await askGemini(userMessage);

      // Check if user wants to apply
      const lowerMessage = userMessage.toLowerCase();
      if (
        lowerMessage.includes("apply") ||
        lowerMessage.includes("farm varna") ||
        lowerMessage.includes("form varna")
      ) {
        currentState.stage = 1;
        botResponseText = "Great! Let's get your application started. What is your full name?";
      }
    }

    await sendWhatsApp(from, botResponseText);
    res.sendStatus(200);

  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
