# chat-adapter-wechat — Design Spec

> Date: 2026-04-01
> Updated: 2026-04-01
> Status: Active

## 1. Purpose

A WeChat adapter for the Vercel Chat SDK, API-compatible with the `Adapter` interface from `@vercel/chat`. Enables AI agents to interact with users via WeChat using the same programming model as Slack, Discord, Telegram, etc.

Two distinct WeChat integration modes are supported:

| Mode | Entrypoint | API | Auth | Use Case |
|------|-----------|-----|------|----------|
| **ACP** | `./acp` | ilink bot API (`ilinkai.weixin.qq.com`) | QR code scan → bot token | Quick prototyping, personal bots via OpenClaw |
| **Bot** | `./bot` | Official dialog platform (`openaiapi.weixin.qq.com`) | APPID + Token + AESKey → AccessToken | Production chatbots registered on [chatbot.weixin.qq.com](https://chatbot.weixin.qq.com/) |

### ACP vs Bot

| Aspect | ACP (ilink/OpenClaw) | Bot (Official Dialog Platform) |
|--------|---------------------|-------------------------------|
| **Base URL** | `ilinkai.weixin.qq.com` | `openaiapi.weixin.qq.com` |
| **Auth** | QR scan → bearer token | APPID/Token/AESKey → md5 signature + AES-CBC encryption |
| **Message model** | Bidirectional polling (`getUpdates` + `sendMessage`) | Synchronous request-response (`/v2/bot/query`) |
| **Registration** | None — any WeChat account | Requires chatbot platform registration |
| **Message receive** | Long-poll `getUpdates` | Consumer provides messages (adapter wraps as query) |
| **Message send** | `sendMessage` API | Response from `/v2/bot/query` |
| **Media** | CDN upload/download with AES-128-ECB | Response may contain image/voice/video URLs |
| **Typing** | `sendTyping` API | N/A |
| **Encryption** | None (plaintext JSON + bearer token) | AES-256-CBC on request/response body |
| **Signing** | None | `md5(Token + timestamp + nonce + md5(body))` |

## 2. Package Structure

Single npm package: `chat-adapter-wechat`

Two entrypoints via `package.json` exports:

```json
{
  "exports": {
    ".": "./dist/index.js",
    "./acp": "./dist/acp/index.js",
    "./bot": "./dist/bot/index.js"
  }
}
```

Consumer imports:
```typescript
// All adapters from root
import { createWeChatAcpAdapter, createWeChatBotAdapter } from "chat-adapter-wechat";

// Or tree-shakeable sub-entrypoints
import { createWeChatAcpAdapter } from "chat-adapter-wechat/acp";
import { createWeChatBotAdapter } from "chat-adapter-wechat/bot";
```

Internal folder layout:
```
src/
  index.ts                        # re-exports all adapters
  core/
    base-adapter.ts               # WeChatBaseAdapter (abstract)
    format-converter.ts           # mdast <-> WeChat plain text
    media.ts                      # AES-ECB encrypt/decrypt, CDN upload/download
    crypto.ts                     # AES-256-CBC encrypt/decrypt, md5 signing (for bot mode)
    types.ts                      # Shared types, thread IDs, configs
    utils.ts                      # Common helpers
  acp/
    index.ts                      # exports createWeChatAcpAdapter
    acp-adapter.ts                # WeChatAcpAdapter extends WeChatBaseAdapter
    acp-client.ts                 # ilink HTTP API client (polling, send, media CDN)
    acp-types.ts                  # ilink-specific request/response types
  bot/
    index.ts                      # exports createWeChatBotAdapter
    bot-adapter.ts                # WeChatBotAdapter extends WeChatBaseAdapter
    bot-client.ts                 # Official dialog platform HTTP client
    bot-types.ts                  # Official API request/response types
```

## 3. Public API

### Factory Functions

```typescript
// acp/index.ts — OpenClaw/ilink mode (QR login, polling)
export function createWeChatAcpAdapter(config?: WeChatAcpAdapterConfig): WeChatAcpAdapter;

// bot/index.ts — Official dialog platform (APPID/Token/AESKey)
export function createWeChatBotAdapter(config?: WeChatBotAdapterConfig): WeChatBotAdapter;
```

### Configuration

```typescript
// Shared base config
interface WeChatBaseConfig {
  dataDir?: string;
  logger?: Logger;
}

// ACP mode (ilink/OpenClaw)
interface WeChatAcpAdapterConfig extends WeChatBaseConfig {
  baseUrl?: string;              // Default: https://ilinkai.weixin.qq.com
  cdnBaseUrl?: string;           // Default: https://novac2c.cdn.weixin.qq.com/c2c
  pollIntervalMs?: number;       // Default: 25000
  typingIntervalMs?: number;     // Default: 15000
  onQrCode?: (qr: { imageBase64: string; terminalAscii: string }) => void;
}

// Bot mode (Official Dialog Platform)
interface WeChatBotAdapterConfig extends WeChatBaseConfig {
  appId: string;                 // Required: APPID from chatbot platform
  token: string;                 // Required: Token for request signing
  aesKey: string;                // Required: AESKey for body encryption
  baseUrl?: string;              // Default: https://openaiapi.weixin.qq.com
  env?: "online" | "debug";     // Default: "online"
}

```

### Consumer Usage — ACP Mode

```typescript
import { Chat } from "chat";
import { createWeChatAcpAdapter } from "chat-adapter-wechat/acp";
import { createMemoryState } from "@chat-adapter/state-memory";

const wechat = createWeChatAcpAdapter({
  onQrCode: (qr) => console.log("Scan QR:", qr.imageBase64),
});

const chat = new Chat({
  adapters: { wechat },
  state: createMemoryState(),
  userName: "MyBot",
});

chat.onMention(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});

await chat.initialize();
```

### Consumer Usage — Bot Mode

```typescript
import { Chat } from "chat";
import { createWeChatBotAdapter } from "chat-adapter-wechat/bot";
import { createMemoryState } from "@chat-adapter/state-memory";

const wechat = createWeChatBotAdapter({
  appId: process.env.WECHAT_APP_ID!,
  token: process.env.WECHAT_TOKEN!,
  aesKey: process.env.WECHAT_AES_KEY!,
});

const chat = new Chat({
  adapters: { wechat },
  state: createMemoryState(),
  userName: "MyBot",
});

chat.onMention(async (thread, message) => {
  // Query the WeChat chatbot and relay the response
  await thread.post(`Bot says: ${message.text}`);
});

await chat.initialize();
```

## 4. Core Types

### Thread ID Encoding

```
ACP DM:    wechat:dm:{userId}:{contextToken}
ACP Group: wechat:group:{groupId}:{contextToken}
Bot:       wechat:bot:{userid}
```

```typescript
interface WeChatThreadId {
  type: "dm" | "group" | "bot";
  conversationId: string;
  contextToken?: string;
}
```

Channel ID (strips context token):
```
wechat:{type}:{conversationId}
```

### Raw Message Type

```typescript
interface WeChatRawMessage {
  messageId: number;
  fromUserId: string;
  toUserId: string;
  groupId?: string;
  messageType?: "text" | "image" | "voice" | "file" | "video";
  text: string;
  createTime: number;
  contextToken?: string;
  media: WeChatMediaItem[];
  refMsg?: WeChatRefMessage;
  raw: unknown;
}
```

---

## 5-10. ACP Mode (Implemented)

See existing implementation in `src/acp/`. Covers:
- QR code login with token persistence (§5)
- Message polling via `getUpdates` (§6)
- Message sending via `sendMessage` with text + images (§7)
- Media CDN upload/download with AES-128-ECB (§8)
- Streaming with typing heartbeat (§9)
- Typing indicators via `getConfig` + `sendTyping` (§10)

---

## 11. Bot Mode — Official Dialog Platform

### Architecture

The official dialog platform API (`/v2/bot/query`) is a **synchronous request-response** model — you send a user query, the pre-configured chatbot processes it, and returns an answer. This is fundamentally different from the ACP bidirectional messaging model.

As a Chat SDK adapter, the bot mode works as follows:
1. Consumer receives a user message (from any source)
2. Consumer calls `thread.post(message)` or the adapter's `postMessage()`
3. The adapter sends the message as a `/v2/bot/query` request
4. The chatbot platform processes the query against configured skills/intents
5. The response (text, image, voice, etc.) is returned to the consumer

### Authentication

Three credentials required (from [chatbot.weixin.qq.com](https://chatbot.weixin.qq.com/) platform):
- **APPID**: Robot identifier
- **Token**: For request signing
- **AESKey**: For AES-256-CBC body encryption

**Token exchange flow:**
1. `POST /v2/token` with `X-APPID` header + signature
2. Receive `access_token` (valid 2 hours)
3. Use `access_token` in `X-OPENAI-TOKEN` header for subsequent requests
4. Auto-refresh when expired

### Request Signing

All requests require:
```
sign = md5(Token + str(unix_timestamp) + nonce + md5(body))
```
- md5 output is lowercase hex
- GET requests have empty body for md5
- `nonce` is a random string (10-32 chars recommended)

### Body Encryption (AES-256-CBC)

Request bodies are encrypted before sending:
1. JSON-stringify the request body
2. Construct plaintext: `16-byte-random + 4-byte-length(network-order) + message + appid`
3. PKCS7 pad to 32-byte boundary
4. Encrypt with AES-256-CBC using the decoded AESKey
5. Base64-encode the ciphertext
6. Send with `Content-Type: text/plain`

**AESKey handling:**
- The 43-character AESKey needs `=` appended before Base64-decoding
- Decoded result is 32 bytes (AES-256 key)
- IV = first 16 bytes of the key

Response decryption follows the reverse process.

### Bot Client (`bot-client.ts`)

```typescript
class BotClient {
  constructor(config: { appId: string; token: string; aesKey: string; baseUrl: string });

  // Token management
  getAccessToken(): Promise<string>;   // auto-caches, auto-refreshes

  // Request signing
  sign(body: string, timestamp: number, nonce: string): string;

  // Body encryption/decryption
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;

  // Dialog query
  query(params: {
    query: string;
    userid?: string;
    userName?: string;
    env?: "online" | "debug";
  }): Promise<BotQueryResponse>;
}
```

### Bot Query Response Types

The `/v2/bot/query` response `data.answer` field can contain:

| Type | Format | Handling |
|------|--------|----------|
| Plain text | `string` | Return as-is |
| Text with links | `string` with `<a>` tags | Strip HTML, preserve URLs |
| Image | `{"image": {"url": "...", "name": "..."}}` | Convert to attachment |
| Voice (URL) | `{"voice": {"url": "...", "name": "..."}}` | Convert to attachment |
| Voice (media) | `{"voice": {"media_id": "..."}}` | Log warning (no direct URL) |
| Video (URL) | `{"video": {"url": "...", "title": "..."}}` | Convert to attachment |
| News/Articles | `{"news": {"articles": [...]}}` | Convert to card with links |
| Mini Program | `{"miniprogrampage": {...}}` | Convert to text with link |
| Streaming | `{"generate_url": "..."}` | Fetch SSE stream from URL |
| Combined | `{"multimsg": ["...", "..."]}` | Parse each sub-message |

### Bot Adapter Interface Compliance

| Method | Implementation |
|--------|---------------|
| `name` | `"wechat-bot"` |
| `lockScope` | `"channel"` |
| `persistMessageHistory` | `true` |
| `initialize(chat)` | Exchange APPID for AccessToken |
| `disconnect()` | Clear token cache |
| `parseMessage(raw)` | Parse bot query response into SDK Message |
| `postMessage(threadId, message)` | Send as `/v2/bot/query`, return response |
| `editMessage` | Throw `AdapterError` — not supported |
| `deleteMessage` | Throw `AdapterError` — not supported |
| `addReaction` / `removeReaction` | No-op |
| `fetchMessages` | Return from SDK history cache |
| `fetchThread(threadId)` | Return ThreadInfo |
| `encodeThreadId(data)` | `wechat:bot:{userid}` |
| `handleWebhook(request)` | No-op (not webhook-based) |
| `startTyping` | No-op (no typing API) |
| `renderFormatted(content)` | AST → plain text |
| `stream(threadId, textStream)` | Accumulate + query |
| `isDM(threadId)` | Always `true` for bot mode |

### Error Handling

| Code | Description | Error Type |
|------|-------------|------------|
| 110002 | Parameter error | `ValidationError` |
| 110003 | Content moderation failed | `AdapterError` |
| 210202 | No operation permission | `AuthenticationError` |
| 210205 | Rate limited / publishing | `AdapterRateLimitError` |
| 210106 | JSON parsing failure | `ValidationError` |
| 1110001 | Server internal error | `NetworkError` |
| HTTP 400 | Signature verification failure | `AuthenticationError` |

---

## 12-16. Shared Sections

These sections apply to all modes. See prior spec content for:
- Format conversion (§12)
- Error handling patterns (§13)
- State management (§14)
- Dependencies (§15)
- Testing strategy (§16)

---

## 17. Scope — What's Included

### v1 (Implemented)
- ACP mode (`createWeChatAcpAdapter`) — fully functional
- Text + image send/receive (ACP)
- QR code login with token persistence
- Typing indicators
- Message polling
- Media CDN upload/download with AES encryption
- Referenced message handling
- Group chat support
- `persistMessageHistory: true`
- Error handling with backoff and re-auth

### v2 (This iteration)
- Bot mode (`createWeChatBotAdapter`) — official dialog platform
- APPID/Token/AESKey authentication
- AES-256-CBC request/response encryption
- md5 request signing
- AccessToken auto-refresh
- Bot query with rich response type parsing
- Streaming via `generate_url`

### Future
- Voice/video send
- Official Account webhook mode

---

## 18. Group Chat Support

(ACP mode only — bot mode is always 1:1 query-response)

See existing §18 content for ACP group chat details:
- Thread ID: `wechat:group:{groupId}:{contextToken}`
- `isDM()` checks thread type prefix
- Reply routing: group_id as `to_user_id`
- Every message is a mention (ilink only delivers directed messages)
