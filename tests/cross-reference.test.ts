/**
 * Cross-reference tests that validate our implementation against actual data
 * formats from wxcodex and chatgpt-on-wechat (cow) reference implementations.
 *
 * These tests ensure our message structures, AES key encoding, and API
 * payloads match what the real WeChat ilink API expects.
 */
import { describe, it, expect } from "vitest";
import { IlinkClient } from "../src/acp/acp-client.js";
import { createWeChatAcpAdapter } from "../src/acp/index.js";
import {
  aesEcbEncrypt,
  aesEcbDecrypt,
  encodeAesKeyForSend,
  parseAesKey,
  aesEcbPaddedSize,
  fileMd5,
} from "../src/core/media.js";

describe("cross-ref: sendMessage body matches wxcodex format", () => {
  /**
   * wxcodex sends text messages with this exact structure:
   *   msg.from_user_id = ""
   *   msg.to_user_id = <target>
   *   msg.client_id = generateId("wxcodex")
   *   msg.message_type = 2 (BOT)
   *   msg.message_state = 2 (FINISH)
   *   msg.item_list = [{ type: 1, text_item: { text: <text> } }]
   *   msg.context_token = <token>
   *
   * See: MoLeft/wxcodex/src/wechat/wechatClient.ts:176-190
   */
  it("text-only message has correct field names and values", () => {
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "test",
    });

    const body = client.buildSendMessageBody({
      toUserId: "user123",
      text: "Hello!",
      contextToken: "ctx_abc",
    });

    // Validate exact field names match wxcodex
    expect(body.msg.from_user_id).toBe("");
    expect(body.msg.to_user_id).toBe("user123");
    expect(body.msg.client_id).toBeDefined();
    expect(typeof body.msg.client_id).toBe("string");
    expect(body.msg.message_type).toBe(2); // BOT
    expect(body.msg.message_state).toBe(2); // FINISH
    expect(body.msg.context_token).toBe("ctx_abc");
    expect(body.msg.item_list).toHaveLength(1);
    expect(body.msg.item_list![0]).toEqual({
      type: 1,
      text_item: { text: "Hello!" },
    });
  });

  /**
   * cow sends image messages with this exact structure:
   *   item_list includes:
   *     { type: 1, text_item: { text: <caption> } }  (if text provided)
   *     { type: 2, image_item: {
   *         media: {
   *           encrypt_query_param: <param>,
   *           aes_key: <base64_encoded_hex_key>,
   *           encrypt_type: 1,
   *         },
   *         mid_size: <ciphertext_size>,
   *       }}
   *
   * See: zhayujie/chatgpt-on-wechat/channel/weixin/weixin_api.py:100-117
   */
  it("image message matches cow send_image_item format", () => {
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "test",
    });

    const body = client.buildSendMessageBody({
      toUserId: "user123",
      text: "Check this image",
      contextToken: "ctx_abc",
      images: [
        {
          encryptQueryParam: "encrypted_download_param",
          aesKeyB64: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
          ciphertextSize: 2048,
        },
      ],
    });

    expect(body.msg.item_list).toHaveLength(2);

    // Text item
    expect(body.msg.item_list![0]).toEqual({
      type: 1,
      text_item: { text: "Check this image" },
    });

    // Image item — must match cow's send_image_item format
    const imageItem = body.msg.item_list![1]!;
    expect(imageItem.type).toBe(2);
    expect(imageItem.image_item).toBeDefined();
    expect(imageItem.image_item!.media).toEqual({
      encrypt_query_param: "encrypted_download_param",
      aes_key: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=",
      encrypt_type: 1,
    });
    expect(imageItem.image_item!.mid_size).toBe(2048);
  });
});

describe("cross-ref: AES key encoding matches cow upload_media_to_cdn", () => {
  /**
   * cow's upload_media_to_cdn does:
   *   aes_key = os.urandom(16)           # 16 random bytes
   *   aes_key_hex = aes_key.hex()         # 32-char hex string
   *   ... (upload with aeskey=aes_key_hex)
   *   aes_key_b64 = base64.b64encode(aes_key_hex.encode("utf-8")).decode("utf-8")
   *
   * See: zhayujie/chatgpt-on-wechat/channel/weixin/weixin_api.py:276-346
   */
  it("encodeAesKeyForSend produces base64(utf8(hex(key)))", () => {
    // Simulate cow's exact flow
    const aesKey = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const aesKeyHex = aesKey.toString("hex"); // "0123456789abcdef0123456789abcdef"

    // cow: base64.b64encode(aes_key_hex.encode("utf-8"))
    const expectedB64 = Buffer.from(aesKeyHex, "utf-8").toString("base64");

    // Our implementation
    const ourB64 = encodeAesKeyForSend(aesKey);

    expect(ourB64).toBe(expectedB64);
  });

  it("parseAesKey reverses the encoding", () => {
    const originalKey = Buffer.from("deadbeef12345678deadbeef12345678", "hex");
    const encoded = encodeAesKeyForSend(originalKey);
    const decoded = parseAesKey(encoded);

    expect(decoded).toEqual(originalKey);
  });
});

