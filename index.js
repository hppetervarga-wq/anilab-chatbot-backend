import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";

// Node 18+ má fetch natívne. Ak by si mal starší Node, treba doplniť node-fetch.
const app = express();
app.use(express.json({ limit: "1mb" }));

// ===== CORS =====
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

// ===== Load products.json =====
const productsPath = path.join(process.cwd(), "products.json");
let PRODUCTS = [];
try {
PRODUCTS = JSON.parse(fs.readFileSync(productsPath, "utf8"));
} catch (e) {
console.error("Cannot read products.json:", e);
PRODUCTS = [];
}

// ===== Load faq.json (optional) =====
const faqPath = path.join(process.cwd(), "faq.json");
let FAQ = null;
try {
FAQ = JSON.parse(fs.readFileSync(faqPath, "utf8"));
} catch (e) {
FAQ = null;
}

// ===== session memory =====
const sessionStore = new Map();
// sessionId -> { askedOnce:boolean, lastGoal:string, preferredFormat:string, lastCategory:string }

function getSession(sessionId) {
if (!sessionStore.has(sessionId)) {
sessionStore.set(sessionId, {
askedOnce: false,
lastGoal: "",
preferredFormat: "", // "zrnkova" | "mleta" | "instant" | "bez_kofeinu"
lastCategory: "",
});
}
return sessionStore.get(sessionId);
}

// ===== utils =====
const normalize = (s) =>
(s || "")
.toString()
.toLowerCase()
.normalize("NFD")
.replace(/\p{Diacritic}/gu, "");

function hasAny(text, arr) {
const t = normalize(text);
return arr.some((w) => t.includes(normalize(w)));
}

function safeTitle(p) {
return (p?.title || p?.name || p?.id || "Produkt").toString();
}

function safeUrl(p) {
return (p?.url || "").toString();
}

function detectPreferredFormat(message) {
const t = normalize(message);
if (t.includes("zrnk")) return "zrnkova";
if (t.includes("mleta") || t.includes("mlet")) return "mleta";
if (t.includes("instant") || t.includes("instan")) return "instant";
if (t.includes("bez kofe") || t.includes("decaf")) return "bez_kofeinu";
return "";
}

function extractGoal(message) {
const t = normalize(message);

const goals = [
{ key: "sleep", kws: ["spanok", "spánok", "nespavost", "nespavosť", "insomnia", "zaspavat", "zaspávat", "relax", "ukludnit", "ukľudniť", "vecer", "večer"] },
{ key: "stress", kws: ["stres", "anx", "uzkost", "úzkosť", "napatie", "napätie", "nervy", "klud", "kľud"] },
{ key: "energy", kws: ["energia", "energiu", "unava", "únava", "nakopnut", "nakopnúť", "rano", "ráno", "motivacia", "motivácia"] },
{ key: "focus", kws: ["focus", "sustredenie", "sústredenie", "pozornost", "pozornosť", "mozog", "pamät", "pamat", "koncentr"] },
{ key: "immunity", kws: ["imunita", "nachlad", "prechlad", "choroba", "odolnost", "odolnosť", "antioxid"] },
{ key: "keto", kws: ["keto", "ketogene", "ketogén", "low carb", "lowcarb", "mct"] },
{ key: "protein", kws: ["protein", "proteín", "srvátka", "whey", "sval", "svaly", "gym", "fitko"] },
{ key: "testosterone", kws: ["testosteron", "testosterón", "libido", "vykon", "výkon", "tribulus", "tongat"] },
{ key: "cbd", kws: ["cbd", "konopi", "konope", "hemp", "full spectrum", "broad spectrum", "olej", "kvapky"] },
];

for (const g of goals) {
if (g.kws.some((k) => t.includes(normalize(k)))) return g.key;
}
return "";
}

// ===== HARD Router (bez AI) =====
function detectIntent(message) {
const t = normalize(message);

// ORDER_HELP (doprava/platba...) – tvrdé
const orderHelpSignals = [
"doprava", "dorucenie", "doručenie", "shipping",
"postovne", "poštovné",
"platba", "payment", "dobierka", "na dobierku", "cod",
"reklam", "vraten", "vráten", "refund",
"objednavk", "objednávk", "tracking", "balik", "balík",
"zadarmo", "free shipping", "doprava zdarma"
];
if (hasAny(t, orderHelpSignals)) return "order_help";

// PRODUCT/SHOP questions
const productSignals = [
"mate", "máte", "ponuke", "ponúke", "predavate", "predávate",
"hladam", "hľadám", "chcem", "odporuc", "odporúč",
"cbd", "olej", "protein", "proteín", "kava", "káva", "matcha", "caj", "čaj", "kapsul", "kapsule", "cokolad", "čokolád"
];
if (hasAny(t, productSignals)) return "product_search";

const goal = extractGoal(message);
if (goal) return "benefit_goal";

return "general";
}

