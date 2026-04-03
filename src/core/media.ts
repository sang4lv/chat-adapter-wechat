import crypto from "node:crypto";

export function aesEcbEncrypt(data: Buffer, key: Buffer): Buffer {
  const padLen = 16 - (data.length % 16);
  const padded = Buffer.concat([data, Buffer.alloc(padLen, padLen)]);
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]);
}

export function aesEcbDecrypt(data: Buffer, key: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", key, null);
  decipher.setAutoPadding(false);
  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  const padLen = decrypted[decrypted.length - 1]!;
  if (padLen > 16 || padLen === 0) {
    return decrypted;
  }
  return decrypted.subarray(0, decrypted.length - padLen);
}

export function parseAesKey(raw: string): Buffer {
  // Try 32-char hex string → 16 bytes
  if (/^[0-9a-f]{32}$/i.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  // Try base64 decode
  const decoded = Buffer.from(raw, "base64");

  // 32 bytes → might be hex-encoded, try to parse as hex
  if (decoded.length === 32) {
    const asAscii = decoded.toString("ascii");
    if (/^[0-9a-f]{32}$/i.test(asAscii)) {
      return Buffer.from(asAscii, "hex");
    }
    throw new Error("Invalid AES key: 32 bytes but not valid hex");
  }

  // 16 bytes → direct key
  if (decoded.length === 16) {
    return decoded;
  }

  throw new Error(`Invalid AES key length: ${decoded.length} (expected 16 or 32)`);
}

export function encodeAesKeyForSend(key: Buffer): string {
  const hexStr = key.toString("hex");
  return Buffer.from(hexStr, "utf-8").toString("base64");
}

export function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

export function detectImageFormat(data: Buffer): {
  ext: string;
  mimeType: string;
} {
  if (data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return { ext: "jpg", mimeType: "image/jpeg" };
  }
  if (
    data[0] === 0x89 &&
    data[1] === 0x50 &&
    data[2] === 0x4e &&
    data[3] === 0x47
  ) {
    return { ext: "png", mimeType: "image/png" };
  }
  if (
    data[0] === 0x47 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x38
  ) {
    return { ext: "gif", mimeType: "image/gif" };
  }
  if (
    data[0] === 0x52 &&
    data[1] === 0x49 &&
    data[2] === 0x46 &&
    data[3] === 0x46 &&
    data.length > 11 &&
    data[8] === 0x57 &&
    data[9] === 0x45 &&
    data[10] === 0x42 &&
    data[11] === 0x50
  ) {
    return { ext: "webp", mimeType: "image/webp" };
  }
  return { ext: "bin", mimeType: "application/octet-stream" };
}

export function fileMd5(data: Buffer): string {
  return crypto.createHash("md5").update(data).digest("hex");
}

export function generateFileKey(): string {
  return crypto.randomBytes(16).toString("hex");
}
