---
"chat-adapter-wechat": patch
---

Fix isMe check using wrong identity — applyAccount now sets botUserId to account.botId (the iLink bot identity) instead of account.userId (the WeChat OpenID of the QR scanner), which caused all incoming user messages to be incorrectly flagged as bot-authored and dropped.