// ===== FAQ answering (100% deterministic) =====
function tryFaqAnswer(message) {
const t = normalize(message);
if (!FAQ) return "";

const store = FAQ.store || {};
const currency = store.currency || "EUR";
const free = store.free_shipping_threshold;
const cod = store.cash_on_delivery_fee;
const url = store.shipping_info_url || "https://anilab.sk";

const wantsFree = hasAny(t, [
"doprava zdarma", "zadarmo doprava", "od akej sumy", "od akej ceny",
"nad aku sumu", "nad akú sumu", "free shipping", "doprava zadarmo"
]);

const wantsCod = hasAny(t, ["dobierka", "na dobierku", "cod", "cash on delivery"]);
const wantsShipping = hasAny(t, ["doprava", "dorucenie", "doručenie", "postovne", "poštovné", "cena dopravy", "koľko stojí doprava", "kolko stoji doprava"]);
const wantsPayment = hasAny(t, ["platba", "karta", "prevod", "bankovy prevod", "bankový prevod", "paypal"]);
const wantsReturns = hasAny(t, ["reklam", "vraten", "vráten", "reklamacia", "reklamácia"]);

if (wantsFree && typeof free !== "undefined") {
return `Doprava zdarma je pri nákupe od ${free} ${currency}.`;
}
if (wantsCod && typeof cod !== "undefined") {
return `Dobierka stojí ${cod} ${currency}.`;
}
if (wantsShipping) {
return `Možnosti dopravy a aktuálne ceny nájdeš tu: ${url}`;
}
if (wantsPayment && store.payment_info_url) {
return `Možnosti platby nájdeš tu: ${store.payment_info_url}`;
}
if (wantsReturns && store.returns_info_url) {
return `Reklamácie a vrátenie tovaru nájdeš tu: ${store.returns_info_url}`;
}

return "";
}

// ===== Product scoring/picking =====
function scoreProduct(product, message, goal, preferredFormat) {
const t = normalize(message);
let s = 0;

const formats = product.formats || [];
const prodGoals = product.goals || [];
const kws = product.keywords || [];

// category match (ak máš v products.json category)
const cat = normalize(product.category || "");
if (cat && t.includes(cat)) s += 8;

// goal match
if (goal && prodGoals.includes(goal)) s += 10;

// keyword match
for (const k of kws) {
const nk = normalize(k);
if (nk && t.includes(nk)) s += 2;
}

// preferred format (tvrdé)
if (preferredFormat) {
if (preferredFormat === "bez_kofeinu") {
if (product.caffeine === "no") s += 15;
if (product.caffeine === "yes") s -= 6;
} else {
if (formats.includes(preferredFormat)) s += 25;
else s -= 12;
}
}

// bestSeller boost
if (product.bestSeller) s += 2;

// must have url
if (!safeUrl(product)) s -= 100;

return s;
}

