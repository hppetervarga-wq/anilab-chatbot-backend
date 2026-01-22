import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import nodemailer from "nodemailer";

// Node 18+ má fetch natívne.
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

// ===== SMTP (B2B leads) =====
const SMTP_HOST = process.env.SMTP_HOST || "";
const SMTP_PORT = Number(process.env.SMTP_PORT || "587");
const SMTP_USER = process.env.SMTP_USER || "";
const SMTP_PASS = process.env.SMTP_PASS || "";
const SMTP_FROM = process.env.SMTP_FROM || "noreply@anilab.eu";
const B2B_TO = process.env.B2B_TO || "natalia@anilab.eu";

const canSendMail = !!(SMTP_HOST && SMTP_USER && SMTP_PASS);

let mailer = null;
if (canSendMail) {
mailer = nodemailer.createTransport({
host: SMTP_HOST,
port: SMTP_PORT,
secure: SMTP_PORT === 465,
auth: { user: SMTP_USER, pass: SMTP_PASS },
});
}

async function sendB2BLeadEmail(lead, rawConversation = []) {
if (!mailer) return false;

const subject = `ANiLab B2B Lead – ${lead?.type || "nezadané"} – ${lead?.country || "nezadané"} – ${lead?.email || "bez emailu"}`;

const lines = [
"B2B LEAD (z web chatu)",
"====================",
`Typ: ${lead?.type || "-"}`,
`Krajina / dodanie: ${lead?.country || "-"}`,
`Produkty: ${lead?.products || "-"}`,
`Objem / štart: ${lead?.volume || "-"}`,
`Meno: ${lead?.name || "-"}`,
`Firma: ${lead?.company || "-"}`,
`Email: ${lead?.email || "-"}`,
`Web/IG: ${lead?.web || "-"}`,
"",
"RAW CHAT (posledné správy):",
"---------------------------",
...rawConversation.slice(-12).map((x) => `- ${x}`),
"",
`Timestamp: ${new Date().toISOString()}`,
];

await mailer.sendMail({
from: SMTP_FROM,
to: B2B_TO,
subject,
text: lines.join("\n"),
});

return true;
}

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
// sessionId -> { askedOnce:boolean, lastGoal:string, preferredFormat:string, lastCategory:string, isB2B:boolean, b2bStep:number, b2bLead:object, convo:string[] }

