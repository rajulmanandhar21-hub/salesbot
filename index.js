const express = require('express');
const axios = require('axios');
const { Groq } = require('groq-sdk'); // ✅ FIXED: Added Groq SDK import
const { GoogleGenAI } = require('@google/genai'); // ✅ FIXED: Added Gemini SDK import

const app = express();
app.use(express.json());

const VERIFY_TOKEN = "jobbot123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY; // Ensure this is set in Render
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT || "You are an HR assistant.";

// ✅ FIXED: Initialize client instances safely
const groq = new Groq({ apiKey: GROQ_API_KEY });
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// In-memory application state tracker
const applicationState = {};

// Helper: Log every message exchange to Google Sheets monitoring tab
async function logToMonitor(sessionId, channel, sender, messageText, responseTimeMs = 0, status = "200 OK") {
  try {
    const url = process.env.GOOGLE_SHEET_URL;
    if (!url) return;
    await axios.post(url, {
      type: "log",
      timestamp: new Date().toLocaleString("en-US", { timeZone: "Asia/Kathmandu" }),
      channel: channel,
      session_id: sessionId,
      sender: sender,
      message_text: messageText,
      input_tokens: 0, 
      output_tokens: 0,
      responseTimeMs: responseTimeMs,
      status: status
    });
  } catch (err) {
    console.warn("⚠️ Monitor log failed:", err.message);
  }
}

// Helper: Ask Groq Cloud (Llama 3.3 70B) with Balanced Gemini Failover
// ✅ FIXED: Parameter structured to accept contextual vacancy data dynamically
async function askGroq(promptText, vacancyContext = "", customSystem = null) {
  let isRateLimit = false;
  let groqResult = null;

  // Build a highly descriptive system baseline instruction
  const finalSystemInstruction = customSystem || 
    `${SYSTEM_PROMPT}\n\nCURRENT LIVE VACANCY CONTEXT:\n${vacancyContext || "No alternative vacancy specs provided."}`;

  // 1. Primary Execution via Groq
  try {
    console.log("🚀 Attempting primary processing via Groq Cloud...");
    
    const groqResponse = await groq.chat.completions.create({
      messages: [
        { role: "system", content: finalSystemInstruction },
        { role: "user", content: promptText }
      ],
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
    });
    
    groqResult = {
      replyText: groqResponse.choices[0].message.content,
      responseTimeMs: 0
    };
  } catch (error) {
    isRateLimit = error.status === 429 || (error.message && error.message.includes("rate_limit"));
    if (!isRateLimit) {
      throw error;
    }
    console.warn("⚠️ Groq Rate Limit Exceeded! Shifting over to execute backup track...");
  }

  if (groqResult) return groqResult;

  // 2. Fallback Execution via Gemini
  if (isRateLimit) {
    try {
      const backupStartTime = Date.now();
      
      const geminiResponse = await ai.models.generateContent({
        model: "gemini-1.5-flash",
        contents: `${finalSystemInstruction}\n\nUser Message: ${promptText}`,
      });
      
      const backupResponseTimeMs = Date.now() - backupStartTime;
      console.log("✅ Backup evaluation completed successfully via Gemini!");
      
      return {
        replyText: geminiResponse.text,
        responseTimeMs: backupResponseTimeMs
      };
    } catch (geminiError) {
      console.error("🚨 Critical Error: Both Groq and Gemini providers failed entirely.", geminiError);
      throw geminiError;
    }
  }
}

