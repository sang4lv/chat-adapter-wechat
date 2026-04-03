#!/usr/bin/env npx tsx
/**
 * Development server for testing WeChat adapters end-to-end.
 *
 * Supports two modes:
 *   - ACP mode (default): QR login → poll messages → echo replies
 *   - Bot mode: APPID/Token/AESKey → query dialog platform
 *
 * Usage:
 *   # ACP mode (QR login)
 *   pnpm dev:server
 *
 *   # Bot mode (official dialog platform)
 *   WECHAT_MODE=bot WECHAT_APP_ID=xxx WECHAT_TOKEN=xxx WECHAT_AES_KEY=xxx pnpm dev:server
 *
 * Then open http://localhost:3000
 *
 * Environment variables:
 *   WECHAT_MODE           - "acp" (default) or "bot"
 *   PORT                  - Server port (default: 3000)
 *
 *   # ACP mode:
 *   WECHAT_BOT_TOKEN      - Skip QR login if you already have a token
 *   WECHAT_BOT_ID         - Bot ID (required if BOT_TOKEN is set)
 *   WECHAT_USER_ID        - User ID (required if BOT_TOKEN is set)
 *   WECHAT_BASE_URL       - ilink API base URL
 *   WECHAT_CDN_BASE_URL   - CDN base URL
 *
 *   # Bot mode:
 *   WECHAT_APP_ID         - APPID from chatbot.weixin.qq.com
 *   WECHAT_TOKEN          - Token for request signing
 *   WECHAT_AES_KEY        - AESKey for body encryption
 *   WECHAT_BOT_BASE_URL   - API base URL (default: https://openaiapi.weixin.qq.com)
 *   WECHAT_BOT_ENV        - "online" or "debug" (default: "online")
 */

import http from "node:http";
import QRCode from "qrcode";
import { IlinkClient } from "../src/acp/acp-client.js";
import { MessageItemType, MessageType } from "../src/acp/acp-types.js";
import type { IlinkMessage } from "../src/acp/acp-types.js";
import { BotClient } from "../src/bot/bot-client.js";

const PORT = Number(process.env.PORT) || 3000;
const MODE = (process.env.WECHAT_MODE || "acp") as "acp" | "bot";

// --- Shared State ---
let messageLog: Array<{ time: string; from: string; text: string }> = [];

// =====================================================================
// ACP MODE
// =====================================================================

const ACP_BASE_URL = process.env.WECHAT_BASE_URL || "https://ilinkai.weixin.qq.com";
const ACP_CDN_URL = process.env.WECHAT_CDN_BASE_URL || "https://novac2c.cdn.weixin.qq.com/c2c";

const acpClient = new IlinkClient({
  baseUrl: ACP_BASE_URL,
  cdnBaseUrl: ACP_CDN_URL,
  token: process.env.WECHAT_BOT_TOKEN || undefined,
});

let acpBotToken = process.env.WECHAT_BOT_TOKEN || "";
let acpBotId = process.env.WECHAT_BOT_ID || "";
let acpUserId = process.env.WECHAT_USER_ID || "";
let qrImageDataUrl = "";
let qrCode = "";
let acpLoginStatus = acpBotToken ? "logged_in" : "waiting";
let updatesBuf = "";
let contextTokens: Record<string, string> = {};
let lastMessageId = 0;
let pollingActive = false;

async function startQrLogin() {
  try {
    const qr = await acpClient.fetchQrCode();
    qrImageDataUrl = await QRCode.toDataURL(qr.qrcode_img_content, { width: 300, margin: 2 });
    qrCode = qr.qrcode;
    acpLoginStatus = "qr_ready";
    log("QR code fetched. Scan at http://localhost:" + PORT);
    pollQrStatus();
  } catch (err) {
    log(`QR fetch failed: ${err}`);
    acpLoginStatus = "error";
  }
}

async function pollQrStatus() {
  for (let i = 0; i < 60; i++) {
    if (acpLoginStatus === "logged_in") return;
    try {
      const status = await acpClient.pollQrStatus(qrCode);
      if (status.status === "confirmed") {
        acpBotToken = status.bot_token!;
        acpBotId = status.ilink_bot_id!;
        acpUserId = status.ilink_user_id!;
        acpClient.setToken(acpBotToken);
        acpLoginStatus = "logged_in";
        log(`Login successful! botId=${acpBotId} userId=${acpUserId}`);
        log(`Save for next time:`);
        log(`  WECHAT_BOT_TOKEN=${acpBotToken}`);
        log(`  WECHAT_BOT_ID=${acpBotId}`);
        log(`  WECHAT_USER_ID=${acpUserId}`);
        startAcpPolling();
        return;
      }
      if (status.status === "expired") {
        log("QR expired. Refreshing...");
        await startQrLogin();
        return;
      }
      if (status.status === "scaned") {
        acpLoginStatus = "scanned";
      }
    } catch (err) {
      log(`QR poll error: ${err}`);
    }
  }
  log("QR poll timed out");
}

