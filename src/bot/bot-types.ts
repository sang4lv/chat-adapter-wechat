/**
 * Types for the WeChat Official Dialog Platform API.
 * Reference: https://developers.weixin.qq.com/doc/aispeech/confapi/dialog/bot/query.html
 */

export interface BotTokenResponse {
  code: number;
  msg: string;
  request_id: string;
  data: {
    access_token: string;
  };
}

export interface BotQueryRequest {
  query: string;
  env?: "online" | "debug";
  first_priority_skills?: string[];
  second_priority_skills?: string[];
  user_name?: string;
  avatar?: string;
  userid?: string;
}

export interface BotQueryOption {
  ans_node_name: string;
  title: string;
  answer: string;
  confidence: number;
}

export interface BotQuerySlot {
  name: string;
  value: string;
  norm: string;
}

export interface BotQueryData {
  answer: string;
  answer_type?: string;
  skill_name?: string;
  intent_name?: string;
  msg_id?: string;
  status?: "FAQ" | "NOMATCH" | "CONTEXT_FAQ" | "GENERAL_FAQ" | "FAQ_RECOMMEND";
  options?: BotQueryOption[];
  slots?: BotQuerySlot[];
}

export interface BotQueryResponse {
  code: number;
  msg: string;
  request_id: string;
  data: BotQueryData;
}

// Parsed answer content types

export interface BotImageAnswer {
  image: { url: string; name?: string };
  name?: string;
}

export interface BotVoiceUrlAnswer {
  voice: { id: number; url: string; name?: string };
}

export interface BotVoiceMediaAnswer {
  voice: { media_id: string; name?: string; update_time?: number };
}

export interface BotVideoUrlAnswer {
  video: { id: number; url: string; title?: string; desc?: string };
  name?: string;
}

export interface BotVideoMediaAnswer {
  video: {
    media_id: string;
    title?: string;
    update_time?: number;
    cover_url?: string;
    description?: string;
  };
  name?: string;
}

export interface BotNewsAnswer {
  news: {
    articles: Array<{
      title: string;
      description?: string;
      url: string;
      picurl?: string;
      type?: "pm" | "h5";
    }>;
  };
}

export interface BotMiniProgramAnswer {
  miniprogrampage: {
    title: string;
    appid: string;
    pagepath: string;
    thumb_media_id?: string;
    thumb_url?: string;
  };
}

export interface BotStreamingAnswer {
  generate_url: string;
  ref_docs?: Array<{
    doc_name: string;
    ref_contents: Array<{ content: string }>;
  }>;
}

export interface BotMultiMsgAnswer {
  multimsg: string[];
}

export type BotAnswerContent =
  | string
  | BotImageAnswer
  | BotVoiceUrlAnswer
  | BotVoiceMediaAnswer
  | BotVideoUrlAnswer
  | BotVideoMediaAnswer
  | BotNewsAnswer
  | BotMiniProgramAnswer
  | BotStreamingAnswer
  | BotMultiMsgAnswer;
