import { ValidationError } from "@chat-adapter/shared";
import type { WeChatThreadId } from "./types.js";

const THREAD_PREFIX = "wechat";
const VALID_TYPES = new Set(["dm", "group"]);

/**
 * Encode a WeChatThreadId into a string.
 *
 * Format:
 *   DM:    wechat:dm:{userId}:{contextToken}
 *   Group: wechat:group:{groupId}:{contextToken}
 */
export function encodeThreadId(data: WeChatThreadId): string {
  if (data.contextToken) {
    return `${THREAD_PREFIX}:${data.type}:${data.conversationId}:${data.contextToken}`;
  }
  return `${THREAD_PREFIX}:${data.type}:${data.conversationId}`;
}

/**
 * Decode a thread ID string back into a WeChatThreadId.
 *
 * Expects: wechat:{dm|group}:{conversationId}[:{contextToken}]
 */
export function decodeThreadId(threadId: string): WeChatThreadId {
  const parts = threadId.split(":");
  if (
    parts[0] !== THREAD_PREFIX ||
    parts.length < 3 ||
    !parts[1] ||
    !parts[2] ||
    !VALID_TYPES.has(parts[1])
  ) {
    throw new ValidationError(
      "wechat",
      `Invalid WeChat thread ID: ${threadId}`
    );
  }

  return {
    type: parts[1] as "dm" | "group",
    conversationId: parts[2],
    contextToken: parts[3] || undefined,
  };
}

/**
 * Extract channel ID from thread ID (strips context token).
 *
 * DM:    wechat:dm:{userId}
 * Group: wechat:group:{groupId}
 */
export function channelIdFromThreadId(threadId: string): string {
  const { type, conversationId } = decodeThreadId(threadId);
  return `${THREAD_PREFIX}:${type}:${conversationId}`;
}

/**
 * Resolve a thread ID — accepts both encoded thread IDs and raw user IDs.
 * Raw user IDs are treated as DM conversations.
 */
export function resolveThreadId(threadId: string): WeChatThreadId {
  if (threadId.startsWith(`${THREAD_PREFIX}:`)) {
    return decodeThreadId(threadId);
  }
  return { type: "dm", conversationId: threadId };
}
