#!/usr/bin/env npx tsx
/**
 * Development server for testing WeChat adapters end-to-end.
 * Written as a consumer of the chat-adapter-wechat public API.
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
import { ConsoleLogger } from "chat";
import type { ChatInstance, QueueEntry, StateAdapter } from "chat";
import {
  createWeChatAcpAdapter,
  createWeChatBotAdapter,
} from "../src/index.js";
import type {
  WeChatAcpAdapter,
  WeChatBotAdapter,
  WeChatRawMessage,
  AccountData,
} from "../src/index.js";

// --- Config ---

const PORT = Number(process.env.PORT) || 3000;
const MODE = (process.env.WECHAT_MODE || "acp") as "acp" | "bot";
const BOT_ENV = (process.env.WECHAT_BOT_ENV || "online") as "online" | "debug";

// --- Shared State ---

const messageLog: Array<{ time: string; from: string; text: string }> = [];

// =====================================================================
// INFRASTRUCTURE — minimal ChatInstance for the dev server
// =====================================================================

function createInMemoryState(): StateAdapter {
  const queues = new Map<string, QueueEntry[]>();
  return {
    enqueue: async (key: string, entry: QueueEntry, maxSize: number) => {
      const q = queues.get(key) ?? [];
      q.push(entry);
      while (q.length > maxSize) q.shift();
      queues.set(key, q);
      return q.length;
    },
    dequeue: async (key: string) => queues.get(key)?.shift() ?? null,
    queueDepth: async (key: string) => queues.get(key)?.length ?? 0,
  } as StateAdapter;
}

function createDevChat(
  onMessage: (adapter: WeChatAcpAdapter | WeChatBotAdapter, threadId: string, raw: WeChatRawMessage) => void,
): ChatInstance {
  const logger = new ConsoleLogger("info").child("dev-server");
  const state = createInMemoryState();
  return {
    getLogger: () => logger,
    getState: () => state,
    getUserName: () => "dev-server",
    handleIncomingMessage: async () => {},
    processMessage: (adapter: unknown, threadId: string, message: unknown) => {
      const msg = message as { raw: WeChatRawMessage };
      onMessage(adapter as WeChatAcpAdapter | WeChatBotAdapter, threadId, msg.raw);
    },
    processAction: () => {},
    processAppHomeOpened: () => {},
    processAssistantContextChanged: () => {},
    processAssistantThreadStarted: () => {},
    processMemberJoinedChannel: () => {},
    processModalClose: () => {},
    processModalSubmit: async () => undefined,
    processReaction: () => {},
    processSlashCommand: () => {},
  } as ChatInstance;
}

// =====================================================================
// ACP MODE
// =====================================================================

let acpAdapter: WeChatAcpAdapter | null = null;
let acpLoginStatus = "waiting";
let qrImageDataUrl = "";

async function initAcpMode() {
  const hasEnvCredentials =
    process.env.WECHAT_BOT_TOKEN &&
    process.env.WECHAT_BOT_ID &&
    process.env.WECHAT_USER_ID;

  const chat = createDevChat((adapter, threadId, raw) => {
    const text = raw.text || "";
    const mediaLabels = raw.media.map((m) => `[${m.kind}]`).join(" ");
    const group = raw.groupId ? ` (group: ${raw.groupId})` : "";

    messageLog.push({
      time: new Date().toISOString(),
      from: raw.fromUserId,
      text: `${text}${mediaLabels}${group}`,
    });
    log(`← [${raw.fromUserId}]${group}: ${text} ${mediaLabels}`);

    // Echo reply — include media JSON so you can inspect CDN payloads
    const mediaDump = raw.media.length
      ? `\n\nMedia:\n${JSON.stringify(raw.media, null, 2)}`
      : "";
    const reply = `Echo: ${text || "(media only)"}${mediaDump}`;

    adapter
      .postMessage(threadId, reply)
      .then(() => {
        log(`→ [bot]: ${reply}`);
        messageLog.push({ time: new Date().toISOString(), from: "bot", text: reply });
      })
      .catch((err) => log(`Send error: ${err}`));
  });

  acpAdapter = createWeChatAcpAdapter({
    baseUrl: process.env.WECHAT_BASE_URL,
    cdnBaseUrl: process.env.WECHAT_CDN_BASE_URL,
    onQrCode: async (qr) => {
      qrImageDataUrl = await QRCode.toDataURL(qr.imageBase64, {
        width: 300,
        margin: 2,
      });
      acpLoginStatus = "qr_ready";
      log("QR code ready. Scan at http://localhost:" + PORT);
    },
    accountStorage: {
      async load(): Promise<AccountData | null> {
        if (hasEnvCredentials) {
          log("Using credentials from environment variables");
          return {
            botToken: process.env.WECHAT_BOT_TOKEN!,
            botId: process.env.WECHAT_BOT_ID!,
            userId: process.env.WECHAT_USER_ID!,
            baseUrl:
              process.env.WECHAT_BASE_URL ??
              "https://ilinkai.weixin.qq.com",
            savedAt: Date.now(),
          };
        }
        return null;
      },
      async save(account: AccountData) {
        log("Login successful! Set these env vars to skip QR next time:");
        log(`  WECHAT_BOT_TOKEN=${account.botToken}`);
        log(`  WECHAT_BOT_ID=${account.botId}`);
        log(`  WECHAT_USER_ID=${account.userId}`);
      },
    },
  });

  try {
    await acpAdapter.initialize(chat);
    acpLoginStatus = "logged_in";
    log(
      `ACP adapter ready — botId=${acpAdapter.userName} userId=${acpAdapter.botUserId}`,
    );
  } catch (err) {
    log(`ACP initialization failed: ${err}`);
    acpLoginStatus = "error";
  }
}

// =====================================================================
// BOT MODE
// =====================================================================

let botAdapter: WeChatBotAdapter | null = null;
let botLoginStatus = "waiting";
let botAppId = process.env.WECHAT_APP_ID || "";
let botError = "";

async function initBotMode() {
  const appId = process.env.WECHAT_APP_ID || "";
  const token = process.env.WECHAT_TOKEN || "";
  const aesKey = process.env.WECHAT_AES_KEY || "";

  if (!appId || !token || !aesKey) {
    botLoginStatus = "needs_credentials";
    log("Bot mode: waiting for credentials via web UI");
    return;
  }

  await connectBot(appId, token, aesKey);
}

async function connectBot(appId: string, token: string, aesKey: string) {
  // Bot mode doesn't receive inbound messages — the consumer initiates queries
  const chat = createDevChat(() => {});

  const adapter = createWeChatBotAdapter({
    appId,
    token,
    aesKey,
    baseUrl: process.env.WECHAT_BOT_BASE_URL,
    env: BOT_ENV,
  });

  try {
    log(`Verifying credentials (appId=${appId})...`);
    await adapter.initialize(chat);
    botAdapter = adapter;
    botAppId = appId;
    botLoginStatus = "logged_in";
    botError = "";
    log(`Bot mode ready! appId=${appId} env=${BOT_ENV}`);
  } catch (err) {
    log(`Bot auth failed: ${err}`);
    botLoginStatus = "needs_credentials";
    botError = String(err);
  }
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

  if (url.pathname === "/bot" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(renderBotPage());
    return;
  }

  if (url.pathname === "/api/status" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        mode: MODE,
        loginStatus: MODE === "bot" ? botLoginStatus : acpLoginStatus,
        botId: MODE === "bot" ? botAppId : acpAdapter?.userName ?? "",
        userId: MODE === "bot" ? "" : acpAdapter?.botUserId ?? "",
        messageCount: messageLog.length,
        messages: messageLog.slice(-50),
      }),
    );
    return;
  }

  if (url.pathname === "/api/bot/connect" && req.method === "POST") {
    const body = await readBody(req);
    try {
      const { appId, token, aesKey } = JSON.parse(body);
      if (!appId || !token || !aesKey) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({ error: "appId, token, and aesKey are required" }),
        );
        return;
      }
      await connectBot(appId, token, aesKey);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: botLoginStatus === "logged_in",
          error: botError,
        }),
      );
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
        if (!botAdapter) throw new Error("Bot not connected");
        log(`→ [query]: ${text}`);
        messageLog.push({ time: new Date().toISOString(), from: "user", text });

        const response = await botAdapter.postMessage(
          to || "dev-user",
          text,
        );
        const answer = (response.raw as WeChatRawMessage).text;
        log(`← [bot]: ${answer}`);
        messageLog.push({
          time: new Date().toISOString(),
          from: "bot",
          text: answer,
        });
      } else {
        if (!acpAdapter) throw new Error("ACP adapter not ready");
        await acpAdapter.postMessage(to, text);
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

// =====================================================================
// HTML PAGES
// =====================================================================

function renderAcpPage(): string {
  if (acpLoginStatus === "logged_in") {
    return renderDashboard(
      "ACP",
      `OpenClaw bot <strong>${acpAdapter?.userName ?? "?"}</strong>`,
      acpAdapter?.botUserId ?? "",
    );
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

function renderBotPage(): string {
  if (botLoginStatus === "logged_in") {
    return renderDashboard(
      "Bot",
      `Dialog Platform <strong>${botAppId}</strong> (${BOT_ENV})`,
      "",
    );
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
  <input id="appId" placeholder="e.g. Gg8HejYTkUsEIlG" value="${process.env.WECHAT_APP_ID || ""}">
  <div class="hint">Robot identifier from the dialog platform</div>

  <label>Token</label>
  <input id="token" placeholder="e.g. YV78Pyj1VvqdNGpMJ1pHic0bIBOWMv" value="${process.env.WECHAT_TOKEN || ""}">
  <div class="hint">Used for request signing</div>

  <label>AESKey</label>
  <input id="aesKey" placeholder="e.g. q1Os1ZMe0nG28KUEx9lg3HjK7V5QyXvi212fzsgDqgz" value="${process.env.WECHAT_AES_KEY || ""}">
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

function renderDashboard(
  mode: string,
  identity: string,
  defaultRecipient: string,
): string {
  const isBot = mode === "Bot";
  return `<!DOCTYPE html>
<html><head><title>WeChat ${mode} Dev Server</title><meta charset="utf-8">
<style>
  body{font-family:system-ui;max-width:800px;margin:40px auto;padding:0 20px;background:#f5f5f5}
  .status{background:#d4edda;padding:12px;border-radius:8px;margin-bottom:20px}
  .mode-badge{display:inline-block;padding:2px 8px;border-radius:4px;font-size:12px;font-weight:bold;margin-right:8px;${isBot ? "background:#007bff;color:white" : "background:#28a745;color:white"}}
  .log{background:white;border-radius:8px;padding:16px;font-family:monospace;font-size:13px;max-height:500px;overflow-y:auto;white-space:pre-wrap;word-break:break-all}
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
    : `<input id="to" placeholder="Recipient user/group ID" value="${defaultRecipient}"><input id="msg" placeholder="Message text">`}
  <button onclick="sendMsg()">${isBot ? "Query" : "Send"}</button>
</div>

<h3>${isBot ? "Query Log" : "Message Log"}</h3>
<div class="log" id="log">Loading...</div>

<script>
function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
async function refresh(){
  const res=await fetch('/api/status');const data=await res.json();const log=document.getElementById('log');
  log.innerHTML=data.messages.map(m=>
    '<div class="'+(m.from==='bot'?'out':'in')+'">'
    +'<small>'+m.time.slice(11,19)+'</small> '
    +'<strong>'+esc(m.from)+':</strong> '+esc(m.text)+'</div>'
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

// =====================================================================
// HELPERS
// =====================================================================

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on("end", () => resolve(body));
  });
}

function log(msg: string) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
}

// =====================================================================
// STARTUP & SHUTDOWN
// =====================================================================

server.listen(PORT, () => {
  console.log(`\n=== WeChat Dev Server (${MODE} mode) ===`);
  console.log(`http://localhost:${PORT}\n`);

  if (MODE === "bot") {
    initBotMode();
  } else {
    initAcpMode();
  }
});

process.on("SIGINT", async () => {
  log("Shutting down...");
  await acpAdapter?.disconnect().catch(() => {});
  await botAdapter?.disconnect().catch(() => {});
  server.close();
  process.exit(0);
});
