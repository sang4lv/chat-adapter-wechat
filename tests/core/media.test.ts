import { describe, it, expect } from "vitest";
import {
  aesEcbEncrypt,
  aesEcbDecrypt,
  parseAesKey,
  detectImageFormat,
  encodeAesKeyForSend,
} from "../../src/core/media.js";

describe("AES-128-ECB", () => {
  it("round-trips encrypt/decrypt", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const plaintext = Buffer.from("Hello, WeChat media!");
    const encrypted = aesEcbEncrypt(plaintext, key);
    const decrypted = aesEcbDecrypt(encrypted, key);
    expect(decrypted.toString("utf-8")).toBe("Hello, WeChat media!");
  });

  it("pads to 16-byte boundary", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const plaintext = Buffer.from("short");
    const encrypted = aesEcbEncrypt(plaintext, key);
    expect(encrypted.length % 16).toBe(0);
  });

  it("handles exact 16-byte input (adds full padding block)", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const plaintext = Buffer.alloc(16, 0x41);
    const encrypted = aesEcbEncrypt(plaintext, key);
    expect(encrypted.length).toBe(32);
    const decrypted = aesEcbDecrypt(encrypted, key);
    expect(decrypted.toString("utf-8")).toBe("A".repeat(16));
  });
});

describe("parseAesKey", () => {
  it("parses 32-char hex string", () => {
    const key = parseAesKey("0123456789abcdef0123456789abcdef");
    expect(key.length).toBe(16);
  });

  it("parses base64-encoded hex string (32 bytes decoded)", () => {
    const hexKey = "0123456789abcdef0123456789abcdef";
    const b64 = Buffer.from(hexKey, "utf-8").toString("base64");
    const key = parseAesKey(b64);
    expect(key.length).toBe(16);
  });

  it("parses base64-encoded raw 16 bytes", () => {
    const rawKey = Buffer.from("0123456789abcdef", "utf-8");
    const b64 = rawKey.toString("base64");
    const key = parseAesKey(b64);
    expect(key.length).toBe(16);
  });

  it("throws on invalid key", () => {
    expect(() => parseAesKey("too-short")).toThrow();
  });
});

describe("encodeAesKeyForSend", () => {
  it("produces base64(hex(key))", () => {
    const key = Buffer.from("0123456789abcdef0123456789abcdef", "hex");
    const encoded = encodeAesKeyForSend(key);
    const decoded = Buffer.from(encoded, "base64").toString("utf-8");
    expect(decoded).toBe("0123456789abcdef0123456789abcdef");
  });
});

describe("detectImageFormat", () => {
  it("detects JPEG", () => {
    const data = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]);
    expect(detectImageFormat(data)).toEqual({
      ext: "jpg",
      mimeType: "image/jpeg",
    });
  });

  it("detects PNG", () => {
    const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]);
    expect(detectImageFormat(data)).toEqual({
      ext: "png",
      mimeType: "image/png",
    });
  });

  it("detects GIF", () => {
    const data = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39]);
    expect(detectImageFormat(data)).toEqual({
      ext: "gif",
      mimeType: "image/gif",
    });
  });

  it("returns unknown for unrecognized data", () => {
    const data = Buffer.from([0x00, 0x01, 0x02]);
    expect(detectImageFormat(data)).toEqual({
      ext: "bin",
      mimeType: "application/octet-stream",
    });
  });
});
