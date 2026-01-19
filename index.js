import express from "express";
import cors from "cors";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 3000;

/**
 * MIDDLEWARE
 */
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));
app.use(express.json());

/**
 * HEALTH CHECK
 */
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

/**
 * CHAT ENDPOINT
 */
app.post("/chat", async (req, res) => {
  try {
    const userMessage = req.body.message;

    if (!userMessage || typeof userMessage !== "string") {
      return res.status(400).json({
        reply: "Chýba správa od používateľa."
      });
    }

    const response = await fetch(
      "https://api.openai.com/v1/chat/completions",
      {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "gpt-4.1-mini",
          messages: [
            {
              role: "system",
              content:
                "Si chatbot pre e-shop s funkčnou výživou. Pomáhaš zákazníkom s výberom produktov, odpovedáš na otázky o zložení, benefitoch, dávkovaní a dostupnosti. Neposkytuj lekárske diagnózy. Ak zákazník spomenie veľkoobchod, distribúciu alebo private label, reaguj profesionálne a požiadaj o kontakt."
            },
            {
              role: "user",
              content: userMessage
            }
          ],
          temperature: 0.4
        })
      }
    );

    const data = await response.json();
    console.log("OPENAI RESPONSE:", data);

    if (!data.choices || !data.choices[0]) {
      return res.json({
        reply: "AI odpoveď sa nepodarilo získať."
      });
    }

    return res.json({
      reply: data.choices[0].message.content
    });

  } catch (error) {
    console.error("CHAT ERROR:", error);
    return res.status(500).json({
      reply: "Chyba servera. Skús to prosím neskôr."
    });
  }
});

/**
 * START SERVER
 */
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
