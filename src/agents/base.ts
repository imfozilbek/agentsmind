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

  constructor(protected config: AgentConfig) {
    this.ai = new AIClient(config.ai);
  }

  abstract get role(): string;

  async start(): Promise<void> {
    this.running = true;
    console.log(`[${this.config.id}] Agent started (role: ${this.role})`);
    await this.post("general", `Agent ${this.config.id} online. Role: ${this.role}`);

    while (this.running) {
      try {
        await this.tick();
      } catch (err) {
        console.error(`[${this.config.id}] Error:`, err);
      }
      await Bun.sleep(this.config.pollInterval ?? 5000);
    }
  }

  stop(): void {
    this.running = false;
    console.log(`[${this.config.id}] Agent stopped`);
  }

  protected abstract tick(): Promise<void>;

  // ─── Server API helpers ───

  protected async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.config.serverUrl}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.config.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`API ${method} ${path} failed (${res.status}): ${err}`);
    }

    return res.json() as Promise<T>;
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