describe("cross-ref: AES-ECB matches cow _aes_ecb_encrypt/_aes_ecb_decrypt", () => {
  /**
   * cow's _aes_ecb_encrypt uses PKCS7 padding:
   *   pad_len = 16 - (len(data) % 16)
   *   padded = data + bytes([pad_len] * pad_len)
   *   cipher = AES.new(key, AES.MODE_ECB)
   *   return cipher.encrypt(padded)
   *
   * cow's _aes_ecb_padded_size:
   *   return ((plaintext_size + 1 + 15) // 16) * 16
   *
   * See: zhayujie/chatgpt-on-wechat/channel/weixin/weixin_api.py:224-256
   */
  it("padded size matches cow _aes_ecb_padded_size", () => {
    // cow: ((plaintext_size + 1 + 15) // 16) * 16
    // which is equivalent to: ceil((size + 1) / 16) * 16
    expect(aesEcbPaddedSize(0)).toBe(16); // ((0+1+15)//16)*16 = 16
    expect(aesEcbPaddedSize(1)).toBe(16); // ((1+1+15)//16)*16 = 16
    expect(aesEcbPaddedSize(15)).toBe(16); // ((15+1+15)//16)*16 = 16
    expect(aesEcbPaddedSize(16)).toBe(32); // ((16+1+15)//16)*16 = 32
    expect(aesEcbPaddedSize(31)).toBe(32); // ((31+1+15)//16)*16 = 32
    expect(aesEcbPaddedSize(32)).toBe(48); // ((32+1+15)//16)*16 = 48
  });

  it("encrypt output size matches aesEcbPaddedSize", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    for (const size of [0, 1, 15, 16, 31, 32, 100]) {
      const data = Buffer.alloc(size, 0x42);
      const encrypted = aesEcbEncrypt(data, key);
      // Our padded size should match the actual encrypted output
      expect(encrypted.length).toBe(aesEcbPaddedSize(size));
    }
  });

  it("round-trips with real-world-sized data", () => {
    const key = Buffer.from("a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8", "hex");
    // Simulate a small image file
    const imageData = Buffer.alloc(1024, 0);
    for (let i = 0; i < imageData.length; i++) {
      imageData[i] = i % 256;
    }

    const encrypted = aesEcbEncrypt(imageData, key);
    const decrypted = aesEcbDecrypt(encrypted, key);

    expect(decrypted).toEqual(imageData);
  });
});

describe("cross-ref: parseAesKey handles all formats from cow download_media_from_cdn", () => {
  /**
   * cow's download_media_from_cdn handles multiple key formats:
   *   1) 32-char hex string → bytes.fromhex → 16 bytes
   *   2) base64 → decode → 32 bytes → treat as hex → 16 bytes
   *   3) base64 → decode → 16 bytes directly
   *
   * See: zhayujie/chatgpt-on-wechat/channel/weixin/weixin_api.py:370-393
   */
  it("format 1: 32-char hex string", () => {
    const key = parseAesKey("0123456789abcdef0123456789abcdef");
    expect(key.length).toBe(16);
    expect(key[0]).toBe(0x01);
    expect(key[15]).toBe(0xef);
  });

  it("format 2: base64 of 32-char hex string (from upload flow)", () => {
    // This is what upload_media_to_cdn produces: base64(hex_key.encode("utf-8"))
    const hexKey = "0123456789abcdef0123456789abcdef";
    const b64Key = Buffer.from(hexKey, "utf-8").toString("base64");

    const key = parseAesKey(b64Key);
    expect(key.length).toBe(16);
    expect(key[0]).toBe(0x01);
  });

  it("format 3: base64 of raw 16 bytes", () => {
    const rawKey = Buffer.from("0123456789abcdef", "utf-8");
    const b64Key = rawKey.toString("base64");

    const key = parseAesKey(b64Key);
    expect(key.length).toBe(16);
  });
});