// Helper: Send structured leads straight to your specific Apps Script routing channel
async function sendToGoogleSheets(phone, name, education, chatSummary, priority, channel) {
  try {
    const url = process.env.GOOGLE_SCRIPT_URL || process.env.GOOGLE_SHEET_URL;
    if (!url) return console.warn("⚠️ Google Sheets routing URL environment variable missing.");
    
    let safeEducation = education ? education.trim() : "";
    if (safeEducation.startsWith('+') || safeEducation.startsWith('=')) {
      safeEducation = `'${safeEducation}`; 
    }
    
    const targetChannel = channel || "WhatsApp";
    
    await axios.post(url, {
      type: "lead",
      channel: targetChannel, 
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

// Helper: Send WhatsApp message
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

// Helper: Send Instagram Message
async function sendInstagram(to, text) {
  try {
    const token = process.env.INSTAGRAM_TOKEN;
    await axios.post(
      `https://graph.facebook.com/v21.0/17841433022247772/messages?access_token=${token}`, 
      {
        recipient: { id: to },
        message: { text: text }
      }
    );
    console.log(`📸 Outbound Instagram ping delivered to ${to}`);
  } catch (err) {
    console.error("❌ Instagram dispatch failed:", err.response?.data || err.message);
  }
}

// Helper: Fetch live job vacancy data from Google Doc
async function fetchJobVacancies() {
  try {
    const docId = process.env.VACANCY_DOC_ID;
    if (!docId) {
      console.warn("⚠️ VACANCY_DOC_ID not set. Using system prompt only.");
      return null;
    }
    const response = await axios.get(
      `https://docs.google.com/document/d/${docId}/export?format=txt`
    );
    console.log("📄 Vacancy doc fetched successfully.");
    return response.data;
  } catch (err) {
    console.warn("⚠️ Failed to fetch vacancy doc:", err.message);
    return null;
  }
}

// Meta webhook verification
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && (token === 'jobbot123' || token === 'jabbot123')) {
      console.log('🚀 WEBHOOK LOCK: Handshake matches successfully!');
      res.set('Content-Type', 'text/plain');
      return res.status(200).send(challenge);
    } else {
      console.warn('⚠️ Webhook handshake rejected: Token mismatch.');
      return res.sendStatus(403);
    }
  }
});

// Centralized Inbound Webhook Endpoint
app.post('/webhook', async (req, res) => {
  const body = req.body;
  console.log("📨 INCOMING WEBHOOK OBJECT TYPE:", body.object);
  console.log("📨 FULL PAYLOAD:", JSON.stringify(body, null, 2));
  
  // 1. Send the response IMMEDIATELY right here to prevent timeouts
  res.sendStatus(200);

  try {
    const entry = body?.entry?.[0];
    if (!entry) return; 

// 1. Process Instagram Payload Safely
    if (body.object === 'instagram') {
      let from = null;
      let userMessage = null;

      if (entry.messaging && entry.messaging[0]) {
        const messagingEvent = entry.messaging[0];
        
        // Check both message blocks safely
        const embeddedMessage = messagingEvent.message || messagingEvent.message_edit;
        
        if (!embeddedMessage) {
          console.log("⏭️ Skipping non-message Instagram event");
          return;
        }

        from = messagingEvent.sender?.id;
        // Accept EITHER standard text or an edited text string
        userMessage = embeddedMessage.text; 
      } 
      else if (entry.changes && entry.changes[0]?.value) {
        const value = entry.changes[0].value;
        if (value.messages && value.messages[0]) {
          from = value.messages[0].from?.id || value.messages[0].sender?.id;
          userMessage = value.messages[0].text;
        }
      }

      // Final logging check
      if (from) {
        console.log(`📩 Raw Event captured from ${from}. Text found: "${userMessage || 'UNDEFINED/NULL'}"`);
        if (userMessage) {
          await handleApplicationBot(req, res, from, "Instagram", userMessage);
        }
      }
      return; 
    }

    // 2. Process WhatsApp Payload
    if (body.object === 'whatsapp_business_account') {
      if (entry.changes && entry.changes[0].value.messages) {
        const message = entry.changes[0].value.messages[0];
        const from = message.from;
        if (message.type === 'text') {
          const userMessage = message.text.body;
          await handleApplicationBot(req, res, from, "WhatsApp", userMessage);
        }
      }
      return; // ✅ FIXED: Standard clean functional exit
    }

    // 3. Process Messenger Payload
    if (body.object === 'page') {
      if (entry.messaging && entry.messaging[0]) {
        const messagingEvent = entry.messaging[0];
        const senderId = messagingEvent.sender?.id;
        if (messagingEvent.message && messagingEvent.message.text) {
          const userMessage = messagingEvent.message.text;
          await handleApplicationBot(req, res, senderId, "Messenger", userMessage);
        }
      }
      return; // ✅ FIXED: Standard clean functional exit
    }

  } catch (error) {
    console.error("💥 General Webhook Payload Routing Crash:", error.message);
  }
});

