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


// Helper: Ask Groq Cloud (Llama 3.3 70B) with Gemini Failover
async function askGroq(promptText) {
  try {
    console.log("🚀 Attempting primary processing via Groq Cloud...");
    
    const groqResponse = await groq.chat.completions.create({
      messages: [{ role: "user", content: promptText }],
      model: "llama-3.3-70b-versatile",
      temperature: 0.1,
    });
    
    return {
      replyText: groqResponse.choices[0].message.content,
      responseTimeMs: 0
    };

  } catch (error) {
    // Check if the failure is a Rate Limit or Provider Outage
    const isRateLimit = error.status === 429 || (error.message && error.message.includes("rate_limit"));
    
    if (isRateLimit) {
      console.warn("⚠️ Groq Rate Limit Exceeded! Activating automatic failover to Gemini Backup...");
      
      try {
        const startTime = Date.now();
        
        const geminiResponse = await ai.models.generateContent({
          model: "gemini-1.5-flash",
          contents: promptText,
        });
        
        console.log("✅ Backup evaluation completed successfully via Gemini!");
        return {
          replyText: geminiResponse.text,
          responseTimeMs: Date.now() - startTime
        };
        
      } catch (geminiError) {
        console.error("🚨 Critical Error: Both Groq and Gemini providers failed entirely.", geminiError);
        throw geminiError;
      }
    }
    
    throw error;
  }
}

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
      currentState.vacancyCache = null; // Force vacancy refresh on next message
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
          const answerPrompt = `You are an HR assistant. A job applicant asked this question about their qualification during an application: "${userMessage}". Answer their concern helpfully and honestly based on the job details you know. At the end of your answer, remind them to please provide their highest educational qualification to continue their application...`;
          const answerResult = await askGroq(answerPrompt);
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

         // Ensure your RAG engine has fetched the vacancy details from your Google Doc knowledge base first
// (e.g., const retrievedJobCriteria = await fetchDocContext(jobId);)

const combinedEvaluationPrompt = "EVALUATION TASK INSTRUCTIONS:\n" +
"You are an internal HR data assistant. Analyze the conversation transcript below against the specific job qualification rules provided.\n\n" +
"CRITICAL PRIORITY SCORING PARAMETERS (RETRIEVED FROM KNOWLEDGE BASE):\n" + retrievedJobCriteria + "\n\n" +
"Expected JSON format output:\n" +
"{\n" +
"  \"education\": \"1-3 words extraction of highest degree (e.g. BBA Finance, +2 Pass)\",\n" +
"  \"priority\": \"HIGH, MEDIUM, or LOW based on the retrieved scoring parameters above\",\n" +
"  \"summary\": \"Your concise 2-sentence professional applicant summary.\"\n" +
"}\n\n" +
"TRANSCRIPT TO EVALUATE:\n" + formattedTranscript;

          const evaluationResult = await askGroq(combinedEvaluationPrompt);
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

          // Deliver clean mapped entries straight down the pipeline to Google Sheets
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
  // Fetch live vacancies if not already cached for this session
  if (!currentState.vacancyCache) {
    currentState.vacancyCache = await fetchJobVacancies();
  }
  const result = await askGroq(userMessage, currentState.vacancyCache);
      botResponseText = result.replyText;
      responseTimeMs = result.responseTimeMs;
    }

    // ==========================================
    // CENTRALIZED OUTPUT CLEANER & INTERCEPTOR
    // ==========================================
    
    // 1. Check for application triggers anywhere in the pipeline response
    if (botResponseText.includes("[START_APPLICATION]")) {
      botResponseText = botResponseText.replace("[START_APPLICATION]", "").trim();
      
      if (currentState.stage === 0) {
        console.log(`Smart intercept: Shifting ${from} to Stage 1 (Name Collection)`);
        currentState.stage = 1;
        botResponseText = "Great! Let's get your application registered. To start, what is your full name?";
      }
    }

    // 2. Clear out closing flags cleanly
    if (botResponseText.includes("[CLOSE_CONVERSATION]")) {
      console.log(`Close intercept triggered for ${from}`);
      botResponseText = botResponseText.replace("[CLOSE_CONVERSATION]", "").trim();
      currentState.stage = 0;
      currentState.status = "Closed";
    }

    // 3. Clean up generic markdown artifacts or awkward double spacing
    botResponseText = botResponseText.replace(/\n{3,}/g, "\n\n").trim();

    // Commit to conversation history logs
    currentState.history.push({ role: "model", text: botResponseText });

    // Log complete response down to monitoring sheets tracking
    await logToMonitor(from, channel, "Bot", botResponseText, responseTimeMs, "200 OK");

    // Dispatch clear message payload to user's device
    if (channel === "Messenger") {
      await sendMessenger(from, botResponseText);
    } else {
      await sendWhatsApp(from, botResponseText);
    }
    
    return res.sendStatus(200);

  } catch (err) {
    console.error("💥 General Route Crash Error:", err?.response?.data || err.message);
    if (!res.headersSent) {
      res.sendStatus(500);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Groq-powered Application Engine active on port ${PORT}`));