describe("cross-ref: message parsing matches wxcodex formatMessage", () => {
  /**
   * wxcodex's formatMessage processes messages from getUpdates:
   *   - Filters message_type === 1 (USER), skips type 2 (BOT)
   *   - Extracts text from item_list where type === 1 (TEXT)
   *   - Extracts ref_msg title and text
   *   - Tracks context_token per user
   *
   * See: MoLeft/wxcodex/src/wechat/wechatClient.ts:239-326
   */
  it("correctly parses a typical ilink message with text + ref_msg", () => {
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example.com",
    });

    // Simulate a real ilink message structure (from getUpdates response)
    const raw = {
      messageId: 12345,
      fromUserId: "wx_user_001",
      toUserId: "wx_bot_001",
      text: "What do you think?",
      createTime: 1700000000000,
      contextToken: "ctx_session_abc",
      media: [],
      refMsg: {
        text: "The weather is sunny today",
        title: "Previous message",
      },
      raw: {
        // Simulated raw ilink payload
        message_id: 12345,
        from_user_id: "wx_user_001",
        to_user_id: "wx_bot_001",
        message_type: 1,
        item_list: [
          { type: 1, text_item: { text: "What do you think?" } },
        ],
        context_token: "ctx_session_abc",
        ref_msg: {
          title: "Previous message",
          message_item: {
            type: 1,
            text_item: { text: "The weather is sunny today" },
          },
        },
      },
    };

    const message = adapter.parseMessage(raw);

    // Verify Message fields
    expect(message.id).toBe("12345");
    expect(message.text).toBe("What do you think?");
    expect(message.threadId).toBe("wechat:dm:wx_user_001:ctx_session_abc");
    expect(message.author.userId).toBe("wx_user_001");
    expect(message.author.isBot).toBe(false);
    expect(message.author.isMe).toBe(false);

    // Verify ref_msg is rendered as blockquote
    expect(message.formatted.type).toBe("root");
    expect(message.formatted.children[0]!.type).toBe("blockquote");
    expect(message.formatted.children[1]!.type).toBe("paragraph");
  });

  it("correctly parses a message with image media", () => {
    const adapter = createWeChatAcpAdapter({
      baseUrl: "https://test.example.com",
    });

    const raw = {
      messageId: 12346,
      fromUserId: "wx_user_002",
      toUserId: "wx_bot_001",
      text: "",
      createTime: 1700000001000,
      media: [
        {
          kind: "image" as const,
          encryptQueryParam: "encrypted_cdn_param_abc",
          aesKey: "0123456789abcdef0123456789abcdef",
          size: 50000,
        },
      ],
      raw: {},
    };

    const message = adapter.parseMessage(raw);
    expect(message.attachments).toHaveLength(1);
    expect(message.attachments[0]!.type).toBe("image");
    expect(typeof message.attachments[0]!.fetchData).toBe("function");
  });
});

describe("cross-ref: headers match wxcodex buildHeaders", () => {
  /**
   * wxcodex buildHeaders produces:
   *   Content-Type: application/json
   *   AuthorizationType: ilink_bot_token
   *   Content-Length: <byte_length>
   *   X-WECHAT-UIN: <random_base64>
   *   Authorization: Bearer <token>  (if token present)
   *
   * See: MoLeft/wxcodex/src/wechat/api.ts:18-31
   */
  it("headers include all required fields", () => {
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
      token: "my_bot_token_123",
    });

    const body = '{"test": true}';
    const headers = client.buildHeaders(body);

    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers["AuthorizationType"]).toBe("ilink_bot_token");
    expect(headers["Content-Length"]).toBe(
      String(Buffer.byteLength(body, "utf-8"))
    );
    expect(headers["X-WECHAT-UIN"]).toBeDefined();
    // X-WECHAT-UIN should be a base64-encoded string
    expect(() => Buffer.from(headers["X-WECHAT-UIN"]!, "base64")).not.toThrow();
    expect(headers["Authorization"]).toBe("Bearer my_bot_token_123");
  });

  it("omits Authorization when no token", () => {
    const client = new IlinkClient({
      baseUrl: "https://ilinkai.weixin.qq.com",
      cdnBaseUrl: "https://novac2c.cdn.weixin.qq.com/c2c",
    });

    const headers = client.buildHeaders("{}");
    expect(headers["Authorization"]).toBeUndefined();
  });
});

describe("cross-ref: fileMd5 matches cow _md5_bytes", () => {
  /**
   * cow: hashlib.md5(data).hexdigest()
   */
  it("produces lowercase hex md5", () => {
    const data = Buffer.from("Hello World");
    const md5 = fileMd5(data);
    expect(md5).toBe("b10a8db164e0754105b7a99be72e3fe5");
    expect(md5).toMatch(/^[0-9a-f]{32}$/);
  });
});
