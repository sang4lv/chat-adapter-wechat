/**
 * HTTP client for the WeChat Official Dialog Platform API.
 *
 * Handles:
 * - AccessToken exchange and auto-refresh
 * - Request signing (md5)
 * - AES-256-CBC body encryption/decryption
 * - Bot dialog query
 *
 * Reference: https://developers.weixin.qq.com/doc/aispeech/confapi/dialog/
 */

import {
  NetworkError,
  AuthenticationError,
  AdapterRateLimitError,
  ValidationError,
} from "@chat-adapter/shared";
import {
  computeSign,
  wxEncrypt,
  wxDecrypt,
  generateNonce,
} from "../core/crypto.js";
import type {
  BotTokenResponse,
  BotQueryRequest,
  BotQueryResponse,
} from "./bot-types.js";

const DEFAULT_BASE_URL = "https://openaiapi.weixin.qq.com";
const TOKEN_REFRESH_BUFFER_MS = 5 * 60_000; // refresh 5 min before expiry
const TOKEN_TTL_MS = 2 * 60 * 60_000; // 2 hours

export interface BotClientConfig {
  appId: string;
  token: string;
  aesKey: string;
  baseUrl?: string;
}

export class BotClient {
  private readonly appId: string;
  private readonly token: string;
  private readonly aesKey: string;
  private readonly baseUrl: string;

  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(config: BotClientConfig) {
    this.appId = config.appId;
    this.token = config.token;
    this.aesKey = config.aesKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  }

  // --- Token Management ---

  async getAccessToken(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - TOKEN_REFRESH_BUFFER_MS) {
      return this.accessToken;
    }
    return this.refreshToken();
  }

  private async refreshToken(): Promise<string> {
    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = generateNonce();
    const body = "{}";
    const sign = computeSign(this.token, timestamp, nonce, body);

    const url = `${this.baseUrl}/v2/token`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-APPID": this.appId,
        request_id: crypto.randomUUID(),
        timestamp: String(timestamp),
        nonce,
        sign,
        "Content-Type": "application/json",
      },
      body,
    });

    if (response.status === 400) {
      throw new AuthenticationError(
        "wechat-bot",
        "Signature verification failed (HTTP 400). Check your APPID/Token."
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NetworkError("wechat-bot", `/v2/token ${response.status}: ${text}`);
    }

    const result = (await response.json()) as BotTokenResponse;
    if (result.code !== 0) {
      this.handleErrorCode(result.code, result.msg);
    }

    this.accessToken = result.data.access_token;
    this.tokenExpiresAt = Date.now() + TOKEN_TTL_MS;
    return this.accessToken;
  }

  // --- Dialog Query ---

  async query(params: BotQueryRequest): Promise<BotQueryResponse> {
    const accessToken = await this.getAccessToken();
    const plaintext = JSON.stringify(params);
    const encrypted = wxEncrypt(plaintext, this.aesKey, this.appId);

    const timestamp = Math.floor(Date.now() / 1000);
    const nonce = generateNonce();
    const sign = computeSign(this.token, timestamp, nonce, encrypted);

    const url = `${this.baseUrl}/v2/bot/query`;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "X-OPENAI-TOKEN": accessToken,
        "X-APPID": this.appId,
        request_id: crypto.randomUUID(),
        timestamp: String(timestamp),
        nonce,
        sign,
        "Content-Type": "text/plain",
      },
      body: encrypted,
    });

    if (response.status === 400) {
      // Token may have expired, retry once
      this.accessToken = null;
      throw new AuthenticationError(
        "wechat-bot",
        "Signature/token verification failed. Will retry with fresh token."
      );
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new NetworkError("wechat-bot", `/v2/bot/query ${response.status}: ${text}`);
    }

    // Response body is encrypted
    const responseBody = await response.text();
    let decryptedText: string;

    try {
      // Response may be encrypted (text/plain) or plain JSON
      if (responseBody.startsWith("{")) {
        decryptedText = responseBody;
      } else {
        const { message } = wxDecrypt(responseBody, this.aesKey);
        decryptedText = message;
      }
    } catch {
      // If decryption fails, try as plain JSON
      decryptedText = responseBody;
    }

    const result = JSON.parse(decryptedText) as BotQueryResponse;
    if (result.code !== 0) {
      this.handleErrorCode(result.code, result.msg);
    }

    return result;
  }

  // --- Error Handling ---

  private handleErrorCode(code: number, msg: string): never {
    switch (code) {
      case 110002:
      case 210106:
        throw new ValidationError("wechat-bot", `Parameter error: ${msg}`);
      case 210202:
        throw new AuthenticationError("wechat-bot", `No permission: ${msg}`);
      case 210205:
        throw new AdapterRateLimitError("wechat-bot");
      case 110003:
        throw new ValidationError("wechat-bot", `Content moderation failed: ${msg}`);
      default:
        throw new NetworkError("wechat-bot", `API error ${code}: ${msg}`);
    }
  }
}
