export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}
export interface LlmRequest {
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  json?: boolean;
  cache?: boolean;
  /** Gemini only (diagnostics): override the thinking config. Default = provider decides. */
  thinking?: "off" | "low" | "minimal" | "model";
}
export interface LlmResponse {
  text: string;
  model: string; // provider:model
  provider: string;
  tokensIn: number;
  tokensOut: number;
  cached?: boolean;
  keyIndex?: number;
}
export class ProviderError extends Error {
  constructor(
    message: string,
    public status: number,
    public retryAfterMs?: number,
    /** For 429s: which quota window ran out, when the provider says so ("day" parks the model much longer). */
    public quota?: "minute" | "day",
  ) {
    super(message);
  }
}
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export interface ProviderCall {
  model: string; // model name without provider prefix
  req: LlmRequest;
  key?: string;
  fetcher: Fetcher;
}
export interface Provider {
  name: string;
  needsKey: boolean;
  call(c: ProviderCall): Promise<LlmResponse>;
}
