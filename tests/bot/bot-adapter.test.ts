import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createWeChatBotAdapter } from "../../src/bot/index.js";
import { BotClient } from "../../src/bot/bot-client.js";

const TEST_CONFIG = {
  appId: "TestAppId123",
  token: "TestToken456",
  aesKey: "q1Os1ZMe0nG28KUEx9lg3HjK7V5QyXvi212fzsgDqgz",
  baseUrl: "https://test.example.com",
};

describe("WeChatBotAdapter", () => {
  it("has correct name", () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    expect(adapter.name).toBe("wechat-bot");
  });

  it("has lockScope channel", () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    expect(adapter.lockScope).toBe("channel");
  });

  it("has persistMessageHistory true", () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    expect(adapter.persistMessageHistory).toBe(true);
  });

  it("isDM always true for bot mode", () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    expect(adapter.isDM("wechat:dm:user1")).toBe(true);
  });

  it("unsupported operations throw", async () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    await expect(adapter.editMessage()).rejects.toThrow();
    await expect(adapter.deleteMessage()).rejects.toThrow();
  });

  it("addReaction/removeReaction are no-ops", async () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    await expect(adapter.addReaction()).resolves.toBeUndefined();
    await expect(adapter.removeReaction()).resolves.toBeUndefined();
  });
});

describe("BotClient with mocked fetch", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe("getAccessToken", () => {
    it("exchanges APPID for access token", async () => {
      const client = new BotClient(TEST_CONFIG);

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: "success",
            request_id: "test",
            data: { access_token: "new_token_abc" },
          }),
          { status: 200 }
        )
      );

      const token = await client.getAccessToken();
      expect(token).toBe("new_token_abc");

      // Verify request
      const [url, opts] = mockFetch.mock.calls[0]!;
      expect(url).toBe("https://test.example.com/v2/token");
      expect(opts.method).toBe("POST");
      expect(opts.headers["X-APPID"]).toBe("TestAppId123");
      expect(opts.headers["sign"]).toBeDefined();
      expect(opts.headers["timestamp"]).toBeDefined();
      expect(opts.headers["nonce"]).toBeDefined();
    });

    it("caches token on subsequent calls", async () => {
      const client = new BotClient(TEST_CONFIG);

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: "success",
            request_id: "test",
            data: { access_token: "cached_token" },
          }),
          { status: 200 }
        )
      );

      const token1 = await client.getAccessToken();
      const token2 = await client.getAccessToken();
      expect(token1).toBe("cached_token");
      expect(token2).toBe("cached_token");
      expect(mockFetch).toHaveBeenCalledTimes(1); // only one HTTP call
    });

    it("throws AuthenticationError on HTTP 400", async () => {
      const client = new BotClient(TEST_CONFIG);

      mockFetch.mockResolvedValueOnce(
        new Response("Bad Request", { status: 400 })
      );

      await expect(client.getAccessToken()).rejects.toThrow("Signature");
    });
  });

  describe("query", () => {
    it("sends encrypted query and decrypts response", async () => {
      const client = new BotClient(TEST_CONFIG);

      // First call: getAccessToken
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: "success",
            request_id: "t1",
            data: { access_token: "token_xyz" },
          }),
          { status: 200 }
        )
      );

      // Second call: query — return plain JSON (some implementations don't encrypt response)
      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: "success",
            request_id: "t2",
            data: {
              answer: "Hello!",
              answer_type: "text",
              skill_name: "greeting",
              status: "FAQ",
            },
          }),
          { status: 200 }
        )
      );

      const result = await client.query({ query: "Hi" });
      expect(result.data.answer).toBe("Hello!");
      expect(result.data.status).toBe("FAQ");

      // Verify query request
      const [url, opts] = mockFetch.mock.calls[1]!;
      expect(url).toBe("https://test.example.com/v2/bot/query");
      expect(opts.headers["X-OPENAI-TOKEN"]).toBe("token_xyz");
      expect(opts.headers["X-APPID"]).toBe("TestAppId123");
      expect(opts.headers["Content-Type"]).toBe("text/plain");
      // Body should be encrypted (base64)
      expect(typeof opts.body).toBe("string");
      expect(opts.body).not.toContain("Hi"); // encrypted, not plaintext
    });

    it("throws AdapterRateLimitError on error code 210205", async () => {
      const client = new BotClient(TEST_CONFIG);

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 0,
            msg: "success",
            request_id: "t1",
            data: { access_token: "token" },
          }),
          { status: 200 }
        )
      );

      mockFetch.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            code: 210205,
            msg: "rate limited",
            request_id: "t2",
            data: {},
          }),
          { status: 200 }
        )
      );

      await expect(client.query({ query: "test" })).rejects.toThrow(
        "Rate limit"
      );
    });
  });
});

describe("bot adapter response parsing", () => {
  const originalFetch = globalThis.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    globalThis.fetch = mockFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockBotResponse(answer: string) {
    // Token call
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "success",
          request_id: "t1",
          data: { access_token: "tok" },
        }),
        { status: 200 }
      )
    );
    // Query call
    mockFetch.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          code: 0,
          msg: "success",
          request_id: "t2",
          data: { answer, answer_type: "text", status: "FAQ" },
        }),
        { status: 200 }
      )
    );
  }

  it("handles plain text answer", async () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    mockBotResponse("Hello world");

    const result = await adapter.postMessage("wechat:dm:user1", "Hi");
    expect(result.raw.text).toBe("Hello world");
  });

  it("handles text with HTML links", async () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    mockBotResponse('Visit <a href="https://example.com">our site</a> now');

    const result = await adapter.postMessage("wechat:dm:user1", "help");
    expect(result.raw.text).toBe("Visit our site (https://example.com) now");
  });

  it("handles image answer", async () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    mockBotResponse(JSON.stringify({
      image: { url: "https://img.example.com/pic.jpg", name: "photo" },
    }));

    const result = await adapter.postMessage("wechat:dm:user1", "show image");
    expect(result.raw.text).toBe("photo");
  });

  it("handles news answer", async () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    mockBotResponse(JSON.stringify({
      news: {
        articles: [
          { title: "Article 1", url: "https://example.com/1" },
          { title: "Article 2", url: "https://example.com/2" },
        ],
      },
    }));

    const result = await adapter.postMessage("wechat:dm:user1", "news");
    expect(result.raw.text).toContain("Article 1");
    expect(result.raw.text).toContain("Article 2");
  });

  it("handles multimsg answer", async () => {
    const adapter = createWeChatBotAdapter(TEST_CONFIG);
    mockBotResponse(JSON.stringify({
      multimsg: [
        "Hello",
        JSON.stringify({ image: { url: "https://img.example.com/a.jpg", name: "pic" } }),
      ],
    }));

    const result = await adapter.postMessage("wechat:dm:user1", "combo");
    expect(result.raw.text).toContain("Hello");
    expect(result.raw.text).toContain("pic");
  });
});
