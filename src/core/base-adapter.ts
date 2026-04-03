import type {
  Adapter,
  AdapterPostableMessage,
  Attachment,
  ChatInstance,
  FetchOptions,
  FetchResult,
  Logger,
  RawMessage,
  StreamChunk,
  StreamOptions,
  ThreadInfo,
} from "chat";
import { Message } from "chat";
import { AdapterError } from "@chat-adapter/shared";
import type {
  WeChatThreadId,
  WeChatRawMessage,
  WeChatMediaItem,
} from "./types.js";
import {
  encodeThreadId,
  decodeThreadId,
  channelIdFromThreadId,
  resolveThreadId,
} from "./utils.js";
import { WeChatFormatConverter } from "./format-converter.js";
import { parseAesKey, aesEcbDecrypt } from "./media.js";

export abstract class WeChatBaseAdapter
  implements Adapter<WeChatThreadId, WeChatRawMessage>
{
  abstract readonly name: string;
  readonly lockScope = "channel" as const;
  readonly persistMessageHistory = true;

  protected chat: ChatInstance | null = null;
  protected readonly logger: Logger;
  protected readonly formatConverter = new WeChatFormatConverter();

  private _userName: string;
  private _botUserId?: string;

  constructor(userName: string, logger: Logger) {
    this._userName = userName;
    this.logger = logger;
  }

  get userName(): string {
    return this._userName;
  }

  get botUserId(): string | undefined {
    return this._botUserId;
  }

  protected setBotUserId(id: string): void {
    this._botUserId = id;
  }

  protected setUserName(name: string): void {
    this._userName = name;
  }

  // --- Lifecycle (implemented by subclass) ---

  abstract initialize(chat: ChatInstance): Promise<void>;
  abstract disconnect(): Promise<void>;

  // --- Thread ID ---

  encodeThreadId(data: WeChatThreadId): string {
    return encodeThreadId(data);
  }

  decodeThreadId(threadId: string): WeChatThreadId {
    return decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return channelIdFromThreadId(threadId);
  }

  // --- Message Parsing ---

  parseMessage(raw: WeChatRawMessage): Message<WeChatRawMessage> {
    const isGroup = Boolean(raw.groupId);
    const threadId = this.encodeThreadId({
      type: isGroup ? "group" : "dm",
      conversationId: isGroup ? raw.groupId! : raw.fromUserId,
      contextToken: raw.contextToken,
    });

    const attachments: Attachment[] = [];

    // Direct media
    for (const m of raw.media) {
      if (m.kind === "image" || m.kind === "file") {
        attachments.push({
          type: m.kind === "image" ? "image" : "file",
          name: m.fileName,
          fetchData: () => this.downloadMedia(m),
        });
      }
    }

    // Referenced message media
    if (raw.refMsg?.mediaItem) {
      const refMedia = raw.refMsg.mediaItem;
      attachments.push({
        type: refMedia.kind === "image" ? "image" : "file",
        name: refMedia.fileName,
        fetchData: () => this.downloadMedia(refMedia),
      });
    }

    // Build formatted content with optional blockquote for ref_msg
    const formatted = this.formatConverter.buildFormattedWithQuote(
      raw.text,
      raw.refMsg
    );

    return new Message<WeChatRawMessage>({
      id: String(raw.messageId),
      threadId,
      text: raw.text,
      formatted,
      raw,
      author: {
        userId: raw.fromUserId,
        userName: raw.fromUserId,
        fullName: raw.fromUserId,
        isBot: false,
        isMe: raw.fromUserId === this._botUserId,
      },
      metadata: {
        dateSent: new Date(raw.createTime),
        edited: false,
      },
      attachments,
      isMention: true, // ilink API only delivers messages directed at the bot
    });
  }

  // --- Sending (implemented by subclass) ---

  abstract postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WeChatRawMessage>>;

  // --- Unsupported Operations ---

  async editMessage(): Promise<RawMessage<WeChatRawMessage>> {
    throw new AdapterError(
      "WeChat does not support editing messages",
      "wechat"
    );
  }

  async deleteMessage(): Promise<void> {
    throw new AdapterError(
      "WeChat does not support deleting messages",
      "wechat"
    );
  }

  async addReaction(): Promise<void> {
    // No-op: WeChat has no reactions
  }

  async removeReaction(): Promise<void> {
    // No-op: WeChat has no reactions
  }

  // --- Message Fetching (delegated to SDK history cache) ---

  async fetchMessages(
    _threadId: string,
    _options?: FetchOptions
  ): Promise<FetchResult<WeChatRawMessage>> {
    return { messages: [] };
  }

  async fetchMessage(
    _threadId: string,
    _messageId: string
  ): Promise<Message<WeChatRawMessage> | null> {
    return null; // delegated to SDK message history cache
  }

  // --- DM ---

  async openDM(userId: string): Promise<string> {
    return encodeThreadId({ type: "dm", conversationId: userId });
  }

  // --- Thread Info ---

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const decoded = resolveThreadId(threadId);
    return {
      id: threadId,
      channelId: channelIdFromThreadId(threadId),
      isDM: decoded.type === "dm",
      metadata: {},
    };
  }

  isDM(threadId: string): boolean {
    const { type } = resolveThreadId(threadId);
    return type === "dm";
  }

  // --- Webhook (no-op for polling adapter) ---

  async handleWebhook(): Promise<Response> {
    return new Response("ok", { status: 200 });
  }

  // --- Typing (overridden by bot adapter) ---

  async startTyping(_threadId: string, _status?: string): Promise<void> {
    // No-op by default; bot adapter overrides
  }

  // --- Format ---

  renderFormatted(content: any): string {
    return this.formatConverter.toString(content);
  }

  // --- Streaming ---

  protected typingIntervalMs = 15_000;

  async stream(
    threadId: string,
    textStream: AsyncIterable<string | StreamChunk>,
    _options?: StreamOptions
  ): Promise<RawMessage<WeChatRawMessage>> {
    // Start typing and maintain heartbeat
    await this.startTyping(threadId);
    const typingInterval = setInterval(() => {
      this.startTyping(threadId).catch(() => {});
    }, this.typingIntervalMs);

    try {
      // Accumulate full response
      let fullText = "";
      for await (const chunk of textStream) {
        if (typeof chunk === "string") {
          fullText += chunk;
        } else if (chunk.type === "markdown_text") {
          fullText += chunk.text;
        }
        // task_update and plan_update chunks are ignored
      }

      // Send final message
      return await this.postMessage(threadId, fullText);
    } finally {
      clearInterval(typingInterval);
    }
  }

  // --- Media Download ---

  protected async downloadMedia(media: WeChatMediaItem): Promise<Buffer> {
    const encryptedData = await this.downloadFromCdn(media.encryptQueryParam);
    const key = parseAesKey(media.aesKey);
    return aesEcbDecrypt(encryptedData, key);
  }

  protected abstract downloadFromCdn(
    encryptQueryParam: string
  ): Promise<Buffer>;
}
