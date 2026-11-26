#!/usr/bin/env node
// ROY AI chat bot. Runs next to the BringPlus sync on GitHub Actions: answers questions written in the
// "ROY AI" Telegram group. The answer is computed by ROY OS (/api/ai/ask) with the owner's own session.
// Customer data and messages are never written to the (public) GitHub log.
import { createClient } from "@supabase/supabase-js";

const CLOUD = process.env.ROY_CLOUD ? JSON.parse(Buffer.from(process.env.ROY_CLOUD, "base64").toString("utf8")) : null;
if (!CLOUD) { console.log("ROY AI bot: vetëm në GitHub (mungon ROY_CLOUD)."); process.exit(0); }
const MINUTES = Number(process.env.BOT_MINUTES || 330);
const APP = (CLOUD.app || process.env.ROY_APP_URL || "https://roy-jewelry-os.vercel.app").replace(/\/$/, "");
const TOKEN = CLOUD.kc?.tg_token; const EMAIL = CLOUD.kc?.email; const PASS = EMAIL ? CLOUD.kc?.[EMAIL] : "";
const tg = (method, body) => fetch(`https://api.telegram.org/bot${TOKEN}/${method}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(65_000) }).then((r) => r.json()).catch(() => null);

const HELP = "👋 Jam ROY AI. Më shkruani çdo pyetje për biznesin, p.sh.:\n• Sa shita sot / këtë javë?\n• Cili produkt po shitet më shumë?\n• Cili qytet refuzon më shumë?\n• Çfarë të reklamoj këtë javë dhe me sa para?\n• Më shkruaj një caption për Instagram për Unaze Bow\n• Më jep 3 ide video për TikTok këtë javë\n\n🔎 Çdo mëngjes pas orës 8 ju dërgoj kërkimin e tregut (unaza, Pandora, sete, byzylykë). /kerko — kërkim i ri tani.\n\nMë shkruani normalisht, si në bisedë.\n/harro — nis bisedë të re";


// ---------- Daily market research (rings, Pandora-style, sets, bracelets) ----------
const NEWS = [ // Kosovo and Albania first; global TikTok/Pandora queries to spot trends that are coming
  ["bizhuteri", "sq"], ["Pandora", "sq"], ["byzylyk", "sq"], ["gjerdan", "sq"], ["dhurata", "sq"], ["TikTok Kosovë", "sq"],
  ["TikTok Shqipëri", "sq"], ["trend TikTok", "sq"], ["oferta Prishtinë", "sq"], ["festat Kosovë", "sq"], ["influencer shqiptare", "sq"],
  ["TikTok trend jewelry", "en"], ["TikTok viral trend this week", "en"], ["TikTok trending sounds", "en"], ["Pandora charms trend", "en"],
  ["Pandora necklace new", "en"], ["charm bracelet TikTok", "en"], ["jewelry trends 2027", "en"],
];
const unxml = (t) => String(t ?? "").replace(/<!\[CDATA\[|\]\]>/g, "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
const tagOf = (x, t) => unxml(x.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1]);
async function rss(url) { try { const r = await fetch(url, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) }); return r.ok ? await r.text() : ""; } catch { return ""; } }
async function collectNews() {
  const items = [];
  for (const [q, lang] of NEWS) {
    const ed = lang === "sq" ? "hl=sq&gl=AL&ceid=AL:sq" : "hl=en-US&gl=US&ceid=US:en";
    const x = await rss(`https://news.google.com/rss/search?q=${encodeURIComponent(q + " when:7d")}&${ed}`);
    for (const it of (x.match(/<item>[\s\S]*?<\/item>/g) ?? []).slice(0, 7)) items.push({ q, title: tagOf(it, "title"), source: tagOf(it, "source"), date: tagOf(it, "pubDate").slice(0, 16) });
  }
  const trends = [];
  for (const geo of ["XK", "AL"]) { const t = await rss(`https://trends.google.com/trending/rss?geo=${geo}`); for (const it of (t.match(/<item>[\s\S]*?<\/item>/g) ?? []).slice(0, 20)) trends.push(`${geo === "XK" ? "Kosovë" : "Shqipëri"}: ${tagOf(it, "title")}`); }
  return { items, trends };
}
const ymd = (d) => { const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(d).map((x) => [x.type, x.value])); return `${p.year}-${p.month}-${p.day}`; };
const localDay = () => ymd(new Date());
const localHour = () => Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Belgrade", hour: "2-digit", hour12: false }).format(new Date()));
async function dailyResearch(db, token, chat) {
  const { items, trends } = await collectNews();
  if (!items.length) { console.log("ROY AI kërkimi: nuk erdhën lajme."); return false; }
  const r = await fetch(`${APP}/api/ai/research`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({ items, trends }), signal: AbortSignal.timeout(75_000) }).catch(() => null);
  const j = r ? await r.json().catch(() => ({})) : {};
  if (!j.ok) { console.log("ROY AI kërkimi: dështoi (" + String(j.error || r?.status || "rrjeti").slice(0, 60) + ")"); return false; }
  for (let i = 0; i < j.telegram.length; i += 3800) await tg("sendMessage", { chat_id: chat, text: (i ? "" : "🔎 ") + j.telegram.slice(i, i + 3800) });
  console.log(`ROY AI kërkimi: u ruajt (${items.length} lajme).`);
  return true;
}

