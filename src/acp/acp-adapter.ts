import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import type {
  AdapterPostableMessage,
  ChatInstance,
  RawMessage,
} from "chat";
import { ConsoleLogger } from "chat";
import {
  extractCard,
  extractFiles,
  cardToFallbackText,
  NetworkError,
  AuthenticationError,
} from "@chat-adapter/shared";
import { WeChatBaseAdapter } from "../core/base-adapter.js";
import type {
  WeChatAcpAdapterConfig,
  WeChatRawMessage,
  WeChatMediaItem,
} from "../core/types.js";
import {
  DEFAULT_BASE_URL,
  DEFAULT_CDN_BASE_URL,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TYPING_INTERVAL_MS,
} from "../core/types.js";
import { resolveThreadId } from "../core/utils.js";
import {
  aesEcbEncrypt,
  encodeAesKeyForSend,
  fileMd5,
  generateFileKey,
} from "../core/media.js";
import { IlinkClient } from "./acp-client.js";
import { MessageType, MessageItemType } from "./acp-types.js";
import type {
  AccountData,
  PollState,
  IlinkMessage,
  IlinkMessageItem,
} from "./acp-types.js";

export class WeChatAcpAdapter extends WeChatBaseAdapter {
  readonly name = "wechat-acp";

  private readonly client: IlinkClient;
  private readonly config: {
    baseUrl: string;
    cdnBaseUrl: string;
    dataDir: string;
    pollIntervalMs: number;
    typingIntervalMs: number;
    onQrCode?: WeChatAcpAdapterConfig["onQrCode"];
    accountStorage?: WeChatAcpAdapterConfig["accountStorage"];
    stateStorage?: WeChatAcpAdapterConfig["stateStorage"];
  };

  private pollingActive = false;
  private pollingAbortController: AbortController | null = null;
  private pollingTask: Promise<void> | null = null;
  private pollState: PollState = {
    updatesBuf: "",
    contextTokens: {},
    lastMessageId: 0,
  };

  constructor(config: WeChatAcpAdapterConfig = {}) {
    const logger =
      config.logger ?? new ConsoleLogger("info").child("wechat-acp");
    super("wechat-acp", logger);

    const baseUrl = config.baseUrl ?? DEFAULT_BASE_URL;
    const cdnBaseUrl = config.cdnBaseUrl ?? DEFAULT_CDN_BASE_URL;
    const dataDir =
      config.dataDir ?? path.join(os.homedir(), ".chat-adapter-wechat");

    this.config = {
      baseUrl,
      cdnBaseUrl,
      dataDir,
      pollIntervalMs: config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      typingIntervalMs: config.typingIntervalMs ?? DEFAULT_TYPING_INTERVAL_MS,
      onQrCode: config.onQrCode,
      accountStorage: config.accountStorage,
      stateStorage: config.stateStorage,
    };

    this.client = new IlinkClient({ baseUrl, cdnBaseUrl });
    this.typingIntervalMs = this.config.typingIntervalMs;
  }

  // --- Lifecycle ---

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;

    // Try to load saved account
    const account = await this.loadAccount();
    if (account) {
      this.client.setToken(account.botToken);
      this.setBotUserId(account.userId);
      this.setUserName(account.botId);
      this.logger.info("Loaded saved WeChat bot account", {
        botId: account.botId,
      });
    } else {
      // QR code login
      await this.qrLogin();
    }

    // Load poll state
    this.pollState = await this.loadPollState();

