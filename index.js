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

// ===== načítanie FAQ (doprava/platba...) =====
// voliteľné: ak súbor nemáš, kód pôjde ďalej
const faqPath = path.join(process.cwd(), "faq.json");
let FAQ = null;
try {
FAQ = JSON.parse(fs.readFileSync(faqPath, "utf8"));
} catch (e) {
FAQ = null;
}

// ===== jednoduchá session pamäť (aby sa to necyklilo) =====
const sessionStore = new Map(); // sessionId -> { askedOnce: boolean, lastIntent: string, lastGoal: string, preferredFormat: string }

function getSession(sessionId) {
if (!sessionStore.has(sessionId)) {
sessionStore.set(sessionId, {
askedOnce: false,
lastIntent: "",
lastGoal: "",
preferredFormat: "", // "zrnkova" | "mleta" | "instant" | "bez_kofeinu"
});
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

function safeTitle(p) {
// oprava "undefined": vezmi title alebo name, inak aspoň id
return (p?.title || p?.name || p?.id || "Produkt").toString();
}

function safeUrl(p) {
return (p?.url || "").toString();
}

function detectPreferredFormat(message) {
const t = normalize(message);

// formy
if (t.includes("zrnk")) return "zrnkova";
if (t.includes("mleta") || t.includes("mlet")) return "mleta";
if (t.includes("instant") || t.includes("instan")) return "instant";

// preferencia bez kofeínu
if (t.includes("bez kofe") || t.includes("decaf")) return "bez_kofeinu";

// nič jasné
return "";
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

const orderHelp = [
"doprava", "dorucenie", "doručenie", "platba", "reklamacia", "reklamácia",
"objednavka", "objednávka", "faktura", "faktúra", "vratenie", "vrátenie",
"stav objednavky", "tracking", "balik", "dobierka", "zadarmo", "free shipping"
];
if (hasAny(t, orderHelp)) return "order_help";

// product_search
const productSignals = [
"hladam", "hľadám", "chcem", "mate", "máte", "odporuc", "odporúč",
"instant", "mleta", "mletá", "zrnk", "bez kofeinu", "decaf", "kava", "káva"
];
if (hasAny(t, productSignals) && hasAny(t, ["kava", "káva", "cbd", "protein", "proteín", "matcha", "kakao", "cokolada", "čokoláda", "kapsul", "kapsule"])) {
return "product_search";
}

const goal = extractGoal(message);
if (goal) return "benefit_goal";

return "general";
}

// ===== FAQ odpovede (doprava/platba...) =====
function tryFaqAnswer(message) {
const t = normalize(message);
if (!FAQ) return "";

// minimálne polia, ktoré odporúčam mať v faq.json:
// {
// "store": { "free_shipping_threshold": 49, "currency": "EUR", "cash_on_delivery_fee": 1.5, "shipping_info_url": "https://anilab.sk/doprava-a-platba/" }
// }
const store = FAQ.store || {};
const currency = store.currency || "EUR";
const free = store.free_shipping_threshold;
const cod = store.cash_on_delivery_fee;
const url = store.shipping_info_url || "https://anilab.sk";

const wantsFree = hasAny(t, ["doprava zdarma", "zadarmo doprava", "od akej sumy", "nad aku sumu", "nad akú sumu", "free shipping", "doprava zadarmo"]);
const wantsCod = hasAny(t, ["dobierka", "na dobierku", "cod", "cash on delivery"]);
const wantsShipping = hasAny(t, ["doprava", "dorucenie", "doručenie", "cena dopravy", "koľko stojí doprava"]);

if (wantsFree && typeof free !== "undefined") {
return `Doprava zdarma je pri nákupe od ${free} ${currency}.`;
}
if (wantsCod && typeof cod !== "undefined") {
return `Dobierka stojí ${cod} ${currency}.`;
}
if (wantsShipping) {
return `Možnosti dopravy a aktuálne ceny nájdeš tu: ${url}`;
}

return "";
}

function scoreProduct(product, message, goal, preferredFormat) {
const t = normalize(message);
let s = 0;

const formats = product.formats || [];
const prodGoals = product.goals || [];
const kws = product.keywords || [];

// goal match
if (goal && prodGoals.includes(goal)) s += 10;

// keyword match
for (const k of kws) {
if (normalize(k) && t.includes(normalize(k))) s += 2;
}

// ===== FORMÁT: toto je kľúč, aby zrnková nezobrazila mletú =====
// keď user explicitne povie formu, dáme tomu VEĽKÚ váhu
if (preferredFormat) {
if (preferredFormat === "bez_kofeinu") {
if (product.caffeine === "no") s += 15;
if (product.caffeine === "yes") s -= 6;
} else {
const hasFormat = formats.includes(preferredFormat);
if (hasFormat) s += 25; // extrémne zvýhodni správny formát
else s -= 12; // penalizuj nesprávny formát
}
} else {
// pôvodné ľahké matchovanie keď ešte nepoznáme formu
if (t.includes("instant") && formats.includes("instant")) s += 4;
if ((t.includes("mleta") || t.includes("mlet")) && formats.includes("mleta")) s += 3;
if (t.includes("zrnk") && formats.includes("zrnkova")) s += 3;

if (t.includes("bez kofe") || t.includes("decaf")) {
if (product.caffeine === "no") s += 3;
if (product.caffeine === "yes") s -= 2;
}
}

// best seller boost
if (product.bestSeller) s += 2;

return s;
}

function pickTopProducts(message, goal, preferredFormat, limit = 2) {
const scored = PRODUCTS
.filter((p) => safeUrl(p)) // musí mať link
.map((p) => ({ p, s: scoreProduct(p, message, goal, preferredFormat) }))
.sort((a, b) => b.s - a.s);

// ak máme preferovaný formát, a TOP1 je iný formát, zober najvyšší s daným formátom
if (preferredFormat && preferredFormat !== "bez_kofeinu") {
const withFormat = scored.filter((x) => (x.p.formats || []).includes(preferredFormat));
if (withFormat.length) return withFormat.slice(0, limit).map((x) => x.p);
}

const top = scored.filter((x) => x.s > 0).slice(0, limit).map((x) => x.p);
if (top.length) return top;

const fallback = PRODUCTS.filter((p) => p.bestSeller && safeUrl(p)).slice(0, limit);
if (fallback.length) return fallback;

return PRODUCTS.filter((p) => safeUrl(p)).slice(0, limit);
}

function formatReply({ intro, products, ask, closing }) {
let out = "";
if (intro) out += `${intro}\n\n`;

if (products && products.length) {
out += `Odporúčam:\n`;
for (const p of products) {
out += `👉 ${safeTitle(p)}\n${safeUrl(p)}\n`;
if (p.oneLiner) out += `${p.oneLiner}\n`;
out += `\n`;
}
}

if (ask) out += `${ask}\n\n`;
if (closing) out += `${closing}`.trim();

return out.trim();
}

// ===== OpenAI fallback =====
async function askOpenAI({ message }) {
if (!OPENAI_API_KEY) return "";

const system = `
Si Claudia – poradkyňa e-shopu ANiLab. Píš prirodzene po slovensky, krátko, konkrétne a v ŽENSKOM rode.
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

// ulož preferovaný formát, ak user niečo jasné napísal
const pf = detectPreferredFormat(msg);
if (pf) session.preferredFormat = pf;

const goal = extractGoal(msg);
const intent = detectIntent(msg);

session.lastIntent = intent;
if (goal) session.lastGoal = goal;

// 0) ORDER FAQ odpovede (doprava/dobierka/zadarmo) - hneď a presne
const faqReply = tryFaqAnswer(msg);
if (faqReply) {
return res.json({ reply: `Jasné 🙂 ${faqReply}` });
}

// 1) PRODUCT_SEARCH: vždy odporuč hneď, bez dotazníka
if (intent === "product_search") {
const prods = pickTopProducts(msg, goal, session.preferredFormat, 2);

const ask = (() => {
// len jemná otázka, ale odporúčanie už má
if (!hasAny(msg, ["instant", "mleta", "mletá", "zrnk", "bez kofe", "decaf"])) {
return "Chceš to skôr instant / mletú / zrnkovú – alebo bez kofeínu?";
}
// keď už napísal zrnkovú/mletú, nepýtaj sa znova, radšej spýtaj cieľ
if (!goal) {
return "A ide ti viac o energiu, spánok, stres, focus alebo imunitu? (stačí 1 slovo)";
}
return "";
})();

const reply = formatReply({
intro: "Rozumiem 🙂 Vybrala som ti najbližšie tipy podľa toho, čo píšeš:",
products: prods,
ask,
closing: "Ak mi napíšeš cieľ (energia/spánok/stres/focus/imunita), doladím to na 100%."
});

return res.json({ reply });
}

// 2) BENEFIT_GOAL: odporuč hneď + 1 otázka max
if (intent === "benefit_goal") {
const g = goal || session.lastGoal || "";
const prods = pickTopProducts(msg, g, session.preferredFormat, 2);

let ask = "";
if (!session.askedOnce) {
// ak rieši kávu, nech upresní formu; inak nech povie formu produktu
ask = hasAny(msg, ["kava", "káva"])
? "Chceš to skôr instant, mletú alebo zrnkovú? (stačí jedno slovo)"
: "Chceš to skôr kávu, čaj alebo kapsule? (stačí jedno slovo)";
session.askedOnce = true;
}

const reply = formatReply({
intro: "Jasné 🙂 Tu sú 2 rýchle odporúčania na tvoj cieľ:",
products: prods,
ask,
closing: "Keď mi potvrdíš formu, vyberiem ti najpresnejší TOP produkt."
});

return res.json({ reply });
}

// 3) ORDER_HELP: skús OpenAI, ale stručne
if (intent === "order_help") {
const ai = await askOpenAI({ message: msg });
if (ai) return res.json({ reply: ai });
return res.json({ reply: "Napíš prosím, či riešiš dopravu, platbu alebo stav objednávky – a hneď ti poviem čo spraviť." });
}

// 4) GENERAL: aj tu odporuč aspoň bestseller + jedna otázka
const prods = pickTopProducts(msg, goal, session.preferredFormat, 1);

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




    
  
  

   
      
        
    