async function startAcpPolling() {
  if (pollingActive) return;
  pollingActive = true;
  log("Polling for messages...");

  let failures = 0;
  while (pollingActive) {
    try {
      const result = await acpClient.getUpdates(updatesBuf, 25000);
      if (result.get_updates_buf) updatesBuf = result.get_updates_buf;
      for (const msg of result.msgs ?? []) await handleAcpMessage(msg);
      failures = 0;
    } catch (err) {
      failures++;
      const backoff = Math.min(1000 * 2 ** failures, 60000);
      log(`Poll error (retry in ${backoff}ms): ${err}`);
      await sleep(backoff);
    }
  }
}

async function handleAcpMessage(msg: IlinkMessage) {
  if (msg.message_type === MessageType.BOT) return;
  if (msg.message_id != null && msg.message_id <= lastMessageId) return;
  if (msg.message_id != null) lastMessageId = msg.message_id;

  const conversationKey = msg.group_id || msg.from_user_id || "";
  if (conversationKey && msg.context_token) contextTokens[conversationKey] = msg.context_token;

  let text = "";
  const mediaItems: string[] = [];
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) text += item.text_item.text;
    if (item.type === MessageItemType.IMAGE) mediaItems.push("[image]");
    if (item.type === MessageItemType.FILE) mediaItems.push(`[file: ${item.file_item?.file_name ?? "?"}]`);
    if (item.type === MessageItemType.VOICE) mediaItems.push("[voice]");
    if (item.type === MessageItemType.VIDEO) mediaItems.push("[video]");
  }

  const refSource = msg.ref_msg ?? msg.item_list?.[0]?.ref_msg;
  let refText = "";
  if (refSource) {
    const refContent = refSource.message_item?.text_item?.text || refSource.title || "";
    if (refContent) refText = ` [reply to: "${refContent}"]`;
  }

  const sender = msg.from_user_id ?? "unknown";
  const group = msg.group_id ? ` (group: ${msg.group_id})` : "";
  const mediaStr = mediaItems.length ? ` ${mediaItems.join(" ")}` : "";

  messageLog.push({ time: new Date().toISOString(), from: sender, text: `${text}${refText}${mediaStr}${group}` });
  log(`← [${sender}]${group}: ${text}${refText}${mediaStr}`);

  const replyTo = msg.group_id || msg.from_user_id || "";
  const ctx = contextTokens[replyTo] || msg.context_token || "";

  try {
    try {
      const config = await acpClient.getConfig(replyTo, ctx);
      if (config.typing_ticket) { await acpClient.sendTyping(replyTo, config.typing_ticket, 1); await sleep(500); }
    } catch { /* best effort */ }

    const reply = `Echo: ${text || "(media only)"}`;
    await acpClient.sendMessage({ toUserId: replyTo, text: reply, contextToken: ctx });
    log(`→ [bot]: ${reply}`);
    messageLog.push({ time: new Date().toISOString(), from: "bot", text: reply });
  } catch (err) {
    log(`Send error: ${err}`);
  }
}

// =====================================================================
// BOT MODE
// =====================================================================

const BOT_APP_ID = process.env.WECHAT_APP_ID || "";
const BOT_TOKEN = process.env.WECHAT_TOKEN || "";
const BOT_AES_KEY = process.env.WECHAT_AES_KEY || "";
const BOT_BASE_URL = process.env.WECHAT_BOT_BASE_URL || "https://openaiapi.weixin.qq.com";
const BOT_ENV = (process.env.WECHAT_BOT_ENV || "online") as "online" | "debug";

let botClient: BotClient | null = null;
let botLoginStatus = "waiting";
let botAppId = BOT_APP_ID;
let botTokenValue = BOT_TOKEN;
let botAesKey = BOT_AES_KEY;
let botError = "";

async function initBotMode() {
  if (!botAppId || !botTokenValue || !botAesKey) {
    botLoginStatus = "needs_credentials";
    log("Bot mode: waiting for credentials via web UI");
    return;
  }

  await connectBot(botAppId, botTokenValue, botAesKey);
}

