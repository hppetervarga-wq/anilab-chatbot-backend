import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CORS (ponechaj svoje domény) =====
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

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";

// ===== načítanie TOP produktov =====
const productsPath = path.join(process.cwd(), "products.json");
let PRODUCTS = [];
try {
  PRODUCTS = JSON.parse(fs.readFileSync(productsPath, "utf8"));
} catch (e) {
  console.error("Cannot read products.json:", e);
  PRODUCTS = [];
}

// ===== jednoduchá session pamäť (aby sa to necyklilo) =====
const sessionStore = new Map(); // sessionId -> { askedOnce: boolean, lastIntent: string, lastGoal: string }

function getSession(sessionId) {
  if (!sessionStore.has(sessionId)) {
    sessionStore.set(sessionId, { askedOnce: false, lastIntent: "", lastGoal: "" });
  }
  return sessionStore.get(sessionId);
}

// ===== util =====
const normalize = (s) =>
  (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "");

function hasAny(text, arr) {
  const t = normalize(text);
  return arr.some((w) => t.includes(normalize(w)));
}

function extractGoal(message) {
  const t = normalize(message);

  const goals = [
    { key: "sleep", kws: ["spanok", "spánok", "nespavost", "insomnia", "zaspavat", "zaspávat", "relax", "ukludnit", "ukľudniť"] },
    { key: "stress", kws: ["stres", "anx", "uzkost", "úzkosť", "napatie", "napätie", "nervy"] },
    { key: "energy", kws: ["energia", "energiu", "unava", "únava", "nakopnut", "nakopnúť", "motivacia", "motivácia"] },
    { key: "focus", kws: ["focus", "sustredenie", "sústredenie", "pozornost", "pozornosť", "mozog", "pamät", "pamat"] },
    { key: "immunity", kws: ["imunita", "nachladnutie", "prechladnutie", "choroba", "odporucnost", "odolnost", "antioxid"] },
    { key: "keto", kws: ["keto", "ketogene", "ketogén", "low carb", "lowcarb"] },
    { key: "protein", kws: ["protein", "proteín", "srvátka", "whey", "kazein", "kazeín", "gainer"] },
    { key: "testosterone", kws: ["testosteron", "testosterón", "libido", "vykon", "výkon"] },
    { key: "cbd", kws: ["cbd", "konopi", "konope", "hemp", "full spectrum"] },
  ];

  for (const g of goals) {
    if (g.kws.some((k) => t.includes(normalize(k)))) return g.key;
  }
  return "";
}

function detectIntent(message) {
  const t = normalize(message);

  const orderHelp = ["doprava", "dorucenie", "doručenie", "platba", "reklamacia", "reklamácia", "objednavka", "objednávka", "faktura", "faktúra", "vratenie", "vrátenie", "stav objednavky", "tracking", "balik"];
  if (hasAny(t, orderHelp)) return "order_help";

  // product_search: keď hľadá typ/konkrétny produkt
  const productSignals = [
    "hladam", "hľadám", "chcem", "mate", "máte", "odporuc", "odporúč",
    "instant", "mleta", "mletá", "zrnk", "bez kofeinu", "decaf", "kava", "káva",
    "reishi", "lion", "cordy", "chaga", "ashwa", "matcha", "kakao", "cokolada", "čokoláda",
    "najpredavanejsia", "najpredávanejšia", "best seller", "top"
  ];
  if (hasAny(t, productSignals) && hasAny(t, ["kava", "káva", "cbd", "protein", "proteín", "matcha", "kakao", "cokolada", "čokoláda"])) {
    return "product_search";
  }

  // benefit_goal: keď rieši cieľ
  const goal = extractGoal(message);
  if (goal) return "benefit_goal";

  return "general";
}

function scoreProduct(product, message, goal) {
  const t = normalize(message);
  let s = 0;

  // goal match
  if (goal && (product.goals || []).includes(goal)) s += 8;

  // keyword match
  const kws = product.keywords || [];
  for (const k of kws) {
    if (normalize(k) && t.includes(normalize(k))) s += 2;
  }

  // format match
  if (t.includes("instant") && (product.formats || []).includes("instant")) s += 4;
  if (t.includes("mleta") || t.includes("mlet") ) {
    if ((product.formats || []).includes("mleta")) s += 3;
  }
  if (t.includes("zrnk") && (product.formats || []).includes("zrnkova")) s += 3;

  // caffeine preference
  if (t.includes("bez kofe") || t.includes("decaf")) {
    if (product.caffeine === "no") s += 3;
    if (product.caffeine === "yes") s -= 2;
  }

  // best seller boost
  if (product.bestSeller) s += 2;

  return s;
}

function pickTopProducts(message, goal, limit = 2) {
  const scored = PRODUCTS
    .map((p) => ({ p, s: scoreProduct(p, message, goal) }))
    .sort((a, b) => b.s - a.s);

  // vždy niečo vráť – aj keď score 0, dáme bestsellery
  const top = scored.filter((x) => x.s > 0).slice(0, limit).map((x) => x.p);
  if (top.length) return top;

  const fallback = PRODUCTS.filter((p) => p.bestSeller).slice(0, limit);
  if (fallback.length) return fallback;

  return PRODUCTS.slice(0, limit);
}

