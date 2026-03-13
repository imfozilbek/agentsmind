import type { AIConfig } from "../ai/client.ts";
import type { BaseAgent } from "./base.ts";
import { PlannerAgent } from "./planner.ts";
import { CoderAgent } from "./coder.ts";
import { ReviewerAgent } from "./reviewer.ts";
import { TesterAgent } from "./tester.ts";

export interface RunnerConfig {
  serverUrl: string;
  ai: AIConfig;
  agents: {
    planners?: number;
    coders?: number;
    reviewers?: number;
    testers?: number;
  };
}

const AGENT_CLASSES = {
  planner: PlannerAgent,
  coder: CoderAgent,
  reviewer: ReviewerAgent,
  tester: TesterAgent,
} as const;

export class AgentRunner {
  private agents: BaseAgent[] = [];
  private serverUrl: string;

  constructor(private config: RunnerConfig) {
    this.serverUrl = config.serverUrl;
  }

  async start(): Promise<void> {
    console.log("Registering agents...");

    for (const [role, AgentClass] of Object.entries(AGENT_CLASSES)) {
      const count = this.config.agents[`${role}s` as keyof typeof this.config.agents] ?? 0;

      for (let i = 0; i < count; i++) {
        const id = `${role}-${i + 1}`;
        const apiKey = await this.register(id, role);

        const agent = new AgentClass({
          id,
          apiKey,
          serverUrl: this.serverUrl,
          ai: this.config.ai,
          pollInterval: role === "planner" ? 3000 : 5000,
        });

        this.agents.push(agent);
      }
    }

    console.log(`Starting ${this.agents.length} agents...`);

    // Ensure general channel exists
    try {
      await this.apiPublic("POST", "/channels", { name: "general", description: "Agent coordination" });
    } catch { /* channel may already exist */ }

    // Start all agents concurrently
    await Promise.all(this.agents.map(a => a.start()));
  }

  async stop(): Promise<void> {
    console.log(`Stopping ${this.agents.length} agents gracefully...`);
    await Promise.all(this.agents.map(a => a.stop()));
    console.log("All agents stopped.");
  }

  private async register(id: string, role: string): Promise<string> {
    try {
      const res = await fetch(`${this.serverUrl}/api/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, role }),
      });

      if (res.status === 409) {
        // Agent already exists, we need the key — re-register not possible
        // In production, keys should be persisted. For now, generate a new agent with suffix.
        const newId = `${id}-${Date.now().toString(36).slice(-4)}`;
        return this.register(newId, role);
      }

      const data = await res.json() as { api_key: string };
      console.log(`  Registered: ${id} (${role})`);
      return data.api_key;
    } catch (err) {
      throw new Error(`Failed to register agent ${id}: ${err}`);
    }
  }

  private async apiPublic(method: string, path: string, body?: unknown): Promise<unknown> {
    const firstAgent = this.agents[0];
    if (!firstAgent) throw new Error("No agents registered");

    const res = await fetch(`${this.serverUrl}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${(firstAgent as any).config.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }
}