async function connectBot(appId: string, token: string, aesKey: string) {
  botClient = new BotClient({
    appId,
    token,
    aesKey,
    baseUrl: BOT_BASE_URL,
  });

  try {
    log(`Exchanging APPID for AccessToken (appId=${appId})...`);
    await botClient.getAccessToken();
    botAppId = appId;
    botTokenValue = token;
    botAesKey = aesKey;
    botLoginStatus = "logged_in";
    botError = "";
    log(`Bot mode ready! appId=${appId} env=${BOT_ENV}`);
  } catch (err) {
    log(`Bot auth failed: ${err}`);
    botLoginStatus = "needs_credentials";
    botError = String(err);
    botClient = null;
  }
}

async function queryBot(queryText: string, userid?: string): Promise<string> {
  if (!botClient) throw new Error("Bot client not initialized");

  const response = await botClient.query({
    query: queryText,
    userid: userid || "dev-user",
    env: BOT_ENV,
  });

  const answer = response.data.answer;
  const status = response.data.status || "";
  const skill = response.data.skill_name || "";

  // Try to parse rich content
  let displayText = answer;
  try {
    const parsed = JSON.parse(answer);
    if (parsed.image?.url) displayText = `[Image: ${parsed.image.url}]`;
    else if (parsed.voice?.url) displayText = `[Voice: ${parsed.voice.url}]`;
    else if (parsed.video?.url) displayText = `[Video: ${parsed.video.url}]`;
    else if (parsed.news?.articles) displayText = parsed.news.articles.map((a: any) => `${a.title} (${a.url})`).join("\n");
    else if (parsed.generate_url) displayText = `[Streaming: ${parsed.generate_url}]`;
    else if (parsed.multimsg) displayText = parsed.multimsg.join("\n");
  } catch { /* plain text */ }

  // Strip HTML tags, convert <a> to text (url) format
  displayText = displayText
    .replace(/<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi, "$2 ($1)")
    .replace(/<[^>]+>/g, "");

  const meta = [status, skill].filter(Boolean).join(", ");
  return meta ? `${displayText} [${meta}]` : displayText;
}

// =====================================================================
// HTTP SERVER
// =====================================================================

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://localhost:${PORT}`);

  if (url.pathname === "/" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(MODE === "bot" ? renderBotPage() : renderAcpPage());
    return;
  }

  // Allow switching to bot mode via /bot path
  if (url.pathname === "/bot" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderBotPage());
    return;
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      mode: MODE,
      loginStatus: MODE === "bot" ? botLoginStatus : acpLoginStatus,
      botId: MODE === "bot" ? botAppId : acpBotId,
      userId: MODE === "bot" ? "" : acpUserId,
      messageCount: messageLog.length,
      messages: messageLog.slice(-50),
    }));
    return;
  }

  // Webhook endpoint for receiving messages from WeChat dialog platform
  if (url.pathname === "/webhook" && req.method === "POST") {
    const body = await readBody(req);
    try {
      log(`← [webhook] Raw: ${body.slice(0, 200)}`);

      let payload: any;
      // Body may be JSON with "encrypted" field
      try {
        const json = JSON.parse(body);
        if (json.encrypted && botClient && botAesKey) {
          // Decrypt using WXBizMsgCrypt
          const { wxDecrypt } = await import("../src/core/crypto.js");
          const { message } = wxDecrypt(json.encrypted, botAesKey);
          log(`← [webhook] Decrypted: ${message.slice(0, 200)}`);
          // Parse XML-like content (simple extraction)
          const userid = message.match(/<userid>(.*?)<\/userid>/)?.[1] || "";
          const content = message.match(/<content>(.*?)<\/content>/s)?.[1] || "";
          const from = message.match(/<from>(.*?)<\/from>/)?.[1] || "";
          const event = message.match(/<event>(.*?)<\/event>/)?.[1] || "";
          const kfstate = message.match(/<kfstate>(.*?)<\/kfstate>/)?.[1] || "";
          const channel = message.match(/<channel>(.*?)<\/channel>/)?.[1] || "";

          const msgContent = content.match(/<msg>(.*?)<\/msg>/s)?.[1] || content;
          const source = from === "0" ? "user" : from === "1" ? "bot" : "kefu";

          payload = { userid, content: msgContent, from: source, event, kfstate, channel };
        } else {
          payload = json;
        }
      } catch {
        // Plain text body
        payload = { raw: body };
      }

      const fromLabel = payload.from || "webhook";
      const text = payload.content || payload.raw || JSON.stringify(payload);

      messageLog.push({
        time: new Date().toISOString(),
        from: `${fromLabel}:${payload.userid || "?"}`,
        text,
      });
      log(`← [${fromLabel}] userid=${payload.userid || "?"}: ${text}`);
      if (payload.event) log(`   event=${payload.event} kfstate=${payload.kfstate} channel=${payload.channel}`);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errcode: 0, errmsg: "success" }));
    } catch (err) {
      log(`Webhook error: ${err}`);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ errcode: -1, errmsg: String(err) }));
    }
    return;
  }

  if (url.pathname === "/api/bot/connect" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { appId, token, aesKey } = JSON.parse(body);
      if (!appId || !token || !aesKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "appId, token, and aesKey are required" }));
        return;
      }
      await connectBot(appId, token, aesKey);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: botLoginStatus === "logged_in", error: botError }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  if (url.pathname === "/api/send" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { to, text } = JSON.parse(body);

      if (MODE === "bot") {
        // Bot mode: query the dialog platform
        log(`→ [query]: ${text}`);
        messageLog.push({ time: new Date().toISOString(), from: "user", text });

        const answer = await queryBot(text, to);
        log(`← [bot]: ${answer}`);
        messageLog.push({ time: new Date().toISOString(), from: "bot", text: answer });
      } else {
        // ACP mode: send message to WeChat user
        const ctx = contextTokens[to] || "";
        await acpClient.sendMessage({ toUserId: to, text, contextToken: ctx });
        log(`→ [bot → ${to}]: ${text}`);
        messageLog.push({ time: new Date().toISOString(), from: "bot", text });
      }

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: String(err) }));
    }
    return;
  }

  res.writeHead(404);
  res.end("Not found");
});

