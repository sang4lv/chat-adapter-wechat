import { describe, it, expect } from "vitest";

describe("package entrypoints", () => {
  it("exports createWeChatAcpAdapter from ./bot", async () => {
    const { createWeChatAcpAdapter } = await import("../src/acp/index.js");
    expect(typeof createWeChatAcpAdapter).toBe("function");
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example.com",
    });
    expect(adapter.name).toBe("wechat-acp");
    expect(adapter.lockScope).toBe("channel");
    expect(adapter.persistMessageHistory).toBe(true);
  });

  it("exports adapter classes from entrypoints", async () => {
    const acp = await import("../src/acp/index.js");
    expect(acp.WeChatAcpAdapter).toBeDefined();
  });
});

describe("end-to-end message flow (unit)", () => {
  it("parses ilink message → SDK message", async () => {
    const { createWeChatAcpAdapter } = await import("../src/acp/index.js");
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example.com",
    });

    const rawMsg = {
      messageId: 100,
      fromUserId: "wx_user_abc",
      toUserId: "wx_bot_123",
      text: "What is the weather?",
      createTime: Date.now(),
      media: [],
      raw: {},
    };

    const message = adapter.parseMessage(rawMsg);
    expect(message.id).toBe("100");
    expect(message.text).toBe("What is the weather?");
    expect(message.threadId).toBe("wechat:dm:wx_user_abc");
    expect(message.author.userId).toBe("wx_user_abc");
    expect(message.author.isBot).toBe(false);
    expect(message.formatted.type).toBe("root");
    expect(message.attachments).toHaveLength(0);
  });
});