function getSession(sessionId) {
if (!sessionStore.has(sessionId)) {
sessionStore.set(sessionId, {
askedOnce: false,
lastGoal: "",
preferredFormat: "", // "zrnkova" | "mleta" | "instant" | "bez_kofeinu"
lastCategory: "",
isB2B: false,
b2bStep: 0,
b2bLead: {
type: "",
country: "",
products: "",
volume: "",
name: "",
company: "",
email: "",
web: "",
},
convo: [],
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

// ===== B2B detection =====
function detectB2BIntent(message) {
const t = normalize(message);

const b2bSignals = [
"b2b",
"velkoobchod", "veľkoobchod", "velkoodber", "veľkoodber", "velkoodberatel", "veľkoodberateľ",
"cennik", "cenník", "velkoobchodny cennik", "veľkoobchodný cenník", "wholesale", "pricelist",
"distribucia", "distribúcia", "distributor",
"reseller", "predajca", "predajňa", "retail", "reťazec", "retazec",
"private label", "privatna znacka", "privátna značka", "white label",
"objem", "moq", "paleta", "pallet", "karton", "kartón",
"faktura", "faktúra", "ico", "ičo", "dic", "dič", "vat", "dph",
"marza", "marža", "rabaty", "rabaty", "zlav", "zľav",
"nakupna cena", "nákupná cena",
];

return hasAny(t, b2bSignals);
}

function normalizeB2BType(answer) {
const t = normalize(answer);
if (hasAny(t, ["private label", "privatna znacka", "privátna značka", "white label"])) return "private label";
if (hasAny(t, ["distrib", "distributor"])) return "distribúcia";
if (hasAny(t, ["reseller", "predajca", "predajna", "predajňa", "retail"])) return "veľkoobchod / reseller";
if (hasAny(t, ["velkoobchod", "veľkoobchod", "wholesale"])) return "veľkoobchod";
return answer?.toString().trim() || "";
}

function extractEmail(text) {
const m = (text || "").match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
return m ? m[0] : "";
}

function extractWebOrIG(text) {
const s = (text || "").toString();
const ig = s.match(/@([a-zA-Z0-9._]+)/);
if (ig) return `@${ig[1]}`;
const url = s.match(/https?:\/\/[^\s]+/i);
if (url) return url[0];
const www = s.match(/\bwww\.[^\s]+\b/i);
if (www) return www[0];
return "";
}

function b2bQuestion(step) {
if (step === 1) {
return `Si firma alebo reseller? Vyber 1 možnosť:\n1) private label\n2) veľkoobchod / reseller\n3) distribúcia`;
}
if (step === 2) return "Krajina + kam chceš dodávať? (napr. SK / CZ / PL / HU / UAE…)";
if (step === 3) return "O aké produkty máš záujem? (kategória alebo konkrétne SKU; ak nevieš, napíš len „kávy / proteíny / CBD / kapsule“)";
if (step === 4) return "Aký približný objem na štart? (MOQ / kusy / €/mesiac – stačí odhad)";
if (step === 5) return "Kontakt prosím: email (stačí email; voliteľne meno + firma + web/IG).";
return "";
}

async function handleB2BFlow(session, msg) {
// ulož posledné správy (na konci sa pošlú Natálke)
session.convo.push(msg);
if (session.convo.length > 30) session.convo = session.convo.slice(-30);

// keď práve začíname
if (!session.isB2B) {
session.isB2B = true;
session.b2bStep = 1;

return `Jasné 🙂 vidím, že ide o B2B.\n\n${b2bQuestion(1)}`;
}

// step-based zber
const step = session.b2bStep || 1;
const lead = session.b2bLead || {};

if (step === 1) {
lead.type = normalizeB2BType(msg);
session.b2bStep = 2;
session.b2bLead = lead;
return b2bQuestion(2);
}

if (step === 2) {
lead.country = msg.toString().trim();
session.b2bStep = 3;
session.b2bLead = lead;
return b2bQuestion(3);
}

if (step === 3) {
lead.products = msg.toString().trim();
session.b2bStep = 4;
session.b2bLead = lead;
return b2bQuestion(4);
}

if (step === 4) {
lead.volume = msg.toString().trim();
session.b2bStep = 5;
session.b2bLead = lead;
return b2bQuestion(5);
}

if (step === 5) {
const email = extractEmail(msg);
if (email) lead.email = email;

// voliteľné: meno/firma/web
if (!lead.web) lead.web = extractWebOrIG(msg);
// jednoduchý pokus: ak niekto napíše "Meno Firma, email..."
const cleaned = msg.replace(lead.email || "", "").trim();
if (!lead.name && cleaned.length && cleaned.length < 80) lead.name = cleaned;

session.b2bLead = lead;

// musí byť aspoň email
if (!lead.email) {
return "Prosím pošli len email (napr. meno@firma.com).";
}

// pošli email Natálke
let sent = false;
try {
sent = await sendB2BLeadEmail(lead, session.convo);
} catch (e) {
console.error("B2B email send error:", e);
sent = false;
}

// reset B2B flow, aby chat mohol pokračovať aj normálne
session.isB2B = false;
session.b2bStep = 0;

const confirm = sent
? "Super, ďakujem 🙂 Poslala som to Natálke a ozve sa ti čo najskôr."
: "Super, ďakujem 🙂 Mám to uložené, ale email sa nepodarilo odoslať (chýba SMTP). Pošli mi prosím ešte raz email a ja to prepíšem do systému manuálne.";

// po potvrdení môžeš ešte hneď ponúknuť ďalší krok
return `${confirm}\n\nAk chceš, napíš ešte: *koľko produktových liniek (SKU) a aký typ balenia (doypack/tubus/caps)* – urýchli to nacenenie.`;
}

// fallback
session.b2bStep = 1;
return b2bQuestion(1);
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
res.json({ ok: true, products: PRODUCTS.length, faq: !!FAQ, time: new Date().toISOString(), canSendMail });
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

// log konverzácie (pre B2B email)
session.convo.push(msg);
if (session.convo.length > 30) session.convo = session.convo.slice(-30);

// ===== 0) B2B DETEKCIA (len keď to dáva zmysel) =====
// Ak je user už v B2B flow, alebo správa obsahuje B2B signály -> spusti B2B kvalifikáciu
if (session.isB2B || detectB2BIntent(msg)) {
const b2bReply = await handleB2BFlow(session, msg);
return res.json({ reply: b2bReply });
}

// ===== 1) normálny B2C flow =====
const pf = detectPreferredFormat(msg);
if (pf) session.preferredFormat = pf;

const goal = extractGoal(msg);
if (goal) session.lastGoal = goal;

const intent = detectIntent(msg);

// ORDER_HELP -> HARD FAQ, žiadne AI
if (intent === "order_help") {
const faqReply = tryFaqAnswer(msg);
if (faqReply) return res.json({ reply: `Jasné 🙂 ${faqReply}` });

const shippingUrl = (FAQ?.store?.shipping_info_url) || "https://anilab.sk";
return res.json({ reply: `Jasné 🙂 Najpresnejšie info k doprave/platbe je tu: ${shippingUrl}` });
}

// product/benefit/general -> vždy daj aspoň 1 produkt hneď
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

app.listen(PORT, () => {
console.log(`Server running on ${PORT}`);
});
