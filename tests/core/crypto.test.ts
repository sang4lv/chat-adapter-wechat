/**
 * Tests for AES-256-CBC encryption and md5 signing.
 * Cross-referenced against the official WeChat documentation examples.
 */
import { describe, it, expect } from "vitest";
import {
  computeSign,
  md5Hex,
  decodeAesKey,
  wxEncrypt,
  wxDecrypt,
  generateNonce,
} from "../../src/core/crypto.js";

describe("md5Hex", () => {
  it("produces lowercase hex", () => {
    const result = md5Hex("hello");
    expect(result).toMatch(/^[0-9a-f]{32}$/);
    expect(result).toBe("5d41402abc4b2a76b9719d911017c592");
  });

  it("handles empty string", () => {
    const result = md5Hex("");
    expect(result).toBe("d41d8cd98f00b204e9800998ecf8427e");
  });
});

describe("computeSign", () => {
  /**
   * Cross-ref from official doc:
   *   Token: YV78Pyj1VvqdNGpMJ1pHic0bIBOWMv
   *   timestamp: 1711001766
   *   nonce: abc
   *   body: "" (empty for token exchange)
   *   Expected sign: fff8dae1356e7867ea98743439f0e9f8
   */
  it("matches official doc example for empty body", () => {
    const sign = computeSign(
      "YV78Pyj1VvqdNGpMJ1pHic0bIBOWMv",
      1711001766,
      "abc",
      ""
    );
    expect(sign).toBe("fff8dae1356e7867ea98743439f0e9f8");
  });

  it("produces different sign with different body", () => {
    const sign1 = computeSign("token", 12345, "nonce", "");
    const sign2 = computeSign("token", 12345, "nonce", '{"query":"hi"}');
    expect(sign1).not.toBe(sign2);
  });

  it("produces different sign with different nonce", () => {
    const sign1 = computeSign("token", 12345, "abc", "body");
    const sign2 = computeSign("token", 12345, "xyz", "body");
    expect(sign1).not.toBe(sign2);
  });
});

describe("decodeAesKey", () => {
  it("decodes 43-char base64 string to 32-byte key", () => {
    // 43 chars of base64 + appended '=' = valid base64 for 32 bytes
    const testKey = "q1Os1ZMe0nG28KUEx9lg3HjK7V5QyXvi212fzsgDqgz";
    const { key, iv } = decodeAesKey(testKey);
    expect(key.length).toBe(32);
    expect(iv.length).toBe(16);
    // IV = first 16 bytes of key
    expect(iv).toEqual(key.subarray(0, 16));
  });

  it("throws on wrong-length key", () => {
    expect(() => decodeAesKey("tooshort")).toThrow("Invalid AESKey");
  });
});

describe("wxEncrypt / wxDecrypt round-trip", () => {
  // Use the example AESKey from official docs
  const aesKey = "q1Os1ZMe0nG28KUEx9lg3HjK7V5QyXvi212fzsgDqgz";
  const appId = "Gg8HejYTkUsEIlG";

  it("round-trips a simple message", () => {
    const plaintext = '{"query":"你好","env":"online"}';
    const encrypted = wxEncrypt(plaintext, aesKey, appId);

    // Encrypted should be base64
    expect(() => Buffer.from(encrypted, "base64")).not.toThrow();
    expect(encrypted).not.toBe(plaintext);

    const { message, appId: decryptedAppId } = wxDecrypt(encrypted, aesKey);
    expect(message).toBe(plaintext);
    expect(decryptedAppId).toBe(appId);
  });

  it("round-trips empty message", () => {
    const plaintext = "";
    const encrypted = wxEncrypt(plaintext, aesKey, appId);
    const { message } = wxDecrypt(encrypted, aesKey);
    expect(message).toBe(plaintext);
  });

  it("round-trips long message", () => {
    const plaintext = JSON.stringify({
      query: "A".repeat(5000),
      env: "online",
      userid: "test_user_123",
    });
    const encrypted = wxEncrypt(plaintext, aesKey, appId);
    const { message } = wxDecrypt(encrypted, aesKey);
    expect(message).toBe(plaintext);
  });

  it("round-trips Chinese characters", () => {
    const plaintext = '{"query":"妈妈的姐姐叫什么"}';
    const encrypted = wxEncrypt(plaintext, aesKey, appId);
    const { message } = wxDecrypt(encrypted, aesKey);
    expect(message).toBe(plaintext);
  });

  it("produces different ciphertext each time (random IV prefix)", () => {
    const plaintext = '{"query":"test"}';
    const enc1 = wxEncrypt(plaintext, aesKey, appId);
    const enc2 = wxEncrypt(plaintext, aesKey, appId);
    expect(enc1).not.toBe(enc2); // random 16-byte prefix
    // But both decrypt to the same plaintext
    expect(wxDecrypt(enc1, aesKey).message).toBe(plaintext);
    expect(wxDecrypt(enc2, aesKey).message).toBe(plaintext);
  });
});

describe("generateNonce", () => {
  it("returns hex string of specified length", () => {
    const nonce = generateNonce(16);
    expect(nonce).toHaveLength(16);
    expect(nonce).toMatch(/^[0-9a-f]+$/);
  });

  it("returns different values each time", () => {
    const a = generateNonce();
    const b = generateNonce();
    expect(a).not.toBe(b);
  });
});
