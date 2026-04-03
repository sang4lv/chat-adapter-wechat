import type { Logger } from "chat";

// --- Thread ID ---

export interface WeChatThreadId {
  type: "dm" | "group";
  conversationId: string; // userId for DMs, groupId for groups
  contextToken?: string;
}

// --- Raw Message ---

export interface WeChatRawMessage {
  messageId: number;
  fromUserId: string;
  toUserId: string;
  groupId?: string; // present when message is from a group chat
  messageType?: "text" | "image" | "voice" | "file" | "video";
  text: string;
  createTime: number;
  contextToken?: string;
  media: WeChatMediaItem[];
  refMsg?: WeChatRefMessage;
  raw: unknown;
}

export interface WeChatMediaItem {
  kind: "image" | "voice" | "file" | "video";
  encryptQueryParam: string;
  aesKey: string;
  fileName?: string;
  size?: number;
}

export interface WeChatRefMessage {
  text?: string;
  title?: string;
  mediaItem?: WeChatMediaItem;
}

// --- Configuration ---

export interface WeChatStorage<T> {
  load(): Promise<T | null>;
  save(data: T): Promise<void>;
}

export interface WeChatBaseConfig {
  dataDir?: string;
  pollIntervalMs?: number;
  onQrCode?: (qr: { imageBase64: string; terminalAscii: string }) => void;
  logger?: Logger;
}

export interface WeChatAcpAdapterConfig extends WeChatBaseConfig {
  baseUrl?: string;
  cdnBaseUrl?: string;
  typingIntervalMs?: number;
  accountStorage?: WeChatStorage<import("../acp/acp-types.js").AccountData>;
  stateStorage?: WeChatStorage<import("../acp/acp-types.js").PollState>;
}

// --- Constants ---

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const DEFAULT_CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export const DEFAULT_POLL_INTERVAL_MS = 25_000;
export const DEFAULT_TYPING_INTERVAL_MS = 15_000;
export const DEFAULT_API_TIMEOUT_MS = 15_000;
export const QR_LONG_POLL_TIMEOUT_MS = 35_000;
export const CHANNEL_VERSION = "1.0.2";
export const BOT_TYPE = "3";
