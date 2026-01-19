import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json());

// CORS – povol tvoj web
app.use(
  cors({
    origin: ["https://anilab.sk", "https://www.anilab.sk"],
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type"]
  })
);

// --- Load products.json ---
const PRODUCTS_PATH = path.join(process.cwd(), "products.json");
let PRODUCTS = [];
try {
  PRODUCTS = JSON.parse(fs.readFileSync(PRODUCTS_PATH, "utf-8"));
  console.log(`Loaded products: ${PRODUCTS.length}`);
} catch (e) {
  console.error("Cannot load products.json", e);
}

// --- helper: simple keyword scoring ---
function normalize(s) {
  return (s || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pickProducts(userMessage, limit = 3) {
  const msg = normalize(userMessage);
  const tokens = msg.split(" ").filter(Boolean);

  const scored = PRODUCTS.map((p) => {
    const tags = (p.tags || []).map(normalize);
    const name = normalize(p.name);
    let score = 0;

    for (const t of tokens) {
      if (t.length < 3) continue;
      if (name.includes(t)) score += 3;
      if (tags.some((x) => x.includes(t))) score += 5;
    }

    // extra intent boosts
    if (msg.includes("stres") || msg.includes("spán") || msg.includes("relax")) {
      if (tags.some((x) => x.includes("stres") || x.includes("spánok") || x.includes("relax"))) score += 8;
    }
    if (msg.includes("imunit")) {
      if (tags.some((x) => x.includes("imunita"))) score += 8;
    }
    if (msg.includes("focus") || msg.includes("sústred") || msg.includes("mozog") || msg.includes("pamäť")) {
      if (tags.some((x) => x.includes("focus") || x.includes("sústredenie") || x.includes("mozog") || x.includes("pamäť"))) score += 8;
    }
    if (msg.includes("keto") || msg.includes("mct") || msg.includes("low carb") || msg.includes("lowcarb")) {
      if (tags.some((x) => x.includes("keto") || x.includes("mct") || x.includes("lowcarb"))) score += 8;
    }
    if (msg.includes("proteín") || msg.includes("protein") || msg.includes("tréning") || msg.includes("gym")) {
      if (tags.some((x) => x.includes("proteín") || x.includes("fitness") || x.includes("gym"))) score += 8;
    }

    return { p, score };
  })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.p);

  return scored;
}

function isB2BLead(msg) {
  const m = normalize(msg);
  const b2bWords = [
    "veľkoobchod",
    "b2b",
    "distribúcia",
    "odber",
    "odberateľ",
    "cenník",
    "moq",
    "paleta",
    "retail",
    "reťazec",
    "private label",
    "privátna značka",
    "výroba",
    "továr",
    "vzorky",
    "ponuka"
  ];
  return b2bWords.some((w) => m.includes(normalize(w)));
}

// --- MAIN CHAT ENDPOINT ---
app.post("/chat", async (req, res) => {
  try {
    const message = req.body?.message || "";
    const picks = pickProducts(message, 3);
    const b2b = isB2BLead(message);

    // Default reply (teraz bez OpenAI – rýchle a stabilné odporúčania)
    // Ak chceš, o krok neskôr to prepojíme s OpenAI, ale už s produktami v kontexte.
    let replyParts = [];

    // 1) short helpful answer
    replyParts.push("Rozumiem 👇");

    // 2) product recommendations with links
    if (picks.length) {
      replyParts.push("Odporúčam tieto konkrétne produkty:");
      for (const p of picks) {
        replyParts.push(`• ${p.name} – ${p.pitch}\n  👉 ${p.url}`);
      }
    } else {
      replyParts.push("Napíš prosím, či riešiš skôr: stres/spánok, energiu, focus/mozog, imunitu, keto alebo proteín – a odporučím presný produkt s linkom.");
    }

    // 3) B2B capture
    if (b2b) {
      replyParts.push(
        "\nVyzerá to ako B2B dopyt. Napíš prosím: krajinu + približný objem (ks / mesačne) + či ide o privátnu značku alebo hotové produkty. Pošlem ti ďalší postup."
      );
    }

    return res.json({ reply: replyParts.join("\n") });
  } catch (e) {
    console.error(e);
    return res.json({ reply: "Technická chyba. Skús prosím o chvíľu." });
  }
});

app.get("/", (req, res) => res.send("OK"));

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