function formatReply({ intro, products, ask, closing }) {
  let out = "";
  if (intro) out += `${intro}\n\n`;

  if (products && products.length) {
    out += `Odporúčam:\n`;
    for (const p of products) {
      out += `👉 ${p.title}\n${p.url}\n`;
      if (p.oneLiner) out += `${p.oneLiner}\n`;
      out += `\n`;
    }
  }

  if (ask) out += `${ask}\n\n`;
  if (closing) out += `${closing}`.trim();

  return out.trim();
}

// ===== OpenAI fallback pre GENERAL & ORDER_HELP (keď nemáme odpoveď v pravidlách) =====
async function askOpenAI({ message }) {
  if (!OPENAI_API_KEY) return "";

  const system = `
Si Claudia – poradkyňa e-shopu ANiLab. Píš prirodzene po slovensky, krátko a vecne.
Cieľ: pomôcť zákazníkovi vybrať produkt a zvýšiť konverziu.
Pravidlá:
- Nehovor, že si AI alebo model.
- Keď odporúčaš produkt, napíš názov + klikateľný link (ak ho máš).
- Nepýtaj sa dookola. Max 1 doplňujúca otázka, potom odporuč.
- Zdravotné tvrdenia formuluj bezpečne: "podpora", "pre pohodu", neuvádzaj liečenie chorôb.
`;

  const payload = {
    model: OPENAI_MODEL,
    temperature: 0.6,
    messages: [
      { role: "system", content: system.trim() },
      { role: "user", content: message },
    ],
  };

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENAI_API_KEY}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) return "";
  const data = await res.json();
  return data?.choices?.[0]?.message?.content?.trim() || "";
}

// ===== ROUTE =====
app.post("/chat", async (req, res) => {
  try {
    const msg = (req.body?.message || "").toString().trim();
    const sessionId = (req.body?.sessionId || req.ip || "anon").toString();

    if (!msg) return res.json({ reply: "Napíš mi prosím, čo hľadáš 🙂" });

    const session = getSession(sessionId);
    const goal = extractGoal(msg);
    const intent = detectIntent(msg);

    session.lastIntent = intent;
    if (goal) session.lastGoal = goal;

    // 1) PRODUCT_SEARCH: vždy odporuč hneď, bez dotazníka
    if (intent === "product_search") {
      const prods = pickTopProducts(msg, goal, 2);

      const ask = (() => {
        // len jemná otázka, ale odporúčanie už má
        if (!hasAny(msg, ["instant", "mleta", "mletá", "zrnk", "bez kofe", "decaf"])) {
          return "Chceš to skôr instant / mletú / zrnkovú – alebo bez kofeínu?";
        }
        return "";
      })();

      const reply = formatReply({
        intro: "Rozumiem 🙂 Vybral som ti najbližšie tipy podľa toho, čo píšeš:",
        products: prods,
        ask,
        closing: "Ak mi napíšeš formu (instant/mletá/zrnková) doladím to na 100%."
      });

      return res.json({ reply });
    }

    // 2) BENEFIT_GOAL: aj tu odporuč hneď + 1 otázka max
    if (intent === "benefit_goal") {
      const g = goal || session.lastGoal || "";
      const prods = pickTopProducts(msg, g, 2);

      // aby sa neopakovalo donekonečna:
      let ask = "";
      if (!session.askedOnce) {
        ask = "Chceš skôr kávu, čaj, alebo kapsule? (Stačí jedno slovo)";
        session.askedOnce = true;
      }

      const reply = formatReply({
        intro: "Jasné 🙂 Tu sú 2 rýchle odporúčania na tvoj cieľ:",
        products: prods,
        ask,
        closing: "Ak mi povieš formu (káva/čaj/kapsule), vyberiem ti najpresnejší TOP produkt."
      });

      return res.json({ reply });
    }

    // 3) ORDER_HELP: skús OpenAI, ale stručne
    if (intent === "order_help") {
      const ai = await askOpenAI({ message: msg });
      if (ai) return res.json({ reply: ai });
      return res.json({ reply: "Napíš prosím, či riešiš dopravu, platbu alebo stav objednávky – a hneď ti poviem čo spraviť." });
    }

    // 4) GENERAL: keď je príliš všeobecné, stále odporuč aspoň bestseller + otázka
    const prods = pickTopProducts(msg, goal, 1);

    // Ak sa už raz pýtal a user stále píše neurčito, necykli – daj ďalší tip
    const follow = session.askedOnce
      ? "Ak chceš, napíš: energia / spánok / stres / focus / imunita – a dám ti najlepší konkrétny match."
      : "Je to skôr energia, spánok, stres, focus alebo imunita? (Stačí 1 slovo)";

    session.askedOnce = true;

    const reply = formatReply({
      intro: "Aby som ti hneď pomohla, toto je najčastejšia voľba zákazníkov:",
      products: prods,
      ask: follow,
      closing: ""
    });

    return res.json({ reply });
  } catch (e) {
    console.error(e);
    return res.json({ reply: "Technická chyba. Skús prosím o chvíľu 🙂" });
  }
});

app.get("/", (req, res) => res.send("OK"));

app.listen(PORT, () => console.log("Server running on", PORT));
