const express = require('express');
const axios = require('axios');
const app = express();
app.use(express.json());

const VERIFY_TOKEN = "jobbot123";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const SYSTEM_PROMPT = process.env.SYSTEM_PROMPT;

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

    const userMessage = message.text.body;
    const from = message.from;

    // Send to Gemini
const geminiRes = await axios.post(
`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`  {
    contents: [{ role: "user", parts: [{ text: userMessage }] }],
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] }
  }
);

const reply = geminiRes.data.candidates[0].content.parts[0].text;

    // Send reply via WhatsApp
    await axios.post(
      `https://graph.facebook.com/v19.0/${PHONE_NUMBER_ID}/messages`,
      {
        messaging_product: "whatsapp",
        to: from,
        type: "text",
        text: { body: reply }
      },
      {
        headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` }
      }
    );

    res.sendStatus(200);
  } catch (err) {
    console.error(err?.response?.data || err.message);
    res.sendStatus(500);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Bot running on port ${PORT}`));
