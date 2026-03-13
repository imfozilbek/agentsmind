export interface AIConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  /** Max concurrent API requests across all agents (default: 2) */
  maxConcurrency?: number;
  /** Min milliseconds between requests (default: 1000) */
  minIntervalMs?: number;
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
const MAX_RETRIES = 5;
const BASE_DELAY_MS = 2000;

export type MetricsCallback = (event: string, value: number, meta: Record<string, unknown>) => void;

// ─── Global Rate Limiter (shared across all AIClient instances) ───

class RateLimiter {
  private queue: (() => void)[] = [];
  private active = 0;
  private lastRequestTime = 0;

  constructor(
    private maxConcurrency: number,
    private minIntervalMs: number,
  ) {}

  async acquire(): Promise<void> {
    // Wait for a slot to open
    while (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    this.active++;

    // Enforce minimum interval between requests
    const now = Date.now();
    const elapsed = now - this.lastRequestTime;
    if (elapsed < this.minIntervalMs) {
      await Bun.sleep(this.minIntervalMs - elapsed);
    }
    this.lastRequestTime = Date.now();
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) next();
  }

  get pending(): number {
    return this.queue.length;
  }

  get running(): number {
    return this.active;
  }
}

let globalLimiter: RateLimiter | null = null;

function getLimiter(config: AIConfig): RateLimiter {
  if (!globalLimiter) {
    globalLimiter = new RateLimiter(
      config.maxConcurrency ?? 2,
      config.minIntervalMs ?? 1000,
    );
  }
  return globalLimiter;
}

export class AIClient {
  private onMetric: MetricsCallback | null = null;
  private limiter: RateLimiter;

  constructor(private config: AIConfig) {
    this.limiter = getLimiter(config);
  }

  setMetricsCallback(cb: MetricsCallback): void {
    this.onMetric = cb;
  }

  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.limiter.acquire();
      try {
        const res = await fetch(url, init);

        if (res.ok) return res;

        const body = await res.text();

        if (RETRYABLE_STATUSES.has(res.status) && attempt < MAX_RETRIES) {
          // On 429, use longer backoff
          const base = res.status === 429 ? BASE_DELAY_MS * 2 : BASE_DELAY_MS;
          const delay = base * Math.pow(2, attempt);
          console.warn(`[AI] ${res.status} on attempt ${attempt + 1}/${MAX_RETRIES}, retrying in ${delay}ms... (queue: ${this.limiter.pending})`);
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
          console.warn(`[AI] Network error on attempt ${attempt + 1}/${MAX_RETRIES}, retrying in ${delay}ms...`);
          await Bun.sleep(delay);
          lastError = err as Error;
          continue;
        }

        throw err;
      } finally {
        this.limiter.release();
      }
    }

    throw lastError ?? new Error("AI request failed after retries");
  }

  async chat(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<ChatResponse> {
    const start = performance.now();

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

    const latency = Math.round(performance.now() - start);

    const data = await res.json() as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
    };

    this.onMetric?.("ai_chat", data.usage.total_tokens, {
      prompt_tokens: data.usage.prompt_tokens,
      completion_tokens: data.usage.completion_tokens,
      latency_ms: latency,
      model: this.config.model,
    });

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