    // Start polling
    await this.startPolling();
  }

  async disconnect(): Promise<void> {
    this.pollingActive = false;
    this.pollingAbortController?.abort();
    if (this.pollingTask) {
      await this.pollingTask.catch(() => {});
    }
    await this.savePollState();
  }

  // --- QR Login ---

  private async qrLogin(): Promise<void> {
    this.logger.info("Starting QR code login...");
    const qr = await this.client.fetchQrCode();

    if (this.config.onQrCode) {
      this.config.onQrCode({
        imageBase64: qr.qrcode_img_content,
        terminalAscii: "",
      });
    } else {
      this.logger.info(
        "Scan QR code to login (base64 image available in onQrCode callback)"
      );
    }

    while (true) {
      const status = await this.client.pollQrStatus(qr.qrcode);
      if (status.status === "confirmed") {
        const account: AccountData = {
          botToken: status.bot_token!,
          botId: status.ilink_bot_id!,
          userId: status.ilink_user_id!,
          baseUrl: this.config.baseUrl,
          savedAt: Date.now(),
        };
        this.client.setToken(account.botToken);
        this.setBotUserId(account.userId);
        this.setUserName(account.botId);
        await this.saveAccount(account);
        this.logger.info("QR login successful", { botId: account.botId });
        return;
      }
      if (status.status === "expired") {
        throw new Error("QR code expired. Please restart to try again.");
      }
    }
  }

  // --- Polling ---

  private async startPolling(): Promise<void> {
    if (this.pollingActive) return;
    this.pollingActive = true;
    this.pollingAbortController = new AbortController();

    this.pollingTask = this.pollingLoop().finally(() => {
      this.pollingActive = false;
      this.pollingAbortController = null;
      this.pollingTask = null;
    });
  }

  private async pollingLoop(): Promise<void> {
    let consecutiveFailures = 0;

    while (this.pollingActive) {
      try {
        const response = await this.client.getUpdates(
          this.pollState.updatesBuf,
          this.config.pollIntervalMs,
          this.pollingAbortController?.signal
        );

        if (response.get_updates_buf) {
          this.pollState.updatesBuf = response.get_updates_buf;
        }

        if (response.msgs?.length) {
          for (const msg of response.msgs) {
            await this.processIncomingMessage(msg);
          }
          await this.savePollState();
        }

        consecutiveFailures = 0;
      } catch (error) {
        if (!this.pollingActive) return;

        // On auth failure, attempt re-login
        if (error instanceof AuthenticationError) {
          this.logger.warn("Auth token invalid, attempting re-login...");
          try {
            await this.qrLogin();
            consecutiveFailures = 0;
            continue;
          } catch (reLoginError) {
            this.logger.error("Re-login failed", {
              error: String(reLoginError),
            });
          }
        }

        consecutiveFailures++;
        const backoffMs = Math.min(1000 * 2 ** consecutiveFailures, 60_000);
        this.logger.warn(`Polling error (retry in ${backoffMs}ms)`, {
          error: String(error),
          failures: consecutiveFailures,
        });
        await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
  }

  private async processIncomingMessage(msg: IlinkMessage): Promise<void> {
    // Skip bot messages
    if (msg.message_type === MessageType.BOT) return;
    // Skip duplicates
    if (
      msg.message_id != null &&
      msg.message_id <= this.pollState.lastMessageId
    )
      return;

    if (msg.message_id != null) {
      this.pollState.lastMessageId = msg.message_id;
    }

    // Track context token keyed by conversation (group or DM)
    const conversationKey = msg.group_id || msg.from_user_id;
    if (conversationKey && msg.context_token) {
      this.pollState.contextTokens[conversationKey] = msg.context_token;
    }

    // Convert to WeChatRawMessage
    const rawMessage = this.ilinkToRawMessage(msg);
    const message = this.parseMessage(rawMessage);

    // Dispatch to Chat SDK
    if (this.chat) {
      this.chat.processMessage(this, message.threadId, message);
    }
  }

  private ilinkToRawMessage(msg: IlinkMessage): WeChatRawMessage {
    let text = "";
    const media: WeChatMediaItem[] = [];

    for (const item of msg.item_list ?? []) {
      if (item.type === MessageItemType.TEXT && item.text_item?.text) {
        text += item.text_item.text;
      }
      const mediaItem = this.extractMediaItem(item);
      if (mediaItem) media.push(mediaItem);
    }

    // Handle ref_msg
    let refMsg = undefined;
    const refSource = msg.ref_msg ?? msg.item_list?.[0]?.ref_msg;
    if (refSource) {
      refMsg = {
        text: refSource.message_item?.text_item?.text,
        title: refSource.title,
        mediaItem: refSource.message_item
          ? this.extractMediaItem(refSource.message_item)
          : undefined,
      };
    }

    return {
      messageId: msg.message_id ?? 0,
      fromUserId: msg.from_user_id ?? "",
      toUserId: msg.to_user_id ?? "",
      groupId: msg.group_id || undefined,
      text,
      createTime: msg.create_time_ms ?? Date.now(),
      contextToken: msg.context_token,
      media,
      refMsg:
        refMsg?.text || refMsg?.title || refMsg?.mediaItem
          ? refMsg
          : undefined,
      raw: msg,
    };
  }

  private extractMediaItem(
    item: IlinkMessageItem
  ): WeChatMediaItem | undefined {
    if (item.type === MessageItemType.IMAGE && item.image_item?.media) {
      const m = item.image_item.media;
      const aesKey = m.aes_key ?? item.image_item.aeskey ?? "";
      if (m.encrypt_query_param && aesKey) {
        return {
          kind: "image",
          encryptQueryParam: m.encrypt_query_param,
          aesKey,
          size: item.image_item.mid_size,
        };
      }
    }
    if (item.type === MessageItemType.FILE && item.file_item?.media) {
      const m = item.file_item.media;
      if (m.encrypt_query_param && m.aes_key) {
        return {
          kind: "file",
          encryptQueryParam: m.encrypt_query_param,
          aesKey: m.aes_key,
          fileName: item.file_item.file_name,
        };
      }
    }
    if (item.type === MessageItemType.VIDEO && item.video_item?.media) {
      const m = item.video_item.media;
      if (m.encrypt_query_param && m.aes_key) {
        return {
          kind: "video",
          encryptQueryParam: m.encrypt_query_param,
          aesKey: m.aes_key,
          size: item.video_item.video_size,
        };
      }
    }
    return undefined;
  }

  // --- Sending ---

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WeChatRawMessage>> {
    const decoded = resolveThreadId(threadId);
    const { conversationId, contextToken } = decoded;
    const ctx =
      contextToken ?? this.pollState.contextTokens[conversationId] ?? "";

    // Extract text content
    const card = extractCard(message);
    const text = card
      ? cardToFallbackText(card)
      : this.formatConverter.renderPostable(message);

    // Extract and upload image attachments
    const files = extractFiles(message);
    const imageUploads: Array<{
      encryptQueryParam: string;
      aesKeyB64: string;
      ciphertextSize: number;
    }> = [];

    for (const file of files) {
      const isImage =
        file.mimeType?.startsWith("image/") ||
        file.filename?.match(/\.(jpg|jpeg|png|gif|webp)$/i);
      if (isImage) {
        const buf = Buffer.isBuffer(file.data)
          ? file.data
          : Buffer.from(
              file.data instanceof ArrayBuffer
                ? file.data
                : await new Response(file.data as Blob).arrayBuffer()
            );
        const uploaded = await this.uploadImage(conversationId, buf);
        imageUploads.push(uploaded);
      }
    }

    // Send message — conversationId is userId for DMs, groupId for groups
    await this.client.sendMessage({
      toUserId: conversationId,
      text: text || undefined,
      contextToken: ctx,
      images: imageUploads.length > 0 ? imageUploads : undefined,
    });

    const messageId = Date.now();
    const rawMessage: WeChatRawMessage = {
      messageId,
      fromUserId: this.botUserId ?? "",
      toUserId: conversationId,
      groupId: decoded.type === "group" ? conversationId : undefined,
      text,
      createTime: Date.now(),
      contextToken: ctx,
      media: [],
      raw: {},
    };

    return {
      id: String(messageId),
      threadId,
      raw: rawMessage,
    };
  }

  // --- Typing ---

  override async startTyping(threadId: string): Promise<void> {
    try {
      const { conversationId } = resolveThreadId(threadId);
      const ctx = this.pollState.contextTokens[conversationId];
      if (!ctx) return;

      const config = await this.client.getConfig(conversationId, ctx);
      if (config.typing_ticket) {
        await this.client.sendTyping(conversationId, config.typing_ticket, 1);
      }
    } catch {
      // Typing is best-effort
    }
  }

  // --- Media CDN ---

  protected async downloadFromCdn(encryptQueryParam: string): Promise<Buffer> {
    return this.client.downloadFromCdn(encryptQueryParam);
  }

  private static readonly UPLOAD_MAX_RETRIES = 3;

  async uploadImage(
    toUserId: string,
    imageData: Buffer
  ): Promise<{
    encryptQueryParam: string;
    aesKeyB64: string;
    ciphertextSize: number;
  }> {
    const aesKey = crypto.randomBytes(16);
    const aesKeyHex = aesKey.toString("hex");
    const rawSize = imageData.length;
    const rawMd5 = fileMd5(imageData);
    const encrypted = aesEcbEncrypt(imageData, aesKey);

    let lastError: Error | undefined;
    for (
      let attempt = 1;
      attempt <= WeChatAcpAdapter.UPLOAD_MAX_RETRIES;
      attempt++
    ) {
      const filekey = generateFileKey(); // new filekey per retry
      try {
        const uploadUrlResp = await this.client.getUploadUrl({
          filekey,
          mediaType: 1, // IMAGE
          toUserId,
          rawSize,
          rawFileMd5: rawMd5,
          fileSize: encrypted.length,
          aesKeyHex,
        });

        let cdnUrl: string;
        if (uploadUrlResp.upload_full_url) {
          cdnUrl = uploadUrlResp.upload_full_url;
        } else if (uploadUrlResp.upload_param) {
          cdnUrl = `${this.config.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(uploadUrlResp.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
        } else {
          throw new NetworkError(
            "wechat-acp",
            "getUploadUrl returned neither upload_full_url nor upload_param"
          );
        }

        const encryptQueryParam = await this.client.uploadToCdn(
          cdnUrl,
          encrypted
        );

        return {
          encryptQueryParam,
          aesKeyB64: encodeAesKeyForSend(aesKey),
          ciphertextSize: encrypted.length,
        };
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        // Abort on 4xx client errors (no point retrying)
        if (lastError.message.includes("client error")) {
          throw lastError;
        }
        if (attempt < WeChatAcpAdapter.UPLOAD_MAX_RETRIES) {
          const backoffMs = 2 ** attempt * 1000;
          this.logger.warn(
            `CDN upload attempt ${attempt} failed, retrying in ${backoffMs}ms`,
            { error: String(error) }
          );
          await new Promise((r) => setTimeout(r, backoffMs));
        }
      }
    }

    throw lastError ?? new NetworkError("wechat-acp", "CDN upload failed");
  }

  // --- Persistence ---

  private async loadAccount(): Promise<AccountData | null> {
    if (this.config.accountStorage) {
      return this.config.accountStorage.load();
    }
    try {
      const filePath = path.join(this.config.dataDir, "account.json");
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as AccountData;
    } catch {
      return null;
    }
  }

  private async saveAccount(account: AccountData): Promise<void> {
    if (this.config.accountStorage) {
      return this.config.accountStorage.save(account);
    }
    fs.mkdirSync(this.config.dataDir, { recursive: true });
    const filePath = path.join(this.config.dataDir, "account.json");
    fs.writeFileSync(filePath, JSON.stringify(account, null, 2), {
      mode: 0o600,
    });
  }

  private async loadPollState(): Promise<PollState> {
    if (this.config.stateStorage) {
      return (
        (await this.config.stateStorage.load()) ?? {
          updatesBuf: "",
          contextTokens: {},
          lastMessageId: 0,
        }
      );
    }
    try {
      const filePath = path.join(this.config.dataDir, "state.json");
      const data = fs.readFileSync(filePath, "utf-8");
      return JSON.parse(data) as PollState;
    } catch {
      return { updatesBuf: "", contextTokens: {}, lastMessageId: 0 };
    }
  }

  private async savePollState(): Promise<void> {
    if (this.config.stateStorage) {
      return this.config.stateStorage.save(this.pollState);
    }
    try {
      fs.mkdirSync(this.config.dataDir, { recursive: true });
      const filePath = path.join(this.config.dataDir, "state.json");
      fs.writeFileSync(filePath, JSON.stringify(this.pollState, null, 2));
    } catch {
      // Best-effort persistence
    }
  }
}

export function createWeChatAcpAdapter(
  config?: WeChatAcpAdapterConfig
): WeChatAcpAdapter {
  return new WeChatAcpAdapter(config);
}
