import { describe, it, expect } from "vitest";
import {
  encodeThreadId,
  decodeThreadId,
  channelIdFromThreadId,
  resolveThreadId,
} from "../../src/core/utils.js";

describe("encodeThreadId", () => {
  it("encodes DM without contextToken", () => {
    expect(
      encodeThreadId({ type: "dm", conversationId: "user123" })
    ).toBe("wechat:dm:user123");
  });

  it("encodes DM with contextToken", () => {
    expect(
      encodeThreadId({
        type: "dm",
        conversationId: "user123",
        contextToken: "ctx456",
      })
    ).toBe("wechat:dm:user123:ctx456");
  });

  it("encodes group without contextToken", () => {
    expect(
      encodeThreadId({ type: "group", conversationId: "grp789" })
    ).toBe("wechat:group:grp789");
  });

  it("encodes group with contextToken", () => {
    expect(
      encodeThreadId({
        type: "group",
        conversationId: "grp789",
        contextToken: "ctx111",
      })
    ).toBe("wechat:group:grp789:ctx111");
  });
});

describe("decodeThreadId", () => {
  it("decodes DM without contextToken", () => {
    expect(decodeThreadId("wechat:dm:user123")).toEqual({
      type: "dm",
      conversationId: "user123",
    });
  });

  it("decodes DM with contextToken", () => {
    expect(decodeThreadId("wechat:dm:user123:ctx456")).toEqual({
      type: "dm",
      conversationId: "user123",
      contextToken: "ctx456",
    });
  });

  it("decodes group", () => {
    expect(decodeThreadId("wechat:group:grp789:ctx111")).toEqual({
      type: "group",
      conversationId: "grp789",
      contextToken: "ctx111",
    });
  });

  it("throws on invalid prefix", () => {
    expect(() => decodeThreadId("slack:C123")).toThrow(
      "Invalid WeChat thread ID"
    );
  });

  it("throws on missing type segment", () => {
    expect(() => decodeThreadId("wechat:user123")).toThrow(
      "Invalid WeChat thread ID"
    );
  });

  it("throws on invalid type", () => {
    expect(() => decodeThreadId("wechat:channel:abc")).toThrow(
      "Invalid WeChat thread ID"
    );
  });
});

describe("channelIdFromThreadId", () => {
  it("strips contextToken from DM", () => {
    expect(channelIdFromThreadId("wechat:dm:user123:ctx456")).toBe(
      "wechat:dm:user123"
    );
  });

  it("strips contextToken from group", () => {
    expect(channelIdFromThreadId("wechat:group:grp789:ctx111")).toBe(
      "wechat:group:grp789"
    );
  });

  it("returns same for thread without contextToken", () => {
    expect(channelIdFromThreadId("wechat:dm:user123")).toBe(
      "wechat:dm:user123"
    );
  });
});

describe("resolveThreadId", () => {
  it("decodes a full thread ID", () => {
    expect(resolveThreadId("wechat:dm:user123:ctx")).toEqual({
      type: "dm",
      conversationId: "user123",
      contextToken: "ctx",
    });
  });

  it("treats raw string as DM userId", () => {
    expect(resolveThreadId("raw_user_id")).toEqual({
      type: "dm",
      conversationId: "raw_user_id",
    });
  });
});
