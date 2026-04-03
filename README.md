# chat-adapter-wechat

WeChat adapter for the [Vercel Chat SDK](https://github.com/vercel/chat). Supports two integration modes:

- **ACP mode** (`chat-adapter-wechat/acp`) — connects via the ilink bot API (QR login, polling)
- **Bot mode** (`chat-adapter-wechat/bot`) — connects via the official dialog platform (APPID/Token/AESKey)

## Installation

```bash
npm install chat-adapter-wechat chat @chat-adapter/shared
```

## Usage

### ACP Mode (ilink)

```typescript
import { Chat } from "chat";
import { createWeChatAcpAdapter } from "chat-adapter-wechat/acp";
import { createMemoryState } from "@chat-adapter/state-memory";

const wechat = createWeChatAcpAdapter();

const chat = new Chat({
  adapters: { wechat },
  state: createMemoryState(),
  userName: "MyBot",
});

chat.onMention(async (thread, message) => {
  await thread.post(`You said: ${message.text}`);
});

await chat.initialize();
// Scan the QR code displayed in terminal to connect
```

### Bot Mode (Official Dialog Platform)

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
  // postMessage sends the user's text as a /v2/bot/query request
  // and returns the chatbot platform's response
  await thread.post(message.text);
});

await chat.initialize();
```

## Configuration

### ACP Mode

All options are optional — defaults are shown below.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `dataDir` | `string` | `~/.chat-adapter-wechat` | Directory for token and state persistence |
| `pollIntervalMs` | `number` | `25000` | Polling interval in milliseconds |
| `typingIntervalMs` | `number` | `15000` | Typing indicator heartbeat in milliseconds |
| `baseUrl` | `string` | `https://ilinkai.weixin.qq.com` | ilink API base URL |
| `cdnBaseUrl` | `string` | `https://novac2c.cdn.weixin.qq.com/c2c` | CDN base URL for media |
| `onQrCode` | `(qr: { imageBase64: string; terminalAscii: string }) => void` | — | Callback when a QR code is generated for login |
| `accountStorage` | `WeChatStorage<AccountData>` | — | Custom persistence for account credentials (replaces disk) |
| `stateStorage` | `WeChatStorage<PollState>` | — | Custom persistence for poll state (replaces disk) |
| `logger` | `Logger` | Console logger | Custom logger instance |

```typescript
createWeChatAcpAdapter({
  pollIntervalMs: 10000,
  onQrCode: (qr) => {
    console.log("QR image base64:", qr.imageBase64);
  },
  // Optional: custom storage instead of filesystem
  accountStorage: {
    load: async () => db.get("wechat-account"),
    save: async (data) => db.set("wechat-account", data),
  },
});
```

### Bot Mode

```typescript
createWeChatBotAdapter({
  appId: process.env.WECHAT_APP_ID!,   // Required — dialog platform app ID
  token: process.env.WECHAT_TOKEN!,     // Required — dialog platform token
  aesKey: process.env.WECHAT_AES_KEY!,  // Required — dialog platform AES key
  baseUrl: "https://openaiapi.weixin.qq.com", // Optional — API base URL
  env: "online",                        // Optional — "online" (default) or "debug"
});
```

## Supported Features

| Feature | ACP Mode | Bot Mode |
|---------|----------|----------|
| Text messages | Send + Receive | Query/Response |
| Image messages | Send + Receive | Response only |
| Typing indicators | Yes | No |
| Referenced messages | Yes | No |
| Message history | SDK-managed | SDK-managed |
| QR code login | Yes | N/A (token-based) |
| Group chat | Yes | N/A |

## Architecture

Single package with two entrypoints:

```
chat-adapter-wechat/acp  → createWeChatAcpAdapter()
chat-adapter-wechat/bot  → createWeChatBotAdapter()
```

Both modes share a common base adapter (`WeChatBaseAdapter`) that handles:
- Thread ID encoding/decoding (`wechat:{type}:{conversationId}:{contextToken}`)
- Message parsing (ilink format → Chat SDK `Message`)
- Format conversion (mdast ↔ plain text)
- AES-128-ECB media encryption/decryption
- CDN upload/download

## Contributing

This project uses [changesets](https://github.com/changesets/changesets) for versioning. When making changes:

1. Run `pnpm changeset` to describe your change and select a semver bump
2. Commit the generated changeset file with your code
3. On merge to `main`, a "Version Package" PR is automatically created
4. Merging that PR publishes to npm

## Reference Documentation

- [Vercel Chat SDK](https://github.com/vercel/chat)
- [WeChat ilink Bot API](docs/reference/wechat-ilink-bot-api.md) (local, gitignored)
- [WeChat Official Dialog API](docs/reference/wechat-official-api.md) (local, gitignored)

## License

MIT
