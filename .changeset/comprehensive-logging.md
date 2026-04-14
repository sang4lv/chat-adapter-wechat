---
"chat-adapter-wechat": patch
---

Comprehensive logging across ACP and Bot adapters.

Both `IlinkClient` and `BotClient` now accept an optional `logger` and
log HTTP errors, rate limits, token refresh, CDN failures, and
decryption fallbacks. The ACP adapter logs message enqueue/drain
lifecycle, outbound sends, image uploads, typing failures, and
file-based persistence errors that were previously swallowed silently.
The Bot adapter logs outbound queries and disconnect. All logger
metadata passes raw error objects instead of `String(error)` to
preserve stack traces.
