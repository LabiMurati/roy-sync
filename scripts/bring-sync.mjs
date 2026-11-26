#!/usr/bin/env node
// ROY JEWELRY OS <- BringPlus sync. Runs on your Mac. Reads your parcel list from bringplus-ks.com and registers new parcels as orders.
//
//   node scripts/bring-sync.mjs --login          first time: opens a window, you sign in to BringPlus yourself
//   node scripts/bring-sync.mjs --dry            shows what would happen, changes nothing
//   node scripts/bring-sync.mjs --since 20.11.2026   only parcels registered on/after that date (default: last 3 days)
//   node scripts/bring-sync.mjs                  real run
//
// Passwords: BringPlus -> typed only in the browser window, stays in the local browser profile (~/.roy-bring-profile).
//            ROY OS    -> asked once in this Terminal (hidden), kept in the macOS Keychain. Nothing is written to the project.
import { chromium } from "playwright";
import { createClient } from "@supabase/supabase-js";
import { readFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const has = (f) => args.includes(f);
const val = (f) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
const LOGIN = has("--login"), DRY = has("--dry");
const PROFILE = join(homedir(), ".roy-bring-profile");
const KEYCHAIN = "roy-os-sync";
// Cloud mode (GitHub Actions): everything comes from one secret ROY_CLOUD (base64 JSON), nothing from this Mac's Keychain/profile.
const CLOUD = process.env.ROY_CLOUD ? JSON.parse(Buffer.from(process.env.ROY_CLOUD, "base64").toString("utf8")) : null;
if (CLOUD) { const _log = console.log; console.log = (...a) => { const t = String(a[0] ?? ""); if (/^(Përfundoi|Gabim|Pagesat|Kujdes|BringPlus:|\d+ njoftime|Një sinkronizim|Përmbledhja)/.test(t)) _log(...a); }; } // keep customer names out of public logs
const POSTAGE = [[/koso/i, "Kosovë", 2.5], [/alban|shqip/i, "Shqipëri", 6], [/macedon|maqed/i, "Maqedoni e Veriut", 6]];
const COUNTRY_BY_FLAG = (alt) => (POSTAGE.find(([re]) => re.test(alt)) ?? [null, "Kosovë", 2.5]).slice(1);
// BringPlus status -> how far the order should go in ROY OS. null = do not import.
const FLOW = { "E regjistruar": [], "Në magazinë": [], "Problematike": [], "Për refuzim": [], "Në shpërndarje": ["shipped"],
  "E dorëzuar": ["shipped", "delivered"], "Gati për likuidim": ["shipped", "delivered"], "E likuiduar": ["shipped", "delivered"], "E kthyer": null };

function env() {
  if (CLOUD) return { url: CLOUD.url, anon: CLOUD.anon };
  const t = readFileSync(new URL("../.env.local", import.meta.url), "utf8");
  const g = (k) => t.match(new RegExp(`^${k}=(.*)$`, "m"))?.[1]?.trim().replace(/^["']|["']$/g, "");
  return { url: g("NEXT_PUBLIC_SUPABASE_URL"), anon: g("NEXT_PUBLIC_SUPABASE_ANON_KEY") };
}
const kc = (acct) => { if (CLOUD) return CLOUD.kc?.[acct] ?? ""; try { return execFileSync("security", ["find-generic-password", "-a", acct, "-s", KEYCHAIN, "-w"], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
const kcSet = (acct, v) => spawnSync("security", ["add-generic-password", "-U", "-a", acct, "-s", KEYCHAIN, "-w", v], { stdio: "ignore" }).status === 0;
async function tgSend(text) {
  const token = kc("tg_token"), chat = kc("tg_chat"); if (!token || !chat) return false;
  try { const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: chat, text: text.slice(0, 3500) }) }); return r.ok; } catch { return false; }
}
async function setupTelegram() {
  console.log("1) Te Telegram hapni @BotFather, shkruani /newbot dhe ndiqni hapat. Ai ju jep një çelës (token).\n2) Hapni botin e ri dhe shtypni START (ose shkruani 'hi').\n");
  const token = (await ask("Ngjitni çelësin e botit këtu (nuk shfaqet): ", true)).trim();
  const me = await fetch(`https://api.telegram.org/bot${token}/getMe`).then((r) => r.json()).catch(() => null);
  if (!me?.ok) throw new Error("Çelësi nuk u pranua nga Telegram.");
  console.log(`Boti: @${me.result.username}. Tani hapni këtë bot në Telegram dhe shkruani 'hi'. Po pres deri në 2 minuta…`);
  let chat = "";
  for (let i = 0; i < 40 && !chat; i++) {
    const u = await fetch(`https://api.telegram.org/bot${token}/getUpdates`).then((r) => r.json()).catch(() => null);
    const m = u?.result?.filter((x) => x.message?.chat?.type === "private").pop(); if (m) chat = String(m.message.chat.id);
    if (!chat) await new Promise((r) => setTimeout(r, 3000));
  }
  if (!chat) throw new Error("Nuk mora asnjë mesazh nga boti. Provoni sërish: node scripts/bring-sync.mjs --telegram");
  if (!kcSet("tg_token", token) || !kcSet("tg_chat", chat)) throw new Error("Keychain nuk e ruajti çelësin.");
  console.log((await tgSend("ROY JEWELRY OS: njoftimet nga BringPlus do të vijnë këtu.")) ? "U lidh. Duhet të keni marrë një mesazh provë në Telegram." : "U ruajt, por mesazhi provë nuk u dërgua.");
}
function ask(q, hidden) {
  return new Promise((res) => {
    process.stdout.write(q);
    const { stdin } = process; let s = "";
    stdin.setRawMode?.(true); stdin.resume(); stdin.setEncoding("utf8");
    const on = (c) => {
      if (c === "\u0003") process.exit(1);
      if (c === "\r" || c === "\n") { stdin.setRawMode?.(false); stdin.pause(); stdin.off("data", on); process.stdout.write("\n"); res(s); return; }
      if (c === "\u007f") { s = s.slice(0, -1); return; }
      s += c; if (!hidden) process.stdout.write(c);
    };
    stdin.on("data", on);
  });
}
async function osCredentials() {
  let email = kc("email"), pass = email ? kc(email) : "";
  if (!email || !pass) {
    email = (await ask("Email-i i hyrjes në ROY JEWELRY OS: ", false)).trim();
    pass = await ask("Fjalëkalimi (nuk shfaqet): ", true);
    execFileSync("security", ["add-generic-password", "-U", "-a", "email", "-s", KEYCHAIN, "-w", email]);
    const p = (await import("node:child_process")).spawnSync("security", ["add-generic-password", "-U", "-a", email, "-s", KEYCHAIN, "-w", pass], { stdio: "ignore" });
    if (p.status !== 0) console.log("(Keychain nuk e ruajti — do ta pyes sërish herës tjetër.)");
  }
  return { email, pass };
}

// ---------- BringPlus ----------
async function openCtx(headless) {
  if (!CLOUD) {
    let err;
    for (let i = 0; i < 4; i++) {
      try { return await chromium.launchPersistentContext(PROFILE, { headless, viewport: { width: 1500, height: 1000 } }); }
      catch (e) { err = e; await new Promise((r) => setTimeout(r, 3000)); }
    }
    throw err;
  }
  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({ storageState: CLOUD.state, viewport: { width: 1500, height: 1000 } });
  const close = ctx.close.bind(ctx); ctx.close = async () => { await close(); await browser.close(); };
  return ctx;
}
async function readParcels() {
  const ctx = await openCtx(!LOGIN);
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://bringplus-ks.com/parcels", { waitUntil: "domcontentloaded" });
  const ready = () => page.waitForSelector("table.p-datatable-table tbody tr td", { timeout: LOGIN ? 300000 : 25000 });
  try { if (LOGIN) console.log("Hyni në BringPlus në dritaren që u hap (kod SMS/CAPTCHA po ashtu). Skripti vazhdon vetë kur shfaqet lista e dërgesave."); await ready(); }
  catch { await ctx.close(); throw new Error(LOGIN ? "Lista e dërgesave nuk u hap brenda 5 minutave." : "Nuk jeni i futur në BringPlus. Nisni një herë me:  node scripts/bring-sync.mjs --login"); }
  if (LOGIN) { console.log("U hyre. Sesioni u ruajt në këtë Mac. Tani nisni:  node scripts/bring-sync.mjs --dry"); await ctx.close(); process.exit(0); }
  const seen = new Map();
  for (let guard = 0; guard < 60; guard++) {
    await page.waitForTimeout(600);
    const rows = await page.$$eval("table.p-datatable-table tbody tr", (trs) => trs.map((tr) => {
      const td = [...tr.querySelectorAll("td")]; if (td.length < 10) return null;
      const txt = (el) => (el?.innerText ?? "").replace(/ /g, " ").trim();
      const cust = td[5].querySelector(".parcel-customer-text"); const lines = (cust?.innerText ?? "").split("\n").map((x) => x.trim()).filter(Boolean);
      const dates = [...td[7].querySelectorAll(".parcel-status-dates__item")].map((d) => ({ s: d.getAttribute("title"), t: txt(d.querySelector("small")) }));
      return { id: txt(td[3]), courier: txt(td[4]), line1: lines[0] ?? "", line2: lines.slice(1).join(", "), flag: td[5].querySelector("img.parcel-country-flag")?.getAttribute("alt") ?? "",
        product: (td[6].querySelector("[title]")?.getAttribute("title") ?? txt(td[6]).split("\n")[0]).trim(), status: td[2].querySelector("[title]")?.getAttribute("title") ?? "", dates, comment: txt(td[8]), value: txt(td[9]) };
    }).filter(Boolean));
    for (const r of rows) seen.set(r.id, r);
    const next = await page.$(".p-paginator-next:not([disabled]):not(.p-disabled)");
    if (!next) break;
    const first = rows[0]?.id; await next.click();
    await page.waitForFunction((f) => document.querySelector("table.p-datatable-table tbody tr td:nth-child(4)")?.innerText.trim() !== f, first, { timeout: 15000 }).catch(() => {});
  }
  await ctx.close();
  return [...seen.values()];
}
// Payouts BringPlus owes the shop ("Pagesat ndaj shitësve"): read only, used for phone notifications.
async function readPayouts() {
  const ctx = await openCtx(true);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto("https://bringplus-ks.com/merchant-payouts", { waitUntil: "domcontentloaded" });
    try { await page.waitForSelector("tbody tr td", { timeout: 30000 }); }
    catch { const t = (await page.evaluate(() => document.body.innerText).catch(() => "")).replace(/\s+/g, " ").slice(0, 300); throw new Error(`nuk u gjet tabela (${page.url()}) — faqja tregon: ${t}`); }
    await page.waitForTimeout(800);
    const rows = await page.$$eval("tbody tr", (trs) => trs.map((tr) => [...tr.querySelectorAll("td")].map((td) => (td.innerText ?? "").replace(/\s+/g, " ").trim())));
    return rows.map((c) => {
      const id = c.find((x) => /^\d{1,8}$/.test(x)); if (!id) return null;
      const euro = c.filter((x) => /^[\d.,]+\s?€$/.test(x));
      const status = c.find((x) => /dërgesë|pranuar|krijuar|paguar|dorëzuar|likuid/i.test(x) && !/^\d/.test(x)) ?? "";
      const created = c.find((x) => /^\d\d\/\d\d\/\d{4} \d\d:\d\d$/.test(x)) ?? "";
      const m = created.match(/^(\d\d)\/(\d\d)\/(\d{4})/);
      return { id, status, amount: euro[euro.length - 1] ?? "", parcels: c.find((x) => /^\d+ \(.*€\)$/.test(x)) ?? "", period: c.find((x) => /^\d\d\/\d\d\/\d{4} - \d\d\/\d\d\/\d{4}$/.test(x)) ?? "", createdAt: m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`) : null };
    }).filter(Boolean);
  } finally { await ctx.close(); }
}
const addDaysLocal = (d, n) => new Date(d.getTime() + n * 864e5);
const toDate = (s) => { const m = s?.match(/(\d{2})\.(\d{2})\.(\d{4})/); return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T00:00:00`) : null; };
function normalise(r) {
  const m = r.line1.match(/^(.*?)\s*\(([^)]*)\)\s*$/); const name = (m ? m[1] : r.line1).replace(/^[\s:;,.\-]+|[\s:;,.\-]+$/g, "").replace(/\s+/g, " "), phone = (m ? m[2] : "").replace(/[^\d+]/g, "");
  const parts = r.line2.split(",").map((x) => x.trim()).filter(Boolean); const city = parts.length > 1 ? parts[parts.length - 1] : parts[0] ?? ""; const address = parts.length > 1 ? parts.slice(0, -1).join(", ") : parts[0] ?? "";
  const [country, cost] = COUNTRY_BY_FLAG(r.flag); const total = Number((r.value.match(/[\d.,]+/)?.[0] ?? "0").replace(",", "."));
  const created = toDate(r.dates.find((d) => d.s === "E regjistruar")?.t ?? r.dates[0]?.t);
  return { id: r.id, name, phone, address, city, country, cost, total, product: r.product || "Produkt", status: r.status, created, comment: (r.comment || "").replace(/\s+/g, " ").trim(), statusDate: toDate(r.dates.find((d) => d.s === r.status)?.t), deliveredDate: toDate(r.dates.find((d) => d.s === "E dorëzuar")?.t) };
}

// ---------- ROY OS ----------

// ---------- History import (BringPlus Excel export, converted to JSON) ----------
// node scripts/bring-sync.mjs --history ~/Downloads/bring-history.json          -> dry run (default)
// node scripts/bring-sync.mjs --history ~/Downloads/bring-history.json --apply  -> writes
// History lines are plain order lines (no stock movement): your counted stock already reflects past sales.
async function history() {
  const file = val("--history").replace(/^~/, homedir()); const APPLY = has("--apply");
  const rows = JSON.parse(readFileSync(file, "utf8"));
  const { url, anon } = env(); const { email, pass } = await osCredentials();
  const db = createClient(url, anon, { auth: { persistSession: false } });
  const { error: le } = await db.auth.signInWithPassword({ email, password: pass }); if (le) throw new Error("Hyrja në ROY OS dështoi.");
  const { data: orgId } = await db.rpc("bootstrap_org"); if (!orgId) throw new Error("Nuk u gjet organizata.");
  const norm = (t) => (t ?? "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, " ").trim();
  const digits = (t) => String(t ?? "").replace(/\D/g, "").slice(-8);
  const { data: existing } = await db.from("orders").select("id,phone,customer_name,total,status,tracking_number,idempotency_key").eq("org_id", orgId).limit(5000);
  const used = new Set(); const byKey = new Map();
  for (const o of existing ?? []) { if (o.tracking_number) byKey.set(String(o.tracking_number), o); if (o.idempotency_key) byKey.set(o.idempotency_key.replace(/^bringx?:/, ""), o); }
  if (has("--fix-dates")) {
    let ok = 0, miss = 0, bad = 0;
    for (const r of rows) {
      const o = byKey.get(r.id); if (!o) { miss++; continue; }
      const { error } = await db.rpc("bring_set_created", { p_order: o.id, p_at: new Date(r.created).toISOString() });
      if (error) { bad++; if (bad === 1) console.log("Gabim: " + error.message); } else ok++;
    }
    console.log(`Datat e vërteta u vendosën te ${ok} porosi. Pa porosi përkatëse: ${miss}. Gabime: ${bad}.`); return;
  }
  const pool = (existing ?? []).filter((o) => o.status !== "cancelled");
  const { data: prods } = await db.from("products").select("name,purchase_price").eq("org_id", orgId).eq("archived", false).limit(2000);
  const cost = new Map((prods ?? []).map((p) => [norm(p.name), Number(p.purchase_price) || 0]));
  const FLOW = { Krijuar: [], "Ne shperndarje": ["shipped"], Dorezuar: ["shipped", "delivered"], Likuiduar: ["shipped", "delivered"], "Gati per likuidim": ["shipped", "delivered"], Kthyer: ["shipped", "return"] };
  const COUNTRY = { Kosove: "Kosovë", Shqiperi: "Shqipëri", Maqedoni: "Maqedoni e Veriut" };
  const stats = { create: 0, dup: 0, bad: 0, failed: [] }; const t0 = new Date().toISOString(); let dateWarn = false;
  rows.sort((a, b) => a.created.localeCompare(b.created));
  for (const r of rows) {
    const fee = Number(r.fee) || 0, price = Math.max(0, Number(r.price) || 0), total = Math.max(0, price + fee);
    const flow = FLOW[r.status]; if (!flow || !r.name) { stats.bad++; continue; }
    // duplicate: same BringPlus id / tracking number, else same phone + same amount (or same name), each existing order used once
    let dup = byKey.get(r.id); if (dup) used.add(dup.id);
    if (!dup) dup = pool.find((o) => !used.has(o.id) && digits(o.phone) === digits(r.phone) && digits(r.phone).length >= 6 && (Math.abs(Number(o.total) - total) < 0.01 || Math.abs(Number(o.total) - price) < 0.01 || norm(o.customer_name) === norm(r.name)));
    if (dup) { used.add(dup.id); stats.dup++; continue; }
    const when = new Date(r.created); const country = COUNTRY[r.country] ?? "Kosovë";
    console.log(`${APPLY ? "" : "[prova] "}+ ${r.id}  ${r.created.slice(0, 10)}  ${r.name}  ${country}  ${price}€ + ${fee}€  ${r.product}  [${r.status}]`);
    stats.create++; if (!APPLY) continue;
    const { data: oid, error } = await db.rpc("create_order", { p_org: orgId, p_order: { customer_name: r.name, phone: r.phone || "-", address: r.address || "-", city: r.city || "-", country, channel: "manual", status: "confirmed", courier: "BringPlus", tracking_number: r.id, courier_cost: fee, shipping_price: fee, idempotency_key: `bringx:${r.id}` },
      p_items: [{ product_name: r.product || "Produkt", quantity: 1, unit_price: price, unit_cost: cost.get(norm(r.product)) ?? 0 }] });
    if (error) { stats.failed.push([r.id, error.message]); continue; }
    const { error: de } = await db.rpc("bring_set_created", { p_order: oid, p_at: when.toISOString() }); if (de && !dateWarn) { dateWarn = true; console.log("Kujdes: data e porosisë nuk u ndryshua: " + de.message); }
    let st = "confirmed";
    for (const step of flow) {
      if (step === "return") {
        const { data: items } = await db.from("order_items").select("id,quantity").eq("order_id", oid);
        for (const it of items ?? []) { const { error: e2 } = await db.rpc("receive_return", { p_item: it.id, p_qty: it.quantity, p_sellable: true }); if (e2) stats.failed.push([r.id, "kthimi: " + e2.message]); }
      } else { const { error: e1 } = await db.rpc("set_order_status", { p_order: oid, p_to: step, p_note: "BringPlus (histori)" }); if (e1) { stats.failed.push([r.id, e1.message]); break; } st = step; }
    }
  }
  if (APPLY) await db.from("notifications").update({ resolved_at: new Date().toISOString() }).eq("org_id", orgId).eq("kind", "order").is("resolved_at", null).gte("created_at", t0);
  console.log(`\n${APPLY ? "U regjistruan" : "Do të regjistroheshin (provë)"}: ${stats.create} porosi të reja. Dublikata të anashkaluara: ${stats.dup}. Pa status të njohur: ${stats.bad}.`);
  if (stats.failed.length) console.log("Probleme:", stats.failed.map(([i, w]) => `${i}: ${w}`).join("; "));
  if (!APPLY) console.log("Asgjë nuk u ndryshua. Për ta regjistruar vërtet, shtoni --apply në fund të komandës.");
}

// node scripts/bring-sync.mjs --export-cloud : puts ONE secret (ROY_CLOUD) on the clipboard for GitHub. It holds sign-ins; never paste it in a chat.
async function exportCloud() {
  const { url, anon } = env(); const { email, pass } = await osCredentials();
  const ctx = await chromium.launchPersistentContext(PROFILE, { headless: true, viewport: { width: 1500, height: 1000 } });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  await page.goto("https://bringplus-ks.com/parcels", { waitUntil: "domcontentloaded" });
  try { await page.waitForSelector("table.p-datatable-table tbody tr td", { timeout: 25000 }); }
  catch { await ctx.close(); throw new Error("Nuk jeni i futur në BringPlus. Nisni:  node scripts/bring-sync.mjs --login"); }
  const state = await ctx.storageState(); await ctx.close();
  const blob = { url, anon, state, kc: { email, [email]: pass, tg_token: kc("tg_token"), tg_chat: kc("tg_chat") } };
  const b64 = Buffer.from(JSON.stringify(blob)).toString("base64");
  const r = spawnSync("pbcopy", { input: b64 });
  console.log(r.status === 0 ? `U kopjua në clipboard (${Math.round(b64.length / 1024)} KB). Ngjitni te GitHub si sekret me emrin ROY_CLOUD. Mos e ngjitni askund tjetër.` : "pbcopy dështoi.");
}
async function main() {
  if (has("--telegram")) return setupTelegram();
  if (val("--history")) return history();
  if (has("--export-cloud")) return exportCloud();
  if (LOGIN) return readParcels();
  // One run at a time: two browsers on the same profile break the BringPlus session ("Nuk jeni i futur").
  const LOCK = "/tmp/roy-bring-sync.lock";
  try { if (Date.now() - statSync(LOCK).mtimeMs > 5 * 60 * 1000) rmSync(LOCK, { recursive: true, force: true }); } catch {}
  try { mkdirSync(LOCK); } catch { console.log("Një sinkronizim tjetër po ekzekutohet tani; kjo nisje u anashkalua."); return; }
  process.on("exit", () => { try { rmSync(LOCK, { recursive: true, force: true }); } catch {} });
  const { url, anon } = env(); if (!url || !anon) throw new Error("Mungon NEXT_PUBLIC_SUPABASE_URL ose ANON_KEY në .env.local.");
  const parcels = (await readParcels()).map(normalise);
  console.log(`BringPlus: ${parcels.length} dërgesa u lexuan.`);
  let payouts = []; try { payouts = await readPayouts(); } catch (e) { console.log("Pagesat nuk u lexuan: " + e.message.split("\n")[0]); }
  const { email, pass } = await osCredentials();
  const db = createClient(url, anon, { auth: { persistSession: false } });
  const { error: le } = await db.auth.signInWithPassword({ email, password: pass });
  if (le) {
    const bad = le.status === 400 || /invalid login|invalid credentials/i.test(le.message || "");
    if (!bad) throw new Error("Hyrja në ROY OS dështoi përkohësisht (rrjeti?): " + (le.message || "") + ". Do provohet sërish.");
    try { execFileSync("security", ["delete-generic-password", "-a", "email", "-s", KEYCHAIN], { stdio: "ignore" }); } catch {}
    throw new Error("Hyrja në ROY OS dështoi (email/fjalëkalim). Nisni sërish për t'i shkruar.");
  }
  const { data: orgId } = await db.rpc("bootstrap_org"); if (!orgId) throw new Error("Nuk u gjet organizata.");
  const since = val("--since") ? toDate(val("--since")) : new Date(Date.now() - 3 * 864e5);
  const { data: prods } = await db.from("products").select("name,product_variants(id,archived)").eq("org_id", orgId).eq("archived", false).limit(2000);
  const byName = new Map(); for (const p of prods ?? []) { const v = (p.product_variants ?? []).find((x) => !x.archived); if (v) byName.set(p.name.trim().toLowerCase(), v.id); }
  const out = { created: 0, updated: 0, skipped: 0, failed: [] }; const createdNow = new Set(); const seenAt = new Map(), prevStatus = new Map();
  async function returnOrder(orderId, status) {
    if (!["shipped", "delivered"].includes(status)) {
      const { error } = await db.rpc("set_order_status", { p_order: orderId, p_to: "shipped", p_note: "BringPlus" });
      if (error) return error.message;
    }
    const { data: items, error: ie } = await db.from("order_items").select("id,shipped_qty,returned_qty").eq("order_id", orderId);
    if (ie) return ie.message;
    let done = 0;
    for (const it of items ?? []) {
      const qty = (it.shipped_qty ?? 0) - (it.returned_qty ?? 0); if (qty <= 0) continue;
      const { error } = await db.rpc("receive_return", { p_item: it.id, p_qty: qty, p_sellable: true });
      if (error) return error.message; done++;
    }
    if (!done) { const { error } = await db.rpc("set_order_status", { p_order: orderId, p_to: "returned", p_note: "BringPlus: E kthyer" }); if (error) return error.message; }
    return null;
  }
  // BringPlus status + the time BringPlus set it (falls back to the older 2-argument function if the database isn't updated yet).
  async function setBring(orderId, p) {
    if (!globalThis.__noBSAt) {
      const r = await db.rpc("bring_set_status", { p_order: orderId, p_status: p.status, p_at: p.statusDate ? new Date(p.statusDate).toISOString() : null });
      if (!r.error || !/function|p_at|schema cache/i.test(r.error.message)) return r;
      globalThis.__noBSAt = true;
    }
    return db.rpc("bring_set_status", { p_order: orderId, p_status: p.status });
  }
  for (const p of parcels) {
    const flow = FLOW[p.status]; const key = `bring:${p.id}`;
    const sel = (cols) => db.from("orders").select(cols).eq("org_id", orgId).or(`idempotency_key.eq.${key},tracking_number.eq.${p.id}`).limit(1).maybeSingle();
    let { data: ex, error: xe } = globalThis.__noBS ? await sel("id,status") : await sel(globalThis.__noBSAt ? "id,status,bring_status" : "id,status,bring_status,bring_status_at");
    if (xe && /bring_status_at/.test(xe.message)) { globalThis.__noBSAt = true; ({ data: ex, error: xe } = await sel("id,status,bring_status")); }
    if (xe && /bring_status/.test(xe.message)) { globalThis.__noBS = true; ({ data: ex } = await sel("id,status")); }
    // BringPlus shows no date for final statuses (dorëzuar, kthyer, refuzim...), so the time we first SEE a status is what counts.
    if (ex && p.status) { const changed = !!ex.bring_status && ex.bring_status !== p.status; prevStatus.set(p.id, ex.bring_status ?? null);
      seenAt.set(p.id, changed ? new Date() : (ex.bring_status_at ? new Date(ex.bring_status_at) : null)); }
    if (ex && !DRY && !globalThis.__noBS && p.status && (ex.bring_status !== p.status || (!globalThis.__noBSAt && !ex.bring_status_at))) {
      const { error: be } = await setBring(ex.id, p);
      if (be && !globalThis.__bsWarn) { globalThis.__bsWarn = true; console.log("Kujdes: statusi i BringPlus nuk u ruajt: " + be.message); }
    }
    // Returned in BringPlus ("E kthyer"): mark the order returned in ROY OS and put the items back in stock,
    // so it stops counting as a sale. Uses the app's own return function (same as the "Kthim" button).
    if (ex && p.status === "E kthyer" && !["returned", "partially_returned", "cancelled"].includes(ex.status)) {
      console.log(`${DRY ? "[prova] " : ""}~ ${p.id} -> returned (E kthyer)`);
      if (!DRY) { const err = await returnOrder(ex.id, ex.status); if (err) out.failed.push([p.id, "kthimi: " + err]); else out.updated++; }
    }
    if (!flow) { out.skipped++; continue; }
    let id = ex?.id, status = ex?.status;
    // Keep "Realizuar sot" in step with BringPlus: a delivery dated today counts as today's, an older one is history.
    if (ex && ex.status === "delivered" && !DRY && p.statusDate && p.statusDate >= new Date(Date.now() - 2 * 864e5) && ((d) => d ? new Date(d).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) : "")(p.statusDate) === new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" })) {
      const dk = (d) => d ? new Date(d).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) : "";
      const { error: me } = await db.rpc("bring_mark_delivered", { p_order: ex.id, p_real: dk(p.statusDate) === dk(new Date()) });
      if (me && !globalThis.__mdWarn) { globalThis.__mdWarn = true; console.log("Kujdes: realizimi i sotëm nuk u shënua: " + me.message); }
    }
    if (!ex) {
      if (p.created && p.created < since) { out.skipped++; continue; }
      if (!p.name || !p.phone) { out.failed.push([p.id, "mungon emri ose telefoni"]); continue; }
      const pkey = p.product.trim().toLowerCase(); let variant = byName.get(pkey);
      console.log(`${DRY ? "[prova] " : ""}+ ${p.id}  ${p.name}  ${p.country}  ${p.total}€  ${p.product}${variant ? "" : " (produkt i ri — do të krijohet në Stok)"}  [${p.status}]`);
      if (DRY) { out.created++; createdNow.add(p.id); continue; }
      if (!variant) {
        const unit = Math.round(Math.max(0, p.total - p.cost) * 100) / 100;
        const { data: np, error: pe } = await db.from("products").insert({ org_id: orgId, name: p.product.trim(), category: "Unaze", purchase_price: 0, selling_price: unit, reorder_point: 0 }).select("id").single();
        if (pe || !np) { out.failed.push([p.id, "produkti nuk u krijua: " + (pe?.message ?? "")]); continue; }
        const { data: nv, error: ve } = await db.from("product_variants").insert({ org_id: orgId, product_id: np.id, label: "Standard" }).select("id").single();
        if (ve || !nv) { out.failed.push([p.id, "produkti u krijua pa variant: " + (ve?.message ?? "")]); continue; }
        variant = nv.id; byName.set(pkey, variant);
      }
      const { data, error } = await db.rpc("create_order", { p_org: orgId, p_order: { customer_name: p.name, phone: p.phone || "-", address: p.address || "-", city: p.city || "-", country: p.country, channel: "manual", status: "confirmed", courier: "BringPlus", tracking_number: p.id, courier_cost: p.cost, shipping_price: Math.min(p.cost, p.total), idempotency_key: key },
        p_items: [{ ...(variant ? { variant_id: variant } : { product_name: p.product }), quantity: 1, unit_price: Math.round(Math.max(0, p.total - p.cost) * 100) / 100 }] });
      if (error) { out.failed.push([p.id, error.message]); continue; } id = data; status = "confirmed"; if (!globalThis.__noBS) await setBring(id, p); out.created++; createdNow.add(p.id);
    }
    // move the order forward to match BringPlus (never backwards)
    for (const to of flow) {
      const rank = { confirmed: 0, processing: 0, packed: 0, shipped: 1, delivered: 2 }; if ((rank[status] ?? 9) >= rank[to]) continue;
      // A delivery counts as "today" on the Dashboard only when BringPlus dates it today; catch-up of older parcels is history.
      const dayKey = (d) => d ? new Date(d).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }) : "";
      const note = to === "delivered" && p.statusDate && dayKey(p.statusDate) !== dayKey(new Date()) ? "BringPlus (histori)" : "BringPlus";
      console.log(`${DRY ? "[prova] " : ""}~ ${p.id} -> ${to}`); if (DRY) { out.updated++; status = to; continue; }
      const { error } = await db.rpc("set_order_status", { p_order: id, p_to: to, p_note: note });
      if (error) { out.failed.push([p.id, error.message]); break; } status = to; out.updated++;
    }
  }
  // Parcels deleted in BringPlus: orders that came from BringPlus but are no longer in its list are cancelled here too (only if still unshipped).
  const present = new Set(parcels.map((p) => p.id)); const removedNotes = [];
  if (parcels.length >= 10) {
    const { data: mine } = await db.from("orders").select("id,status,tracking_number,idempotency_key,customer_name").eq("org_id", orgId).like("idempotency_key", "bring%").limit(5000);
    const gone = (mine ?? []).filter((o) => !["returned", "partially_returned"].includes(o.status) && !present.has(String(o.tracking_number ?? o.idempotency_key.replace(/^bringx?:/, ""))));
    if (gone.length > 3) removedNotes.push(["bring:many-gone", "BringPlus: shumë dërgesa mungojnë", `${gone.length} porosi nuk gjenden më te BringPlus. Nuk i fshij vetë (siguri). Kontrolloni listën.`, "warning"]);
    else for (const o of gone) {
      const id = String(o.tracking_number ?? o.idempotency_key.replace(/^bringx?:/, ""));
      const canCancel = ["confirmed", "pending_confirmation", "processing", "packed", "draft", "cancelled"].includes(o.status);
      console.log(`${DRY ? "[prova] " : ""}- ${id} ${o.customer_name}: fshirë te BringPlus${canCancel ? " -> fshihet edhe këtu" : " (e dërguar/dorëzuar, nuk fshihet vetë)"}`);
      if (canCancel && !DRY) { const { error } = await db.rpc("bring_delete_order", { p_order: o.id }); if (error) { out.failed.push([id, "fshirja: " + error.message]); continue; } out.updated++; }
      removedNotes.push([`bring:${id}:deleted`, `Fshirë te BringPlus: ${id} · ${o.customer_name}`, canCancel ? "Porosia u fshi edhe te ROY OS (stoku u lirua)." : `Porosia është "${o.status}" te ROY OS, prandaj nuk u fshi vetë. Kontrolloni.`, "warning"]);
    }
  }
  // Alerts: courier comments and problem statuses become notifications (bell + Njoftimet page). Each message is sent once.
  const DONE = new Set(["E dorëzuar", "E likuiduar", "Gati për likuidim"]);
  const hash = (t) => createHash("md5").update(t).digest("hex").slice(0, 10);
  let alerts = 0; const toPhone = [];
  async function emit(p, [k, title, body, sev]) {
    if (DRY) { console.log(`[prova] ! ${title} — ${body}`); return; }
    const { data: fresh, error } = await db.rpc("bring_notify", { p_org: orgId, p_key: k, p_title: title, p_body: body, p_sev: sev });
    if (error) { out.failed.push([p.id, "njoftimi: " + error.message]); return; }
    if (fresh) { alerts++; toPhone.push(`${title}\n${body}`); }
  }
  for (const p of parcels) {
    const who = `${p.id} · ${p.name}${p.city ? ", " + p.city : ""}`;
    const items = [];
    const at = p.statusDate ?? seenAt.get(p.id) ?? null;
    const recent = !!at && at >= since;
    if (createdNow.has(p.id)) items.push([`bring:${p.id}:new`, `Porosi e re: ${who}`, `${p.product} · ${p.total}€ · ${p.country}. U regjistrua te ROY OS.`, "info"]);
    // delivered: BringPlus' own delivery date if it shows one, else the moment we saw the parcel become delivered
    const prev = prevStatus.get(p.id);
    const deliveredRecent = p.deliveredDate ? p.deliveredDate >= since : recent && (p.status === "E dorëzuar" || (prev != null && !DONE.has(prev)));
    if (DONE.has(p.status) && deliveredRecent) items.push([`bring:${p.id}:s:dorezuar`, `Dorëzuar: ${who}`, `${p.product} · ${p.total}€ u dorëzua te klienti.`, "info"]);
    if (recent && /refuzuar/i.test(p.status)) items.push([`bring:${p.id}:s:refuzuar`, `Refuzuar: ${who}`, `Statusi: "${p.status}". ${p.product} · ${p.total}€. Telefoni: ${p.phone || "—"}.`, "critical"]);
    if (recent && p.status === "E kthyer") items.push([`bring:${p.id}:s:kthyer`, `Kthyer: ${who}`, "Dërgesa u kthye te ju sipas BringPlus. Kontrolloni porosinë.", "critical"]);
    if (DONE.has(p.status)) { for (const it of items) await emit(p, it); continue; }
    if (p.comment) items.push([`bring:${p.id}:c:${hash(p.comment)}`, `BringPlus: ${who}`, p.comment, "warning"]);
    if (p.status === "Problematike" || p.status === "Për refuzim") items.push([`bring:${p.id}:s:${p.status}`, `${p.status}: ${who}`, `Statusi në BringPlus është "${p.status}". Telefoni i klientit: ${p.phone || "—"}.`, "warning"]);
    for (const it of items) await emit(p, it);
  }
  // Payouts: tell the owner when a payout is created and when its status changes (e.g. "Pranuar nga shitësi" = money received).
  for (const q of payouts) {
    if (!q.status || !q.createdAt) continue;
    const fresh = q.createdAt >= addDaysLocal(new Date(), -14); if (!fresh && /pranuar/i.test(q.status)) continue;
    const sum = `${q.amount}${q.parcels ? " · " + q.parcels : ""}${q.period ? " · " + q.period : ""}`;
    const msg = /pranuar/i.test(q.status) ? [`payout:${q.id}:${q.status}`, `Pagesa ${q.id} u pranua`, `${sum}. Statusi: ${q.status}.`, "info"]
      : [`payout:${q.id}:${q.status}`, `Pagesë nga BringPlus (${q.id}): ${q.status}`, `${sum}.`, "info"];
    await emit({ id: "payout" + q.id }, msg);
  }
  for (const n of removedNotes) await emit({ id: n[0] }, n);
  // Evening summary on Telegram, once a day: the first sync (GitHub or Mac) after SUMMARY_HOUR sends it.
  const SUMMARY_HOUR = 21;
  const berlinHour = Number(new Date().toLocaleString("en-GB", { hour: "2-digit", hour12: false, timeZone: "Europe/Berlin" }));
  let testKey = ""; try { testKey = readFileSync(new URL("../summary-test.txt", import.meta.url), "utf8").trim().slice(0, 40); } catch {}
  if (!DRY && (berlinHour >= SUMMARY_HOUR || testKey)) {
    try { await dailySummary(testKey && berlinHour < SUMMARY_HOUR ? testKey : ""); } catch (e) { console.log("Kujdes: përmbledhja e ditës dështoi: " + e.message); }
  }
  // Weekly AI advice: every Monday after 08:00, once a week. The AI runs inside ROY OS (Vercel holds the Gemini key);
  // the sync only asks for it with the owner's own session and forwards it to Telegram.
  let weeklyTest = ""; try { weeklyTest = readFileSync(new URL("../weekly-test.txt", import.meta.url), "utf8").trim().slice(0, 40); } catch {}
  const berlinDow = new Date().toLocaleDateString("en-GB", { weekday: "short", timeZone: "Europe/Berlin" });
  if (!DRY && ((berlinDow === "Mon" && berlinHour >= 8) || weeklyTest)) {
    try { await weeklyAdvice(berlinDow === "Mon" && berlinHour >= 8 ? "" : weeklyTest); } catch (e) { console.log("Kujdes: këshilla e javës dështoi: " + e.message); }
  }
  // Monthly AI comparison: on the 1st after 09:00, the month that just ended vs the one before (once). AI runs inside ROY OS.
  let monthlyTest = ""; try { monthlyTest = readFileSync(new URL("../monthly-test.txt", import.meta.url), "utf8").trim().slice(0, 40); } catch {}
  const berlinDay = Number(new Date().toLocaleDateString("en-GB", { day: "numeric", timeZone: "Europe/Berlin" }));
  if (!DRY && ((berlinDay === 1 && berlinHour >= 9) || monthlyTest)) {
    try { await monthlyCompare(berlinDay === 1 && berlinHour >= 9 ? "" : monthlyTest); } catch (e) { console.log("Kujdes: krahasimi i muajve dështoi: " + e.message); }
  }
  async function monthlyCompare(test) {
    const [y, m] = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" }).split("-").map(Number);
    const ymOf = (yy, mm) => { const d = new Date(Date.UTC(yy, mm - 1, 1)); return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`; };
    // real run: last month vs the month before it; test: this month so far vs the same days of last month
    const month = test ? ymOf(y, m) : ymOf(y, m - 1), vs = test ? ymOf(y, m - 1) : ymOf(y, m - 2);
    const key = test ? `monthly-test:${test}` : `monthly:${month}`;
    const { data: done } = await db.from("notifications").select("id").eq("org_id", orgId).eq("dedupe_key", key).limit(1);
    if (done?.length) return;
    const { data: { session } } = await db.auth.getSession(); if (!session) throw new Error("pa sesion");
    const app = (CLOUD?.app || process.env.ROY_APP_URL || "https://roy-jewelry-os.vercel.app").replace(/\/$/, "");
    const r = await fetch(`${app}/api/ai/months`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}`, "Content-Type": "application/json" }, body: JSON.stringify({ month, vs }), signal: AbortSignal.timeout(70_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.text) throw new Error(j.error || `HTTP ${r.status}`);
    const title = `Krahasimi i muajve${test ? " (provë)" : ""}: ${j.a?.period ?? month} vs ${j.b?.period ?? vs}`;
    const { data: isNew, error } = await db.rpc("bring_notify", { p_org: orgId, p_key: key, p_title: title, p_body: String(j.text).slice(0, 1500), p_sev: "info" });
    if (error) throw new Error(error.message);
    if (isNew) { await tgSend(`📊 ${title}\n\n${j.text}`); console.log("Përmbledhja: krahasimi i muajve u dërgua."); }
  }
  async function weeklyAdvice(test) {
    const monday = new Date().toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const key = test ? `weekly-test:${test}` : `weekly:${monday}`;
    const { data: done } = await db.from("notifications").select("id").eq("org_id", orgId).eq("dedupe_key", key).limit(1);
    if (done?.length) return; // already sent this week (or this test)
    const { data: { session } } = await db.auth.getSession(); if (!session) throw new Error("pa sesion");
    const app = (CLOUD?.app || process.env.ROY_APP_URL || "https://roy-jewelry-os.vercel.app").replace(/\/$/, "");
    const r = await fetch(`${app}/api/ai/weekly`, { method: "POST", headers: { Authorization: `Bearer ${session.access_token}` }, signal: AbortSignal.timeout(70_000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || !j.text) throw new Error(j.error || `HTTP ${r.status}`);
    const label = new Date().toLocaleDateString("sq-AL", { day: "numeric", month: "long", timeZone: "Europe/Berlin" });
    const title = `Këshilla e javës${test ? " (provë)" : ""} · ${label}`;
    const { data: isNew, error } = await db.rpc("bring_notify", { p_org: orgId, p_key: key, p_title: title, p_body: String(j.text).slice(0, 1500), p_sev: "info" });
    if (error) throw new Error(error.message);
    if (isNew) { await tgSend(`🧠 ${title}\n\n${j.text}`); console.log("Përmbledhja: këshilla e javës u dërgua."); }
  }
  async function dailySummary(test) {
    const berlinDay = (d) => new Date(d).toLocaleDateString("sv-SE", { timeZone: "Europe/Berlin" });
    const localDay = (d) => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}` : ""; // BringPlus dates (no time)
    const today = berlinDay(new Date());
    const money = (v) => v.toLocaleString("de-DE", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
    const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
    const since30h = new Date(Date.now() - 30 * 3600e3).toISOString();
    // new parcels registered today in BringPlus
    const fresh = parcels.filter((p) => localDay(p.created) === today);
    // delivered today, counted exactly like the Dashboard card "Të dorëzuara sot"
    const { data: dl } = await db.from("order_status_history").select("order_id,note,created_at,orders!inner(total,status)").eq("org_id", orgId).eq("to_status", "delivered").gte("created_at", since30h).limit(2000);
    const delivered = new Map(); for (const h of dl ?? []) if (berlinDay(h.created_at) === today && h.note !== "BringPlus (histori)" && h.orders?.status !== "cancelled") delivered.set(h.order_id, Number(h.orders?.total ?? 0));
    // refused / returned today: the time the sync first saw that status
    const { data: st } = await db.from("orders").select("total,bring_status,bring_status_at").eq("org_id", orgId).not("bring_status", "is", null).gte("bring_status_at", since30h).limit(2000);
    const seenToday = (re) => (st ?? []).filter((o) => re.test(o.bring_status) && berlinDay(o.bring_status_at) === today);
    const refused = seenToday(/refuzuar/i), returned = seenToday(/^E kthyer$/i);
    // money BringPlus holds for you: delivered but not yet paid out (parcel value minus BringPlus' postage)
    const owed = parcels.filter((p) => p.status === "E dorëzuar" || p.status === "Gati për likuidim");
    const owedSum = sum(owed, (p) => Math.max(0, p.total - p.cost));
    const pending = payouts.filter((q) => q.status && !/pranuar/i.test(q.status));
    const count = (st2) => parcels.filter((p) => p.status === st2).length;
    const label = new Date().toLocaleDateString("sq-AL", { weekday: "long", day: "numeric", month: "long", timeZone: "Europe/Berlin" });
    const lines = [
      `🆕 Porosi të reja: ${fresh.length}${fresh.length ? ` · ${money(sum(fresh, (p) => p.total))}` : ""}`,
      `✅ Të dorëzuara: ${delivered.size}${delivered.size ? ` · ${money([...delivered.values()].reduce((a, b) => a + b, 0))}` : ""}`,
      `❌ Të refuzuara: ${refused.length}${refused.length ? ` · ${money(sum(refused, (o) => Number(o.total)))}` : ""}`,
      ...(returned.length ? [`↩️ Të kthyera: ${returned.length} · ${money(sum(returned, (o) => Number(o.total)))}`] : []),
      "",
      `🚚 Në shpërndarje tani: ${count("Në shpërndarje")}`,
      ...(count("Problematike") + count("Për refuzim") ? [`⚠️ Kërkojnë vëmendje: ${count("Problematike")} problematike, ${count("Për refuzim")} për refuzim`] : []),
      "",
      `💶 Te BringPlus (dorëzuara, ende pa u paguar): ${money(owedSum)} nga ${owed.length} dërgesa (afërsisht, pa postën)`,
      ...pending.map((q) => `   Pagesa ${q.id}: ${q.amount} · ${q.status}`),
    ];
    const title = test ? `Përmbledhja e ditës (provë) · ${label}` : `Përmbledhja e ditës · ${label}`;
    const { data: isNew, error } = await db.rpc("bring_notify", { p_org: orgId, p_key: test ? `summary-test:${test}` : `summary:${today}`, p_title: title, p_body: lines.join("\n"), p_sev: "info" });
    if (error) throw new Error(error.message);
    if (isNew) { await tgSend(`${title}\n\n${lines.join("\n")}`); console.log("Përmbledhja e ditës u dërgua."); }
  }
  if (alerts) console.log(`${alerts} njoftime të reja u shtuan te ROY OS.`);
  for (const t of toPhone.slice(0, 15)) await tgSend(t);
  if (toPhone.length > 15) await tgSend(`... dhe edhe ${toPhone.length - 15} njoftime të tjera te ROY OS.`);
  if (!DRY) await heartbeat(db, orgId, true, `${parcels.length} dërgesa · ${out.created} të reja · ${out.updated} statuse`);
  console.log(`\nPërfundoi${DRY ? " (provë, asgjë nuk u ndryshua)" : ""}: ${out.created} të reja, ${out.updated} statuse të përditësuara, ${out.skipped} të anashkaluara.`);
  if (out.failed.length) console.log("Probleme:", out.failed.map(([i, w]) => `${i}: ${w}`).join("; "));
}
// Sync health: recorded in ROY OS (Dashboard) and, when a sync starts failing or recovers, sent to Telegram.
const SOURCE = CLOUD ? "GitHub" : "Mac";
async function heartbeat(db, orgId, ok, message) {
  try {
    const { data: alert, error } = await db.rpc("sync_heartbeat", { p_org: orgId, p_source: SOURCE, p_ok: ok, p_message: message });
    if (error) return;
    if (alert) await tgSend(ok ? `ROY OS (${SOURCE}): sinkronizimi me BringPlus punon sërish.`
      : `ROY OS (${SOURCE}): sinkronizimi me BringPlus nuk po punon.\n${message}` + (/futur në BringPlus/.test(message) ? (CLOUD
        ? "\nSesioni i BringPlus në GitHub skadoi. Te Mac-u:  node scripts/bring-sync.mjs --login  pastaj  node scripts/bring-sync.mjs --export-cloud  dhe përditësoni sekretin ROY_CLOUD te GitHub."
        : "\nTe Mac-u:  node scripts/bring-sync.mjs --login") : ""));
  } catch {}
}
async function failedHeartbeat(message) {
  try {
    const { url, anon } = env(); const email = kc("email"), pass = email ? kc(email) : ""; if (!email || !pass) return; // never prompt here
    const db = createClient(url, anon, { auth: { persistSession: false } });
    if ((await db.auth.signInWithPassword({ email, password: pass })).error) return;
    const { data: orgId } = await db.rpc("bootstrap_org"); if (orgId) await heartbeat(db, orgId, false, message);
  } catch {}
}
main().catch(async (e) => {
  console.error("Gabim:", e.message);
  if (!DRY && !LOGIN && !/sinkronizim tjetër/.test(e.message)) await failedHeartbeat(e.message.split("\n")[0].slice(0, 250));
  process.exit(1);
});