async function main() {
  if (!TOKEN || !EMAIL || !PASS) { console.log("ROY AI bot: mungon Telegram ose hyrja."); return; }
  const db = createClient(CLOUD.url, CLOUD.anon, { auth: { persistSession: false, autoRefreshToken: true } });
  const { error } = await db.auth.signInWithPassword({ email: EMAIL, password: PASS }); if (error) { console.log("ROY AI bot: hyrja dështoi."); return; }
  const { data: orgId } = await db.rpc("bootstrap_org");
  const end = Date.now() + MINUTES * 60_000;
  let offset = 0, chat = null, lastChatCheck = 0, lastResearchCheck = 0, researchDay = ""; const history = new Map(); let answered = 0;
  console.log("ROY AI bot: aktiv.");
  while (Date.now() < end) {
    if (Date.now() - lastChatCheck > 5 * 60_000) { // the AI chat can be linked later by the sync (/ai)
      const { data: st } = await db.from("organization_settings").select("telegram_ai_chat").eq("org_id", orgId).maybeSingle();
      chat = st?.telegram_ai_chat || null; lastChatCheck = Date.now();
    }
    if (!chat) { await new Promise((r) => setTimeout(r, 60_000)); continue; }
    if (Date.now() - lastResearchCheck > 10 * 60_000 && localHour() >= 8 && researchDay !== localDay()) { // once a day, from 08:00
      lastResearchCheck = Date.now();
      const since = new Date(Date.now() - 20 * 3600_000).toISOString();
      const { data: done, error: rErr } = await db.from("ai_research").select("id, created_at").eq("org_id", orgId).gte("created_at", since).order("created_at", { ascending: false }).limit(1);
      const doneToday = !!done?.[0] && ymd(new Date(done[0].created_at)) === localDay();
      if (rErr) console.log("ROY AI kërkimi: kontrolli dështoi, provoj më vonë (" + String(rErr.message).slice(0, 60) + ")");
      else if (doneToday) researchDay = localDay();
      else { const { data: { session } } = await db.auth.getSession(); if (await dailyResearch(db, session?.access_token, chat)) researchDay = localDay(); }
    }
    const u = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
    if (!u?.ok) { await new Promise((r) => setTimeout(r, u?.error_code === 409 ? 30_000 : 5_000)); continue; }
    for (const up of u.result) {
      offset = up.update_id + 1;
      const m = up.message;
      if (m?.migrate_from_chat_id && String(m.migrate_from_chat_id) === String(chat)) { chat = String(m.chat.id); await db.rpc("set_telegram_ai_chat", { p_org: orgId, p_chat: chat }); continue; } // group became a supergroup
      if (!m || String(m.chat?.id) !== String(chat) || m.from?.is_bot) continue;
      const text = (m.text || m.caption || "").trim(); if (!text) continue;
      if (/^\/ai(@\w+)?$/i.test(text)) continue; // the link command, handled by the sync
      if (/^\/(start|ndihme|help)(@\w+)?$/i.test(text)) { await tg("sendMessage", { chat_id: chat, text: HELP }); continue; }
      if (/^\/kerko(@\w+)?$/i.test(text)) { await tg("sendMessage", { chat_id: chat, text: "🔎 Po bëj kërkimin e tregut për Kosovë dhe Shqipëri… rreth 1 minutë." }); const { data: { session } } = await db.auth.getSession(); if (!(await dailyResearch(db, session?.access_token, chat))) await tg("sendMessage", { chat_id: chat, text: "⚠️ Kërkimi nuk u krye. Provoni sërish pas pak." }); continue; }
      if (/^\/harro(@\w+)?$/i.test(text)) { history.delete(chat); await tg("sendMessage", { chat_id: chat, text: "🧹 U nis bisedë e re." }); continue; }
      const q = text.replace(/^\/(p|pyet|q)(@\w+)?\s*/i, "").replace(/^@\w+\s*/, "");
      if (!q) { await tg("sendMessage", { chat_id: chat, text: "Shkruani pyetjen pas /p, p.sh. /p sa shita sot?" }); continue; }
      const turns = [...(history.get(chat) ?? []), { role: "user", text: q }].slice(-10);
      await tg("sendChatAction", { chat_id: chat, action: "typing" });
      const typing = setInterval(() => tg("sendChatAction", { chat_id: chat, action: "typing" }), 4500);
      let reply;
      try {
        const { data: { session } } = await db.auth.getSession();
        const r = await fetch(`${APP}/api/ai/ask`, { method: "POST", headers: { Authorization: `Bearer ${session?.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ history: turns, from: m.from?.first_name || "", channel: "telegram" }), signal: AbortSignal.timeout(70_000) });
        const j = await r.json().catch(() => ({}));
        reply = j.text || `⚠️ Nuk mora përgjigje (${j.error || "HTTP " + r.status}). Provoni sërish pas pak.`;
        if (j.text) history.set(chat, [...turns, { role: "assistant", text: j.text }].slice(-10));
      } catch { reply = "⚠️ ROY OS nuk u përgjigj me kohë. Provoni sërish."; }
      finally { clearInterval(typing); }
      for (let i = 0; i < reply.length; i += 4000) await tg("sendMessage", { chat_id: chat, text: reply.slice(i, i + 4000), reply_to_message_id: i ? undefined : m.message_id });
      answered++;
    }
  }
  console.log(`ROY AI bot: u ndal pas ${MINUTES} min (${answered} përgjigje).`);
}
main().catch((e) => { console.log("ROY AI bot: gabim " + (e?.message || "").slice(0, 80)); });
