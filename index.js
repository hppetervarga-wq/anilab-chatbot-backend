import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CORS (pridaj sem aj ďalšie domény ak treba) =====
app.use(
  cors({
    origin: [
      "https://anilab.sk",
      "https://www.anilab.sk",
      "http://localhost:3000",
      "http://localhost:5173",
    ],
    methods: ["POST", "GET", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);

// ===== Load products.json =====
const PRODUCTS_PATH = path.join(process.cwd(), "products.json");

let PRODUCTS = [];
function loadProducts() {
  try {
    const raw = fs.readFileSync(PRODUCTS_PATH, "utf-8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) throw new Error("products.json must be an array");
    PRODUCTS = data;
    console.log(`[products] loaded ${PRODUCTS.length} items`);
  } catch (e) {
    console.error("[products] failed to load products.json:", e.message);
    PRODUCTS = [];
  }
}
loadProducts();

// ===== helpers =====
const normalize = (s) =>
  (s || "")
    .toString()
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

const hasAny = (text, arr) => arr.some((k) => text.includes(k));

function findByTags(preferredTags = []) {
  if (!PRODUCTS.length) return null;
  const tags = preferredTags.map(normalize);

  // score products by tag matches
  let best = null;
  let bestScore = -1;

  for (const p of PRODUCTS) {
    const pTags = (p.tags || []).map(normalize);
    let score = 0;
    for (const t of tags) {
      if (pTags.includes(t)) score += 2;
      // soft contains
      if (pTags.some((x) => x.includes(t) || t.includes(x))) score += 1;
    }
    // tie-breaker: if product has "bestseller" tag
    if (pTags.includes("bestseller")) score += 1;

    if (score > bestScore) {
      bestScore = score;
      best = p;
    }
  }

  // ak nič netrafil, vráť prvý
  if (!best || bestScore <= 0) return PRODUCTS[0];
  return best;
}

function formatRecommendation(product, extraText = "") {
  if (!product) {
    return `Technická poznámka: zatiaľ nemám načítané produkty. Skús prosím o chvíľu znova.`;
  }

  const name = product.name || "Odporúčaný produkt";
  const url = product.url || "";
  const pitch = product.pitch ? `\n\n${product.pitch}` : "";
  const extra = extraText ? `\n\n${extraText}` : "";

  return `Odporúčam:\n👉 ${name}\n${url}${pitch}${extra}`;
}

// memory: last intent per visitor (simple in-memory)
const lastIntentBySession = new Map();

// Very simple session id from client (optional). If none, fallback to IP.
function getSessionId(req) {
  const hdr = req.headers["x-session-id"];
  if (hdr && typeof hdr === "string" && hdr.length < 100) return hdr;
  return req.ip || "unknown";
}

// ===== Health check =====
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    productsLoaded: PRODUCTS.length,
    time: new Date().toISOString(),
  });
});

