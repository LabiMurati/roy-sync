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

const HELP = "👋 Jam ROY AI. Më shkruani çdo pyetje për biznesin, p.sh.:\n• Sa shita sot / këtë javë?\n• Cili produkt po shitet më shumë?\n• Cili qytet refuzon më shumë?\n• Çfarë të reklamoj këtë javë dhe me sa para?\n• Më shkruaj një caption për Instagram për Unaze Bow\n• Çfarë duhet të porosis nga Kina?\n\n/harro — nis bisedë të re";

async function main() {
  if (!TOKEN || !EMAIL || !PASS) { console.log("ROY AI bot: mungon Telegram ose hyrja."); return; }
  const db = createClient(CLOUD.url, CLOUD.anon, { auth: { persistSession: false, autoRefreshToken: true } });
  const { error } = await db.auth.signInWithPassword({ email: EMAIL, password: PASS }); if (error) { console.log("ROY AI bot: hyrja dështoi."); return; }
  const { data: orgId } = await db.rpc("bootstrap_org");
  const end = Date.now() + MINUTES * 60_000;
  let offset = 0, chat = null, lastChatCheck = 0; const history = new Map(); let answered = 0;
  console.log("ROY AI bot: aktiv.");
  while (Date.now() < end) {
    if (Date.now() - lastChatCheck > 5 * 60_000) { // the AI chat can be linked later by the sync (/ai)
      const { data: st } = await db.from("organization_settings").select("telegram_ai_chat").eq("org_id", orgId).maybeSingle();
      chat = st?.telegram_ai_chat || null; lastChatCheck = Date.now();
    }
    if (!chat) { await new Promise((r) => setTimeout(r, 60_000)); continue; }
    const u = await tg("getUpdates", { offset, timeout: 50, allowed_updates: ["message"] });
    if (!u?.ok) { await new Promise((r) => setTimeout(r, u?.error_code === 409 ? 30_000 : 5_000)); continue; }
    for (const up of u.result) {
      offset = up.update_id + 1;
      const m = up.message; if (!m || String(m.chat?.id) !== String(chat) || m.from?.is_bot) continue;
      const text = (m.text || m.caption || "").trim(); if (!text) continue;
      if (/^\/ai(@\w+)?$/i.test(text)) continue; // the link command, handled by the sync
      if (/^\/(start|ndihme|help)(@\w+)?$/i.test(text)) { await tg("sendMessage", { chat_id: chat, text: HELP }); continue; }
      if (/^\/harro(@\w+)?$/i.test(text)) { history.delete(chat); await tg("sendMessage", { chat_id: chat, text: "🧹 U nis bisedë e re." }); continue; }
      const q = text.replace(/^@\w+\s*/, "");
      const turns = [...(history.get(chat) ?? []), { role: "user", text: q }].slice(-10);
      await tg("sendChatAction", { chat_id: chat, action: "typing" });
      const typing = setInterval(() => tg("sendChatAction", { chat_id: chat, action: "typing" }), 4500);
      let reply;
      try {
        const { data: { session } } = await db.auth.getSession();
        const r = await fetch(`${APP}/api/ai/ask`, { method: "POST", headers: { Authorization: `Bearer ${session?.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ history: turns }), signal: AbortSignal.timeout(70_000) });
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
