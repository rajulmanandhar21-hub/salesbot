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
async function generateChatSummary(chatHistoryArray)