// ===== Main chat endpoint =====
app.post("/chat", (req, res) => {
  const sessionId = getSessionId(req);
  const msgRaw = req.body?.message || "";
  const msg = normalize(msgRaw);

  // 0) Basic guards
  if (!msg.trim()) {
    return res.json({
      reply:
        "Napíš mi prosím, čo riešiš: stres/spánok, energia, focus/mozog, imunita, keto, proteín, testosterón alebo CBD – a dám ti konkrétny produkt s linkom.",
    });
  }

  // 1) Quick “link” request -> use last known intent
  const isJustLink =
    hasAny(msg, ["posli link", "pošli link", "link", "odkaz", "url"]) &&
    msg.length <= 40;

  if (isJustLink) {
    const last = lastIntentBySession.get(sessionId) || "stres_spanok";
    const product = pickProductForIntent(last);
    return res.json({ reply: formatRecommendation(product) });
  }

  // 2) Detect intent
  const intent = detectIntent(msg);

  // store
  if (intent) lastIntentBySession.set(sessionId, intent);

  // 3) If intent unknown -> ask ONE clarifying question (not looping)
  if (!intent) {
    return res.json({
      reply:
        "Rozumiem 🙂 Aby som ti odporučila presne produkt s linkom, vyber prosím jednu možnosť:\n1) stres/spánok\n2) energia\n3) focus/mozog\n4) imunita\n5) keto\n6) proteín\n7) testosterón\n8) CBD",
    });
  }

  // 4) Recommend product for intent
  const product = pickProductForIntent(intent);

  // 5) Add B2B lead trigger (soft)
  const b2bHint = hasAny(msg, [
    "b2b",
    "velkoobchod",
    "veľkoobchod",
    "distrib",
    "retazec",
    "reťazec",
    "gym",
    "shop",
    "eshop",
    "e-shop",
    "private label",
    "privatna znacka",
    "privátna značka",
    "odber",
    "odberat",
    "odberateľ",
    "faktura",
    "faktúra",
    "ico",
    "ičo",
    "dic",
    "dič",
  ]);

  const extra =
    b2bHint
      ? "Ak to riešiš pre firmu (B2B / private label / veľkoobchod), napíš prosím krajinu + približný mesačný odber a pošlem ti ďalší krok."
      : "Ak chceš, napíš či preferuješ mletú / zrnkovú / instant – a dám najpresnejšiu verziu.";

  return res.json({
    reply: formatRecommendation(product, extra),
  });
});

// ===== Intent detection =====
function detectIntent(msg) {
  // stres/spánok
  if (
    hasAny(msg, [
      "spanok",
      "spánok",
      "nespavost",
      "nespavosť",
      "stres",
      "uzkost",
      "úzkosť",
      "relax",
      "ukludnit",
      "upokojit",
      "večer",
      "vecer",
    ])
  )
    return "stres_spanok";

  // energia
  if (
    hasAny(msg, [
      "energia",
      "unava",
      "únava",
      "rano",
      "ráno",
      "nakopnut",
      "nakopnúť",
      "vykon",
      "výkon",
    ])
  )
    return "energia";

  // focus/mozog
  if (
    hasAny(msg, [
      "focus",
      "sustreden",
      "sústreden",
      "mozog",
      "pamät",
      "pamat",
      "koncentr",
      "nootrop",
      "mental",
      "mentál",
    ])
  )
    return "focus_mozog";

  // imunita
  if (
    hasAny(msg, [
      "imunita",
      "nachlad",
      "nachl",
      "choroba",
      "vir",
      "antioxid",
      "obranysch",
    ])
  )
    return "imunita";

  // keto
  if (hasAny(msg, ["keto", "mct", "low carb", "lowcarb"])) return "keto";

  // protein
  if (hasAny(msg, ["protein", "whey", "sval", "svaly", "gym", "fitko"]))
    return "protein";

  // testosteron
  if (
    hasAny(msg, [
      "testoster",
      "libido",
      "muz",
      "muž",
      "vykonnost",
      "výkonnosť",
      "tonga",
      "tongat",
      "tribulus",
    ])
  )
    return "testosteron";

  // cbd
  if (hasAny(msg, ["cbd", "konop", "hemp", "olej", "olejcek", "olejček"]))
    return "cbd";

  return null;
}

// ===== Product picking =====
function pickProductForIntent(intent) {
  switch (intent) {
    case "stres_spanok":
      return findByTags(["stres", "spanok", "relax"]);
    case "energia":
      return findByTags(["energia", "energy", "unava", "ráno", "rano"]);
    case "focus_mozog":
      return findByTags(["focus", "mozog", "pamat", "nootropika", "nootropics"]);
    case "imunita":
      return findByTags(["imunita", "immune"]);
    case "keto":
      return findByTags(["keto", "mct"]);
    case "protein":
      return findByTags(["protein", "whey"]);
    case "testosteron":
      return findByTags(["testosteron", "testosterone", "libido"]);
    case "cbd":
      return findByTags(["cbd", "olej"]);
    default:
      return PRODUCTS[0] || null;
  }
}

// ===== Start server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`anilab chatbot backend running on :${PORT}`);
});