function pickTopProducts(message, goal, preferredFormat, limit = 2) {
const scored = PRODUCTS
.map((p) => ({ p, s: scoreProduct(p, message, goal, preferredFormat) }))
.sort((a, b) => b.s - a.s);

// ak user jasne chce formát, vyber len tie
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

function inferTypeFromMessage(msg) {
const t = normalize(msg);
if (t.includes("cbd") || t.includes("hemp") || t.includes("konop") || t.includes("olej")) return "cbd";
if (t.includes("protein") || t.includes("prote") || t.includes("whey")) return "protein";
if (t.includes("matcha")) return "matcha";
if (t.includes("kava") || t.includes("káva") || t.includes("coffee")) return "coffee";
if (t.includes("kapsul") || t.includes("caps")) return "capsules";
if (t.includes("caj") || t.includes("čaj") || t.includes("tea")) return "tea";
return "general";
}

function buildSmartAsk(type, msg, goal) {
const t = normalize(msg);

if (type === "coffee") {
if (!hasAny(t, ["instant", "mleta", "mletá", "zrnk", "bez kofe", "decaf"])) {
return "Chceš to skôr instant / mletú / zrnkovú – alebo bez kofeínu?";
}
if (!goal) return "A ide ti viac o energiu, spánok, stres, focus alebo imunitu? (stačí 1 slovo)";
return "";
}

if (type === "cbd") {
if (!hasAny(t, ["5%", "10%", "15%", "20%", "25%", "30%", "jemne", "jemné", "silne", "silné"])) {
return "Chceš skôr jemnejšie CBD (5–10%) alebo silnejšie (15–30%)? (napíš „jemné“ alebo „silné“)";
}
if (!hasAny(t, ["full spectrum", "broad spectrum", "izolat", "izol", "izolát"])) {
return "Preferuješ Full Spectrum alebo Broad Spectrum? (stačí 2 slová)";
}
if (!goal) return "Je to skôr stres, spánok, relax alebo regenerácia? (stačí 1 slovo)";
return "";
}

if (type === "protein") {
if (!hasAny(t, ["cokol", "čokol", "vanil", "jahod"])) {
return "Akú príchuť chceš? čokoláda / vanilka / jahoda (stačí 1 slovo)";
}
if (!goal) return "Chceš to skôr na svaly, chudnutie alebo regeneráciu? (stačí 1 slovo)";
return "";
}

if (type === "matcha") {
if (!hasAny(t, ["latte", "prasok", "prášok", "tubus", "doypack"])) {
return "Chceš matcha latte (hotové) alebo čistý matcha prášok? (stačí 2 slová)";
}
return "";
}

if (!goal) return "Je to skôr energia, spánok, stres, focus alebo imunita? (Stačí 1 slovo)";
return "";
}

function formatReply({ intro, products, ask }) {
let out = "";
if (intro) out += `${intro}\n\n`;

if (products?.length) {
out += `Odporúčam:\n`;
for (const p of products) {
out += `👉 ${safeTitle(p)}\n${safeUrl(p)}\n`;
if (p.oneLiner) out += `${p.oneLiner}\n`;
out += `\n`;
}
}

if (ask) out += `${ask}`;
return out.trim();
}

// ===== Optional: OpenAI to polish wording (NOT for FAQ) =====
async function polishWithOpenAI(draft) {
if (!OPENAI_API_KEY) return draft;

const system = `
Si Claudia – poradkyňa e-shopu ANiLab. Píš prirodzene po slovensky, stručne, konkrétne a v ŽENSKOM rode.
Nikdy nehovor, že si AI/model. Nepíš dlhé eseje.
Nezmeň linky ani názvy produktov. Len uprav štýl aby pôsobil ľudsky a predajne.
Zdravotné tvrdenia formuluj bezpečne (podpora/pohoda), nelieč choroby.
`.trim();

try {
const payload = {
model: OPENAI_MODEL,
temperature: 0.4,
messages: [
{ role: "system", content: system },
{ role: "user", content: draft },
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

if (!res.ok) return draft;
const data = await res.json();
return data?.choices?.[0]?.message?.content?.trim() || draft;
} catch {
return draft;
}
}

// ===== Routes =====
app.get("/", (req, res) => res.send("OK"));
app.get("/health", (req, res) => {
res.json({ ok: true, products: PRODUCTS.length, faq: !!FAQ, time: new Date().toISOString() });
});

// MAIN CHAT
app.post("/chat", async (req, res) => {
try {
const msg = (req.body?.message || "").toString().trim();
const sessionId = (req.body?.sessionId || req.ip || "anon").toString();

if (!msg) {
return res.json({
reply: "Ahoj, volám sa Claudia – poradkyňa ANiLab 🙂 S čím ti môžem pomôcť? (energia / spánok / stres / focus / imunita / CBD / proteín)",
});
}

const session = getSession(sessionId);

const pf = detectPreferredFormat(msg);
if (pf) session.preferredFormat = pf;

const goal = extractGoal(msg);
if (goal) session.lastGoal = goal;

const intent = detectIntent(msg);

// 1) ORDER_HELP -> HARD FAQ, žiadne AI
if (intent === "order_help") {
const faqReply = tryFaqAnswer(msg);
if (faqReply) return res.json({ reply: `Jasné 🙂 ${faqReply}` });

// fallback pre order_help, stále bez AI (aby si nemlel blbosti)
const shippingUrl = (FAQ?.store?.shipping_info_url) || "https://anilab.sk";
return res.json({ reply: `Jasné 🙂 Najpresnejšie info k doprave/platbe je tu: ${shippingUrl}` });
}

// 2) product/benefit/general -> vždy daj aspoň 1 produkt hneď
const type = inferTypeFromMessage(msg);
const g = goal || session.lastGoal || "";
const prods = pickTopProducts(msg, g, session.preferredFormat, type === "general" ? 1 : 2);

// otázka max 1x (a potom už len odporúčaj)
let ask = "";
if (!session.askedOnce) {
ask = buildSmartAsk(type, msg, g);
session.askedOnce = true;
}

const intro = (type === "general")
? "Aby som ti hneď pomohla, toto sú najčastejšie voľby zákazníkov:"
: "Rozumiem 🙂 Podľa toho čo píšeš, toto je najlepší match:";

let draft = formatReply({ intro, products: prods, ask });

// optional: vylepši štýl cez OpenAI (ale linky ostanú)
draft = await polishWithOpenAI(draft);

return res.json({ reply: draft });
} catch (e) {
console.error(e);
return res.json({ reply: "Technická chyba. Skús prosím o chvíľu 🙂" });
}
});

app.listen(PORT, () => console.log("Server running on", PORT));

