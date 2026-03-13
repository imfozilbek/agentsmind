import { AIClient, type AIConfig, type ChatMessage } from "../ai/client.ts";

export interface AgentConfig {
  id: string;
  apiKey: string;
  serverUrl: string;
  ai: AIConfig;
  workDir?: string;
  pollInterval?: number;
}

export abstract class BaseAgent {
  protected ai: AIClient;
  protected running = false;
  private busy = false;
  private stopResolve: (() => void) | null = null;

  constructor(protected config: AgentConfig) {
    this.ai = new AIClient(config.ai);
    this.ai.setMetricsCallback((event, value, meta) => {
      this.reportMetric(event, value, meta).catch(() => {});
    });
  }

  abstract get role(): string;

  async start(): Promise<void> {
    this.running = true;
    console.log(`[${this.config.id}] Agent started (role: ${this.role})`);
    await this.post("general", `Agent ${this.config.id} online. Role: ${this.role}`);

    while (this.running) {
      try {
        this.busy = true;
        await this.tick();
      } catch (err) {
        console.error(`[${this.config.id}] Error:`, err);
      } finally {
        this.busy = false;
      }

      if (!this.running) break;
      await Bun.sleep(this.config.pollInterval ?? 5000);
    }

    console.log(`[${this.config.id}] Agent stopped cleanly`);
    this.stopResolve?.();
  }

  stop(): Promise<void> {
    this.running = false;
    console.log(`[${this.config.id}] Stopping${this.busy ? " (waiting for current task)..." : "..."}`);

    if (!this.busy) return Promise.resolve();

    return new Promise<void>((resolve) => {
      this.stopResolve = resolve;
    });
  }

  get isBusy(): boolean {
    return this.busy;
  }

  protected abstract tick(): Promise<void>;

  // ─── Server API helpers ───

  protected async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(`${this.config.serverUrl}/api${path}`, {
          method,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.config.apiKey}`,
          },
          body: body ? JSON.stringify(body) : undefined,
        });

        if (res.ok) return res.json() as Promise<T>;

        const err = await res.text();

        // Retry on server errors and rate limits
        if ((res.status >= 500 || res.status === 429) && attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          console.warn(`[${this.config.id}] API ${method} ${path} returned ${res.status}, retrying in ${delay}ms...`);
          await Bun.sleep(delay);
          continue;
        }

        throw new Error(`API ${method} ${path} failed (${res.status}): ${err}`);
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("API ")) throw err;

        if (attempt < maxRetries) {
          const delay = 1000 * Math.pow(2, attempt);
          console.warn(`[${this.config.id}] API ${method} ${path} network error, retrying in ${delay}ms...`);
          await Bun.sleep(delay);
          continue;
        }

        throw err;
      }
    }

    throw new Error(`API ${method} ${path} failed after ${maxRetries} retries`);
  }

  protected get<T>(path: string): Promise<T> {
    return this.api<T>("GET", path);
  }

  protected post<T>(channel: string, content: string): Promise<T> {
    return this.api<T>("POST", `/channels/${channel}/posts`, { content });
  }

  protected async chat(messages: ChatMessage[], options?: { temperature?: number; maxTokens?: number }): Promise<string> {
    const response = await this.ai.chat(messages, options);
    return response.content;
  }

  // ─── Metrics ───

  protected async reportMetric(event: string, value: number, meta: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.api("POST", "/metrics", { event, value, meta });
    } catch { /* metrics are best-effort */ }
  }

  protected trackTask(taskId: number): () => Promise<void> {
    const start = performance.now();
    return async () => {
      const duration = Math.round(performance.now() - start);
      await this.reportMetric("task_done", duration, { task_id: taskId });
    };
  }

  protected async reportTaskFailed(taskId: number, error: string): Promise<void> {
    await this.reportMetric("task_failed", 0, { task_id: taskId, error });
  }

  protected async pushBundle(bundlePath: string): Promise<{ indexed: string[] }> {
    const file = Bun.file(bundlePath);
    const body = await file.arrayBuffer();

    const res = await fetch(`${this.config.serverUrl}/api/commits/push`, {
      method: "POST",
      headers: {
        "Content-Type": "application/octet-stream",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Push failed (${res.status}): ${err}`);
    }

    return res.json() as Promise<{ indexed: string[] }>;
  }
}
