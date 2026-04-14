import { describe, it, expect } from "vitest";
import { createWeChatAcpAdapter } from "../../src/acp/index.js";

describe("WeChatAcpAdapter", () => {
  const makeAdapter = () =>
    createWeChatAcpAdapter({ baseUrl: "https://test.example.com" });

  it("has correct name", () => {
    expect(makeAdapter().name).toBe("wechat-acp");
  });

  it("has lockScope channel", () => {
    expect(makeAdapter().lockScope).toBe("channel");
  });

  it("has persistMessageHistory true", () => {
    expect(makeAdapter().persistMessageHistory).toBe(true);
  });

  describe("thread ID", () => {
    it("encodes DM thread ID", () => {
      const threadId = makeAdapter().encodeThreadId({
        type: "dm",
        conversationId: "user123",
        contextToken: "ctx456",
      });
      expect(threadId).toBe("wechat:dm:user123:ctx456");
    });

    it("encodes group thread ID", () => {
      const threadId = makeAdapter().encodeThreadId({
        type: "group",
        conversationId: "grp789",
        contextToken: "ctx111",
      });
      expect(threadId).toBe("wechat:group:grp789:ctx111");
    });

    it("decodes thread ID", () => {
      const decoded = makeAdapter().decodeThreadId("wechat:dm:user123:ctx456");
      expect(decoded).toEqual({
        type: "dm",
        conversationId: "user123",
        contextToken: "ctx456",
      });
    });

    it("extracts channel ID", () => {
      expect(
        makeAdapter().channelIdFromThreadId("wechat:dm:user123:ctx456"),
      ).toBe("wechat:dm:user123");
    });
  });

  describe("parseMessage", () => {
    it("converts DM raw message to SDK Message", () => {
      const adapter = makeAdapter();
      const raw = {
        messageId: 42,
        fromUserId: "user1",
        toUserId: "bot1",
        text: "Hello bot",
        createTime: 1700000000000,
        contextToken: "ctx1",
        media: [],
        raw: {},
      };

      const msg = adapter.parseMessage(raw);
      expect(msg.id).toBe("42");
      expect(msg.text).toBe("Hello bot");
      expect(msg.threadId).toBe("wechat:dm:user1:ctx1");
      expect(msg.author.userId).toBe("user1");
      expect(msg.author.isBot).toBe(false);
      expect(msg.isMention).toBe(true);
    });

    it("converts group message with groupId", () => {
      const adapter = makeAdapter();
      const raw = {
        messageId: 43,
        fromUserId: "user1",
        toUserId: "bot1",
        groupId: "grp_abc",
        text: "Hey bot",
        createTime: 1700000000000,
        contextToken: "ctx2",
        media: [],
        raw: {},
      };

      const msg = adapter.parseMessage(raw);
      expect(msg.threadId).toBe("wechat:group:grp_abc:ctx2");
      expect(msg.author.userId).toBe("user1");
      expect(msg.isMention).toBe(true);
    });

    it("handles ref_msg with text", () => {
      const adapter = makeAdapter();
      const raw = {
        messageId: 44,
        fromUserId: "user1",
        toUserId: "bot1",
        text: "My reply",
        createTime: 1700000000000,
        media: [],
        refMsg: { text: "Original message", title: "Quote" },
        raw: {},
      };

      const msg = adapter.parseMessage(raw);
      expect(msg.text).toBe("My reply");
      expect(msg.formatted.children[0]!.type).toBe("blockquote");
      expect(msg.formatted.children[1]!.type).toBe("paragraph");
    });

    it("handles ref_msg with media attachment", () => {
      const adapter = makeAdapter();
      const raw = {
        messageId: 45,
        fromUserId: "user1",
        toUserId: "bot1",
        text: "About this image",
        createTime: 1700000000000,
        media: [],
        refMsg: {
          title: "Image",
          mediaItem: {
            kind: "image" as const,
            encryptQueryParam: "param123",
            aesKey: "0123456789abcdef0123456789abcdef",
          },
        },
        raw: {},
      };

      const msg = adapter.parseMessage(raw);
      expect(msg.attachments).toHaveLength(1);
      expect(msg.attachments[0]!.type).toBe("image");
      expect(typeof msg.attachments[0]!.fetchData).toBe("function");
    });

    it("sets isMention true on all messages", () => {
      const adapter = makeAdapter();
      const raw = {
        messageId: 46,
        fromUserId: "user1",
        toUserId: "bot1",
        text: "test",
        createTime: Date.now(),
        media: [],
        raw: {},
      };
      expect(adapter.parseMessage(raw).isMention).toBe(true);
    });

    it("isMe is false for user messages after applyAccount sets botId correctly", () => {
      const adapter = makeAdapter();
      // Simulate applyAccount having run with botId = "ilink-bot-42", userId = "wechat-openid-xyz"
      (adapter as any).setBotUserId("ilink-bot-42");

      const userMsg = adapter.parseMessage({
        messageId: 99,
        fromUserId: "wechat-openid-xyz", // the QR scanner's OpenID — NOT the bot
        toUserId: "ilink-bot-42",
        text: "hi bot",
        createTime: Date.now(),
        media: [],
        raw: {},
      });
      expect(userMsg.author.isMe).toBe(false); // was wrongly true before this fix

      const botMsg = adapter.parseMessage({
        messageId: 100,
        fromUserId: "ilink-bot-42",
        toUserId: "wechat-openid-xyz",
        text: "hi user",
        createTime: Date.now(),
        media: [],
        raw: {},
      });
      expect(botMsg.author.isMe).toBe(true);
    });
  });

  describe("isDM", () => {
    it("returns true for DM thread", () => {
      expect(makeAdapter().isDM("wechat:dm:user123:ctx")).toBe(true);
    });

    it("returns false for group thread", () => {
      expect(makeAdapter().isDM("wechat:group:grp123:ctx")).toBe(false);
    });
  });
});