// --- ACP Pages ---

function renderAcpPage(): string {
  if (acpLoginStatus === "logged_in") {
    return renderDashboard("ACP", `OpenClaw bot <strong>${acpBotId}</strong>`, acpUserId);
  }
  return `<!DOCTYPE html>
<html><head><title>WeChat ACP - Login</title><meta charset="utf-8">
<style>body{font-family:system-ui;max-width:600px;margin:80px auto;text-align:center}img{border:4px solid #333;border-radius:12px}.status{margin-top:16px;color:#666}</style>
</head><body>
<h2>WeChat ACP Login</h2>
${qrImageDataUrl
  ? `<p>Scan this QR code with WeChat:</p><img src="${qrImageDataUrl}" width="300" height="300" style="border-radius:8px">`
  : `<p>Loading QR code...</p>`}
<div class="status" id="status">${acpLoginStatus}</div>
<script>setInterval(async()=>{const r=await fetch('/api/status');const d=await r.json();document.getElementById('status').textContent=d.loginStatus;if(d.loginStatus==='logged_in')location.reload()},2000)</script>
</body></html>`;
}

// --- Bot Pages ---

function renderBotPage(): string {
  if (botLoginStatus === "logged_in") {
    return renderDashboard("Bot", `Dialog Platform <strong>${botAppId}</strong> (${BOT_ENV})`, "");
  }
  return `<!DOCTYPE html>
<html><head><title>WeChat Bot - Connect</title><meta charset="utf-8">
<style>
  body{font-family:system-ui;max-width:500px;margin:60px auto;padding:0 20px}
  h2{text-align:center}
  .form{background:white;padding:24px;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,0.1)}
  label{display:block;margin-top:16px;font-weight:600;font-size:14px}
  input{width:100%;padding:8px;margin-top:4px;border:1px solid #ccc;border-radius:4px;font-family:monospace;font-size:13px;box-sizing:border-box}
  button{margin-top:20px;width:100%;padding:10px;background:#007bff;color:white;border:none;border-radius:4px;font-size:15px;cursor:pointer}
  button:hover{background:#0056b3}
  button:disabled{background:#ccc;cursor:not-allowed}
  .error{background:#f8d7da;color:#721c24;padding:10px;border-radius:4px;margin-top:12px;font-size:13px;display:none}
  .hint{font-size:12px;color:#666;margin-top:4px}
  .info{background:#e8f4fd;padding:12px;border-radius:4px;margin-bottom:16px;font-size:13px}
</style>
</head><body>
<h2>WeChat Bot Mode</h2>
<div class="info">
  Enter your credentials from <a href="https://chatbot.weixin.qq.com/" target="_blank">chatbot.weixin.qq.com</a>
  (Publishing Management &rarr; Application Binding &rarr; Open API)
</div>
<div class="form">
  <label>APPID</label>
  <input id="appId" placeholder="e.g. Gg8HejYTkUsEIlG" value="${botAppId}">
  <div class="hint">Robot identifier from the dialog platform</div>

  <label>Token</label>
  <input id="token" placeholder="e.g. YV78Pyj1VvqdNGpMJ1pHic0bIBOWMv" value="${botTokenValue}">
  <div class="hint">Used for request signing</div>

  <label>AESKey</label>
  <input id="aesKey" placeholder="e.g. q1Os1ZMe0nG28KUEx9lg3HjK7V5QyXvi212fzsgDqgz" value="${botAesKey}">
  <div class="hint">43-character key for AES-256-CBC encryption</div>

  <button id="btn" onclick="connect()">Connect</button>
  <div class="error" id="error"></div>
</div>
<script>
async function connect(){
  const btn=document.getElementById('btn');
  const err=document.getElementById('error');
  btn.disabled=true;btn.textContent='Connecting...';err.style.display='none';
  try{
    const res=await fetch('/api/bot/connect',{method:'POST',body:JSON.stringify({
      appId:document.getElementById('appId').value.trim(),
      token:document.getElementById('token').value.trim(),
      aesKey:document.getElementById('aesKey').value.trim(),
    })});
    const data=await res.json();
    if(data.ok){location.reload()}
    else{err.textContent=data.error||'Connection failed';err.style.display='block';btn.disabled=false;btn.textContent='Connect'}
  }catch(e){err.textContent=String(e);err.style.display='block';btn.disabled=false;btn.textContent='Connect'}
}
</script>
</body></html>`;
}

