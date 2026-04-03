import { describe, it, expect, beforeEach } from "vitest";
import { IlinkClient } from "../../src/acp/acp-client.js";

describe("IlinkClient", () => {
  let client: IlinkClient;

  beforeEach(() => {
    client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "test-token",
    });
  });

  describe("buildHeaders", () => {
    it("includes required headers", () => {
      const headers = client.buildHeaders("{}");
      expect(headers["Content-Type"]).toBe("application/json");
      expect(headers["AuthorizationType"]).toBe("ilink_bot_token");
      expect(headers["Authorization"]).toBe("Bearer test-token");
      expect(headers["X-WECHAT-UIN"]).toBeDefined();
    });
  });

  describe("buildSendMessageBody", () => {
    it("builds text-only message", () => {
      const body = client.buildSendMessageBody({
        toUserId: "user1",
        text: "hello",
        contextToken: "ctx1",
      });
      expect(body.msg.to_user_id).toBe("user1");
      expect(body.msg.message_type).toBe(2);
      expect(body.msg.message_state).toBe(2);
      expect(body.msg.item_list).toHaveLength(1);
      expect(body.msg.item_list![0]!.type).toBe(1);
      expect(body.msg.item_list![0]!.text_item?.text).toBe("hello");
      expect(body.msg.context_token).toBe("ctx1");
    });

    it("builds text + image message", () => {
      const body = client.buildSendMessageBody({
        toUserId: "user1",
        text: "caption",
        contextToken: "ctx1",
        images: [
          {
            encryptQueryParam: "param1",
            aesKeyB64: "key1",
            ciphertextSize: 1024,
          },
        ],
      });
      expect(body.msg.item_list).toHaveLength(2);
      expect(body.msg.item_list![0]!.type).toBe(1);
      expect(body.msg.item_list![1]!.type).toBe(2);
      expect(
        body.msg.item_list![1]!.image_item?.media?.encrypt_query_param
      ).toBe("param1");
    });

    it("builds image-only message (no text)", () => {
      const body = client.buildSendMessageBody({
        toUserId: "user1",
        contextToken: "ctx1",
        images: [
          {
            encryptQueryParam: "param1",
            aesKeyB64: "key1",
            ciphertextSize: 1024,
          },
        ],
      });
      expect(body.msg.item_list).toHaveLength(1);
      expect(body.msg.item_list![0]!.type).toBe(2);
    });
  });
});
