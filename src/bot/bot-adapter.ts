/**
 * WeChat Bot Adapter — Official Dialog Platform.
 *
 * Uses the /v2/bot/query API to send user messages to a pre-configured
 * chatbot and return its responses. Supports text, image, news, and
 * streaming response types.
 *
 * Reference: https://developers.weixin.qq.com/doc/aispeech/confapi/dialog/bot/query.html
 */

import type {
  AdapterPostableMessage,
  ChatInstance,
  RawMessage,
} from "chat";
import { ConsoleLogger, Message } from "chat";
import {
  extractCard,
  cardToFallbackText,
  AdapterError,
} from "@chat-adapter/shared";
import { WeChatBaseAdapter } from "../core/base-adapter.js";
import type {
  WeChatRawMessage,
} from "../core/types.js";
import { resolveThreadId } from "../core/utils.js";
import { BotClient } from "./bot-client.js";
import type {
  BotQueryResponse,
  BotQueryData,
} from "./bot-types.js";

export interface WeChatBotAdapterConfig {
  appId: string;
  token: string;
  aesKey: string;
  baseUrl?: string;
  env?: "online" | "debug";
  logger?: import("chat").Logger;
}

export class WeChatBotAdapter extends WeChatBaseAdapter {
  readonly name = "wechat-bot";

  private readonly client: BotClient;
  private readonly env: "online" | "debug";

  constructor(config: WeChatBotAdapterConfig) {
    const logger =
      config.logger ?? new ConsoleLogger("info").child("wechat-bot");
    super("wechat-bot", logger);

    this.client = new BotClient({
      appId: config.appId,
      token: config.token,
      aesKey: config.aesKey,
      baseUrl: config.baseUrl,
    });
    this.env = config.env ?? "online";
  }

  // --- Lifecycle ---

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;

    // Verify credentials by fetching an access token
    try {
      await this.client.getAccessToken();
      this.logger.info("WeChat Bot adapter initialized (official dialog platform)");
    } catch (error) {
      this.logger.error("Failed to initialize WeChat Bot adapter", {
        error: String(error),
      });
      throw error;
    }
  }

  async disconnect(): Promise<void> {
    // No persistent connections to clean up
  }

  // --- Sending (query the bot) ---

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage
  ): Promise<RawMessage<WeChatRawMessage>> {
    const { conversationId } = resolveThreadId(threadId);

    // Extract text content from the message
    const card = extractCard(message);
    const text = card
      ? cardToFallbackText(card)
      : this.formatConverter.renderPostable(message);

    if (!text.trim()) {
      throw new AdapterError("Cannot send empty query to bot", "wechat-bot");
    }

    // Query the official dialog platform
    const response = await this.client.query({
      query: text,
      userid: conversationId,
      env: this.env,
    });

    // Parse the bot response into a raw message
    const botAnswer = this.parseBotAnswer(response.data);
    const messageId = Date.now();

    const rawMessage: WeChatRawMessage = {
      messageId,
      fromUserId: "bot",
      toUserId: conversationId,
      text: botAnswer.text,
      createTime: Date.now(),
      media: [],
      raw: response,
    };

    // If the consumer has a chat instance, also create the bot's response
    // as a parseable message for the SDK
    return {
      id: String(messageId),
      threadId,
      raw: rawMessage,
    };
  }

  // --- Parse Bot Response ---

  private parseBotAnswer(data: BotQueryData): {
    text: string;
    imageUrl?: string;
  } {
    const answer = data.answer;

    // Try to parse as JSON for rich content types
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer);
    } catch {
      // Plain text answer — may contain <a> tags
      return { text: this.stripHtmlTags(answer) };
    }

    if (typeof parsed !== "object" || parsed === null) {
      return { text: answer };
    }

    const obj = parsed as Record<string, unknown>;

    // Image
    if ("image" in obj) {
      const img = obj.image as { url: string; name?: string };
      return { text: img.name ?? "", imageUrl: img.url };
    }

    // Voice (URL)
    if ("voice" in obj) {
      const voice = obj.voice as { url?: string; name?: string };
      if (voice.url) {
        return { text: `[Voice: ${voice.name ?? voice.url}]` };
      }
      return { text: "[Voice message (media library)]" };
    }

    // Video (URL)
    if ("video" in obj) {
      const video = obj.video as { url?: string; title?: string };
      if (video.url) {
        return { text: `[Video: ${video.title ?? video.url}]` };
      }
      return { text: "[Video message (media library)]" };
    }

    // News/Articles
    if ("news" in obj) {
      const news = obj.news as { articles: Array<{ title: string; url: string }> };
      const lines = news.articles.map(
        (a) => `${a.title} (${a.url})`
      );
      return { text: lines.join("\n") };
    }

    // Mini Program
    if ("miniprogrampage" in obj) {
      const mp = obj.miniprogrampage as { title: string; appid: string; pagepath: string };
      return { text: `[Mini Program: ${mp.title}]` };
    }

    // Streaming
    if ("generate_url" in obj) {
      return { text: `[Streaming response: ${obj.generate_url}]` };
    }

    // Combined messages
    if ("multimsg" in obj) {
      const msgs = obj.multimsg as string[];
      const parts = msgs.map((m) => {
        try {
          const sub = JSON.parse(m);
          return this.parseBotAnswer({ answer: JSON.stringify(sub) } as BotQueryData).text;
        } catch {
          return m;
        }
      });
      return { text: parts.join("\n") };
    }

    return { text: answer };
  }

  private stripHtmlTags(html: string): string {
    // Convert <a href="url">text</a> to text (url)
    let text = html.replace(
      /<a\s+href="([^"]*)"[^>]*>([^<]*)<\/a>/gi,
      "$2 ($1)"
    );
    // Remove any remaining HTML tags
    text = text.replace(/<[^>]+>/g, "");
    return text.trim();
  }

  // --- Media CDN (not used in bot mode) ---

  protected async downloadFromCdn(
    _encryptQueryParam: string
  ): Promise<Buffer> {
    throw new AdapterError(
      "CDN download not supported in bot mode",
      "wechat-bot"
    );
  }
}

export function createWeChatBotAdapter(
  config: WeChatBotAdapterConfig
): WeChatBotAdapter {
  return new WeChatBotAdapter(config);
}