// --- Shared Dashboard ---

function renderDashboard(mode: string, identity: string, defaultRecipient: string): string {
  const isBot = mode === "Bot";
  return `<!DOCTYPE html>
<html><head><title>WeChat ${mode} Dev Server</title><meta charset="utf-8">
<style>
  body{font-family:system-ui;max-width:800px;margin:40px auto;padding:0 20px;background:#f5f5f5}
  .status{background:#d4edda;padding:12px;border-radius:8px;margin-bottom:20px}
  .mode-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:bold;margin-right:8px;${isBot ? "background:#007bff;color:white" : "background:#28a745;color:white"}}
  .log{background:white;border-radius:8px;padding:16px;font-family:monospace;font-size:13px;max-height:500px;overflow-y:auto}
  .log div{padding:4px 0;border-bottom:1px solid #eee}
  .in{color:#0066cc}.out{color:#28a745}
  .send-form{margin:20px 0;display:flex;gap:8px}
  .send-form input{flex:1;padding:8px;border:1px solid #ccc;border-radius:4px}
  .send-form button{padding:8px 16px;background:${isBot ? "#007bff" : "#28a745"};color:white;border:none;border-radius:4px;cursor:pointer}
  h3{margin-top:24px}
</style>
</head><body>
<h2><span class="mode-badge">${mode}</span>WeChat Dev Server</h2>
<div class="status">Connected: ${identity}</div>

<h3>${isBot ? "Query Bot" : "Send Message"}</h3>
<div class="send-form">
  ${isBot
    ? `<input id="to" type="hidden" value="dev-user"><input id="msg" placeholder="Ask the bot something..." style="flex:2">`
    : `<input id="to" placeholder="Recipient user/group ID" value="${defaultRecipient}"><input id="msg" placeholder="Message text">`
  }
  <button onclick="sendMsg()">${isBot ? "Query" : "Send"}</button>
</div>

<h3>${isBot ? "Query Log" : "Message Log"}</h3>
<div class="log" id="log">Loading...</div>

<script>
async function refresh(){
  const res=await fetch('/api/status');const data=await res.json();const log=document.getElementById('log');
  log.innerHTML=data.messages.map(m=>
    '<div class="'+(m.from==='bot'?'out':'in')+'">'
    +'<small>'+m.time.slice(11,19)+'</small> '
    +'<strong>'+m.from+':</strong> '+m.text+'</div>'
  ).join('')||'<div>No messages yet.</div>';
  log.scrollTop=log.scrollHeight;
}
async function sendMsg(){
  const to=document.getElementById('to').value;
  const text=document.getElementById('msg').value;
  if(!text)return;
  await fetch('/api/send',{method:'POST',body:JSON.stringify({to:to||'dev-user',text})});
  document.getElementById('msg').value='';
  setTimeout(refresh,500);
}
refresh();setInterval(refresh,2000);
</script>
</body></html>`;
}

// --- Helpers ---

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => resolve(body));
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// --- Start ---
server.listen(PORT, () => {
  console.log(`\n=== WeChat Dev Server (${MODE} mode) ===`);
  console.log(`http://localhost:${PORT}\n`);

  if (MODE === "bot") {
    initBotMode();
  } else {
    if (acpBotToken) {
      log("Using saved ACP credentials. Starting message polling...");
      startAcpPolling();
    } else {
      log("No ACP credentials. Starting QR login...");
      startQrLogin();
    }
  }
});
