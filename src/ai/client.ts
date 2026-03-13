export interface AIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatResponse {
  content: string;
  usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

export interface FIMRequest {
  prompt: string;
  suffix: string;
  maxTokens?: number;
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

export class AIClient {
  constructor(private config: AIConfig) {}

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const res = await fetch(url, init);

        if (res.ok) return res;

        const body = await res.text();

        if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[AI] ${res.status} on attempt ${attempt + 1}, retrying in ${delay}ms...`);
          await Bun.sleep(delay);
          lastError = new Error(`AI API error (${res.status}): ${body}`);
          continue;
        }

        throw new Error(`AI API error (${res.status}): ${body}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("AI API error")) throw err;

        // Network error — retry
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY_MS * Math.pow(2, attempt);
          console.warn(`[AI] Network error on attempt ${attempt + 1}, retrying in ${delay}ms...`);
          await Bun.sleep(delay);
          lastError = err as Error;
          continue;
        }

        throw err;
      }
    }

    throw lastError ?? new Error("AI request failed after retries");
  }

  async chat(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<ChatResponse> {
    const res = await this.fetchWithRetry(`${this.config.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        messages,
        temperature: options?.temperature ?? 0.7,
        max_tokens: options?.maxTokens ?? 4096,
      }),
    });

    const data = await res.json() as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    return {
      content: data.choices[0]!.message.content,
      usage: data.usage,
    };
  }

  async fim(request: FIMRequest): Promise<string> {
    const res = await this.fetchWithRetry(`${this.config.baseUrl}/fim/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: JSON.stringify({
        model: this.config.model,
        prompt: request.prompt,
        suffix: request.suffix,
        max_tokens: request.maxTokens ?? 2048,
      }),
    });

    const data = await res.json() as {
      choices: { text: string }[];
    };

    return data.choices[0]!.text;
  }
}
