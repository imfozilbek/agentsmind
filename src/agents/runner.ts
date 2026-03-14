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
  /** Max minutes a task can stay in_progress before auto-reset (default: 10) */
  stuckTimeoutMinutes?: number;
}

const AGENT_CLASSES = {
  planner: PlannerAgent,
  coder: CoderAgent,
  reviewer: ReviewerAgent,
  tester: TesterAgent,
} as const;

interface TaskSummary {
  id: number;
  title: string;
  status: string;
  assigned_to: string | null;
  updated_at: string;
}

export class AgentRunner {
  private agents: BaseAgent[] = [];
  private apiKeys = new Map<string, string>();
  private serverUrl: string;
  private watchdogTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private config: RunnerConfig) {
    this.serverUrl = config.serverUrl;
  }

  private get firstApiKey(): string {
    const key = this.apiKeys.values().next().value;
    if (!key) throw new Error("No agents registered");
    return key;
  }

  async start(): Promise<void> {
    console.log("Registering agents...");

    for (const [role, AgentClass] of Object.entries(AGENT_CLASSES)) {
      const count = this.config.agents[`${role}s` as keyof typeof this.config.agents] ?? 0;

      for (let i = 0; i < count; i++) {
        const id = `${role}-${i + 1}`;
        const apiKey = await this.register(id, role);
        this.apiKeys.set(id, apiKey);

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

    // Start stuck-task watchdog (every 60s)
    this.startWatchdog();

    // Start all agents concurrently
    await Promise.all(this.agents.map(a => a.start()));
  }

  async stop(): Promise<void> {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
    console.log(`Stopping ${this.agents.length} agents gracefully...`);
    await Promise.all(this.agents.map(a => a.stop()));
    console.log("All agents stopped.");
  }

  // ─── Stuck Task Watchdog ───

  private startWatchdog(): void {
    const timeoutMs = (this.config.stuckTimeoutMinutes ?? 10) * 60 * 1000;
    console.log(`[watchdog] Monitoring stuck tasks (timeout: ${this.config.stuckTimeoutMinutes ?? 10}min)`);

    const checkInterval = Math.max(timeoutMs / 2, 10_000);
    this.watchdogTimer = setInterval(async () => {
      try {
        await this.checkStuckTasks(timeoutMs);
        await this.checkParentCompletion();
      } catch (err) {
        console.error("[watchdog] Error:", err);
      }
    }, checkInterval);
  }

  private async checkStuckTasks(timeoutMs: number): Promise<void> {
    const tasks = await this.fetchTasks("in_progress");
    const now = Date.now();

    for (const task of tasks) {
      const updatedAt = new Date(task.updated_at + "Z").getTime();
      const elapsed = now - updatedAt;

      if (elapsed > timeoutMs) {
        console.log(`[watchdog] Task #${task.id} stuck in_progress for ${Math.round(elapsed / 60000)}min — resetting to todo`);

        try {
          const didReset = await this.resetTask(task.id);
          if (!didReset) continue; // task already moved to another status
          await this.postPublic(
            "general",
            `[watchdog] Task #${task.id} "${task.title}" was stuck for ${Math.round(elapsed / 60000)}min. Reset to todo for reassignment.`,
          );
        } catch (err) {
          console.error(`[watchdog] Failed to reset task #${task.id}:`, err);
        }
      }
    }
  }

  private async checkParentCompletion(): Promise<void> {
    // Find parent tasks in "planned" status where all subtasks are done
    const planned = await this.fetchTasks("planned");
    for (const parent of planned) {
      try {
        const res = await fetch(`${this.serverUrl}/api/tasks/${parent.id}/subtasks`, {
          headers: { Authorization: `Bearer ${this.firstApiKey}` },
        });
        if (!res.ok) continue;
        const subtasks = (await res.json()) as TaskSummary[];
        if (subtasks.length === 0) continue;
        const allDone = subtasks.every(s => s.status === "done");
        if (allDone) {
          await fetch(`${this.serverUrl}/api/tasks/${parent.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.firstApiKey}` },
            body: JSON.stringify({ status: "done" }),
          });
          console.log(`[watchdog] Parent task #${parent.id} completed — all ${subtasks.length} subtasks done`);
          await this.postPublic("general", `Task #${parent.id} "${parent.title}" completed — all subtasks done!`);
        }
      } catch { /* best-effort */ }
    }
  }

  private async fetchTasks(status: string): Promise<TaskSummary[]> {
    const res = await fetch(`${this.serverUrl}/api/tasks?status=${status}&limit=200`, {
      headers: {
        Authorization: `Bearer ${this.firstApiKey}`,
      },
    });
    if (!res.ok) return [];
    return res.json() as Promise<TaskSummary[]>;
  }

  private async resetTask(taskId: number): Promise<boolean> {
    // Re-check task is still in_progress before resetting
    const res = await fetch(`${this.serverUrl}/api/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${this.firstApiKey}` },
    });
    if (!res.ok) return false;
    const task = (await res.json()) as TaskSummary;
    if (task.status !== "in_progress") return false;

    await fetch(`${this.serverUrl}/api/tasks/${taskId}`, {
      method: "PATCH",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.firstApiKey}`,
      },
      body: JSON.stringify({ status: "todo", assigned_to: null }),
    });
    return true;
  }

  private async postPublic(channel: string, content: string): Promise<void> {
    try {
      await fetch(`${this.serverUrl}/api/channels/${channel}/posts`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.firstApiKey}`,
        },
        body: JSON.stringify({ content }),
      });
    } catch { /* best-effort */ }
  }

  private async register(id: string, role: string, attempt = 0): Promise<string> {
    if (attempt > 5) throw new Error(`Failed to register agent ${id} after ${attempt} attempts`);

    try {
      const res = await fetch(`${this.serverUrl}/api/agents/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, role }),
      });

      if (res.status === 409) {
        const newId = `${id}-${Date.now().toString(36).slice(-4)}`;
        return this.register(newId, role, attempt + 1);
      }

      const data = await res.json() as { api_key: string };
      console.log(`  Registered: ${id} (${role})`);
      return data.api_key;
    } catch (err) {
      throw new Error(`Failed to register agent ${id}: ${err}`);
    }
  }

  private async apiPublic(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(`${this.serverUrl}/api${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.firstApiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return res.json();
  }
}
