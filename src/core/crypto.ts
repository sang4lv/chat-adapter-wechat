/**
 * Cryptographic utilities for the WeChat Official Dialog Platform.
 *
 * Implements:
 * - Request signing: md5(Token + timestamp + nonce + md5(body))
 * - AES-256-CBC body encryption/decryption (WeChat WXBizMsgCrypt protocol)
 *
 * Reference: https://developers.weixin.qq.com/doc/aispeech/confapi/dialog/token.html
 */

import crypto from "node:crypto";

/**
 * Compute the request signature.
 *
 * Formula: md5(Token + str(unix_timestamp) + nonce + md5(body))
 * - md5 output is lowercase hex
 * - GET requests use empty string for body
 */
export function computeSign(
  token: string,
  timestamp: number,
  nonce: string,
  body: string
): string {
  const bodyMd5 = md5Hex(body);
  return md5Hex(`${token}${timestamp}${nonce}${bodyMd5}`);
}

/**
 * md5 hash → lowercase hex string.
 */
export function md5Hex(input: string): string {
  return crypto.createHash("md5").update(input, "utf-8").digest("hex");
}

/**
 * Decode the AESKey from the chatbot platform.
 *
 * The platform provides a 43-character Base64 string (with trailing '=' removed).
 * Append '=' and Base64-decode to get the 32-byte AES key.
 * IV = first 16 bytes of the key.
 */
export function decodeAesKey(encodingAesKey: string): {
  key: Buffer;
  iv: Buffer;
} {
  const key = Buffer.from(encodingAesKey + "=", "base64");
  if (key.length !== 32) {
    throw new Error(
      `Invalid AESKey: expected 32 bytes after base64 decode, got ${key.length}`
    );
  }
  const iv = key.subarray(0, 16);
  return { key, iv };
}

/**
 * Encrypt a plaintext message using AES-256-CBC (WeChat WXBizMsgCrypt protocol).
 *
 * Plaintext structure: random(16B) + msg_len(4B, network order) + msg + appId
 * Padding: PKCS7 to 32-byte boundary
 * Output: Base64-encoded ciphertext
 */
export function wxEncrypt(
  plaintext: string,
  encodingAesKey: string,
  appId: string
): string {
  const { key, iv } = decodeAesKey(encodingAesKey);

  const msgBuf = Buffer.from(plaintext, "utf-8");
  const random = crypto.randomBytes(16);
  const msgLen = Buffer.alloc(4);
  msgLen.writeUInt32BE(msgBuf.length, 0);

  const raw = Buffer.concat([random, msgLen, msgBuf, Buffer.from(appId, "utf-8")]);

  // PKCS7 padding to 32-byte boundary
  const padLen = 32 - (raw.length % 32);
  const padded = Buffer.concat([raw, Buffer.alloc(padLen, padLen)]);

  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  cipher.setAutoPadding(false);
  const encrypted = Buffer.concat([cipher.update(padded), cipher.final()]);

  return encrypted.toString("base64");
}

/**
 * Decrypt an AES-256-CBC encrypted message (WeChat WXBizMsgCrypt protocol).
 *
 * Input: Base64-encoded ciphertext
 * Decrypted structure: random(16B) + msg_len(4B, network order) + msg + appId
 * Returns: { message, appId }
 */
export function wxDecrypt(
  ciphertext: string,
  encodingAesKey: string
): { message: string; appId: string } {
  const { key, iv } = decodeAesKey(encodingAesKey);

  const encrypted = Buffer.from(ciphertext, "base64");

  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]);

  // Remove PKCS7 padding
  const padLen = decrypted[decrypted.length - 1]!;
  const unpadded = decrypted.subarray(0, decrypted.length - padLen);

  // Parse: skip 16 random bytes, read 4-byte msg length, extract msg and appId
  const msgLen = unpadded.readUInt32BE(16);
  const message = unpadded.subarray(20, 20 + msgLen).toString("utf-8");
  const appId = unpadded.subarray(20 + msgLen).toString("utf-8");

  return { message, appId };
}

/**
 * Generate a random nonce string.
 */
export function generateNonce(length = 16): string {
  return crypto.randomBytes(length).toString("hex").slice(0, length);
}