// Centralized Core Processing Core Engine
async function handleApplicationBot(req, res, from, channel, userMessage) {
  try {
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
      currentState.vacancyCache = null; 
    }
    currentState.lastInteraction = now;

    // Kill keywords
    const exitKeywords = ["don't want to apply", "cancel", "stop", "i don't want to apply anymore", "thank you no", "bhayo pardaina"];
    if (exitKeywords.some(keyword => lowerMessage.includes(keyword))) {
      currentState.stage = 0;
      currentState.status = "Closed";
      const exitMsg = "Understood. I have canceled your application setup. Let me know if you need anything else!";
      await logToMonitor(from, channel, "Bot", exitMsg);
      
      if (channel === "Messenger") await sendMessenger(from, exitMsg);
      else if (channel === "Instagram") await sendInstagram(from, exitMsg);
      else await sendWhatsApp(from, exitMsg);
      
      return; // ✅ FIXED: Avoid sending duplicate HTTP status
    }

    // Closed session protector
    if (currentState.status === "Closed") {
      console.log(`User ${from} opted out. Ignoring message.`);
      return; // ✅ FIXED: Avoid sending duplicate HTTP status
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
      
      // ✅ FIXED: Passed vacancy and default context parameters to ensure askGroq doesn't crash
      const result = await askGroq(classificationPrompt, "", "You are a single word classification script.");
      const stage1Class = result.replyText.trim().toUpperCase().split(/\s+/)[0];
      responseTimeMs += result.responseTimeMs;

      if (stage1Class === "CANCEL") {
        currentState.stage = 0;
        currentState.status = "Closed";
        botResponseText = "No problem at all! I have stopped the application process. Feel free to reach out whenever you're ready.";
      } else if (stage1Class === "QUESTION") {
        const answerResult = await askGroq(`You are an HR assistant. A job applicant asked this during the application process: "${userMessage}". Answer helpfully, then remind them to please provide their full name to continue.`, currentState.vacancyCache);
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
        const classResult = await askGroq(classificationPrompt, "", "You are an automated categorization filter.");
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
          const answerPrompt = `You are an HR assistant. A job applicant asked this question about their qualification during an application: "${userMessage}". Answer their concern helpfully and honestly based on the job details you know. At the end of your answer, remind them to please provide their highest educational qualification to continue their application...`;
          const answerResult = await askGroq(answerPrompt, currentState.vacancyCache);
          botResponseText = answerResult.replyText;
        } catch (error) {
          botResponseText = "I received your question. Could you please state your highest qualification directly so we can finish logging your profile details?";
        }
      } else {
        console.log(`🎯 Funnel complete for: ${from}. Running optimized Groq evaluation pipeline...`);

        try {
          const formattedTranscript = currentState.history
            .map(msg => `${msg.role === "user" ? "Candidate" : "Bot"}: ${msg.text}`)
            .join("\n");

          const combinedEvaluationPrompt = "EVALUATION TASK INSTRUCTIONS:\n" +
          "You are an internal HR data assistant. Analyze the conversation transcript below against the specific job qualification rules provided.\n\n" +
          "CRITICAL PRIORITY SCORING PARAMETERS (RETRIEVED FROM KNOWLEDGE BASE):\n" + (process.env.JOB_CRITERIA || "Standard business criteria evaluation") + "\n\n" +
          "Expected JSON format output:\n" +
          "{\n" +
          "  \"education\": \"1-3 words extraction of highest degree (e.g. BBA Finance, +2 Pass)\",\n" +
          "  \"priority\": \"HIGH, MEDIUM, or LOW based on the retrieved scoring parameters above\",\n" +
          "  \"summary\": \"Your concise 2-sentence professional applicant summary.\"\n" +
          "}\n\n" +
          "TRANSCRIPT TO EVALUATE:\n" + formattedTranscript;

          const evaluationResult = await askGroq(combinedEvaluationPrompt, "", "You are a structured data analysis bot that outputs raw JSON only.");
          responseTimeMs += evaluationResult.responseTimeMs;
          
          let parsedData;
          try {
            let cleanJsonText = evaluationResult.replyText.replace(/```json|```/g, "").trim();
            const jsonMatch = cleanJsonText.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
              cleanJsonText = jsonMatch[0];
            }
            parsedData = JSON.parse(cleanJsonText);
          } catch (jsonErr) {
            console.warn("⚠️ JSON fallback running case-matching...");
            const upperReply = evaluationResult.replyText.toUpperCase();
            parsedData = {
              education: userMessage.trim().substring(0, 30),
              priority: upperReply.includes("LOW") ? "LOW" : upperReply.includes("HIGH") ? "HIGH" : "MEDIUM",
              summary: evaluationResult.replyText.substring(0, 150)
            };
          }

          currentState.education = parsedData.education || userMessage.trim();
          let detectedPriority = parsedData.priority ? parsedData.priority.toUpperCase() : "MEDIUM";
          let finalSummary = parsedData.summary || "Profile evaluation logging complete.";

          console.log(`✨ Groq Priority Calculated: [${detectedPriority}] | Degree: [${currentState.education}]`);

          await sendToGoogleSheets(from, currentState.name, currentState.education, finalSummary, detectedPriority, channel);
          
          botResponseText = "Thank you so much! Your application profile details have been securely logged into our system. Our HR team will reach out within 24 hours. Have a wonderful day!";
          currentState.stage = 0; 

        } catch (error) {
          console.error("🚨 Processing crash fallback activated:", error.message);
          let fallbackEducation = userMessage.length > 25 ? "Profile Registered" : userMessage.trim();
          await sendToGoogleSheets(from, currentState.name, fallbackEducation, "Logged via system backup safety protocol.", "MEDIUM", channel);

          botResponseText = "Thank you! Your details have been successfully received and submitted to our hiring pipeline. Our HR team will get in touch with you shortly.";
          currentState.stage = 0;
        }
      }

    // ==========================================
    // STAGE 0: Normal Chat & Intercept Trigger
    // ==========================================
    } else {
      if (!currentState.vacancyCache) {
        currentState.vacancyCache = await fetchJobVacancies();
      }
      // ✅ FIXED: Correctly matching the two parameters expected by the updated askGroq handler
      const result = await askGroq(userMessage, currentState.vacancyCache);
      botResponseText = result.replyText;
      responseTimeMs = result.responseTimeMs;
    }

    // ==========================================
    // CENTRALIZED OUTPUT CLEANER & INTERCEPTOR
    // ==========================================
    
    if (botResponseText.includes("[START_APPLICATION]")) {
      botResponseText = botResponseText.replace("[START_APPLICATION]", "").trim();
      
      if (currentState.stage === 0) {
        console.log(`Smart intercept: Shifting ${from} to Stage 1 (Name Collection)`);
        currentState.stage = 1;
        botResponseText = "Great! Let's get your application registered. To start, what is your full name?";
      }
    }

    if (botResponseText.includes("[CLOSE_CONVERSATION]")) {
      console.log(`Close intercept triggered for ${from}`);
      botResponseText = botResponseText.replace("[CLOSE_CONVERSATION]", "").trim();
      currentState.stage = 0;
      currentState.status = "Closed";
    }

    botResponseText = botResponseText.replace(/\n{3,}/g, "\n\n").trim();
    currentState.history.push({ role: "model", text: botResponseText });

    await logToMonitor(from, channel, "Bot", botResponseText, responseTimeMs, "200 OK");

    // Route dispatch matching channel origin
    if (channel === "Messenger") {
      await sendMessenger(from, botResponseText);
    } else if (channel === "Instagram") {
      await sendInstagram(from, botResponseText);
    } else {
      await sendWhatsApp(from, botResponseText);
    }

  } catch (err) {
    console.error("💥 General Route Crash Error:", err?.response?.data || err.message);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Groq-powered Application Engine active on port ${PORT}`));
