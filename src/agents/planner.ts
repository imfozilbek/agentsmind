import { BaseAgent } from "./base.ts";
import type { Task } from "../db/queries.ts";

const SYSTEM_PROMPT = `You are a technical project planner. Your job is to break down development tasks into small, concrete subtasks that a coding agent can implement one at a time.

Rules:
- Each subtask must be independently implementable
- Each subtask must have a clear, specific title
- Order subtasks by dependency (what must be done first)
- Keep subtasks small (1-2 files changed max)
- Return ONLY valid JSON array, no markdown

Example output:
[
  {"title": "Create User model with id, email, password fields", "description": "Add User type and SQLite table", "priority": 10},
  {"title": "Add password hashing with bcrypt", "description": "Hash passwords before storing", "priority": 9},
  {"title": "Create POST /auth/register endpoint", "description": "Validate input, create user, return token", "priority": 8}
]`;

interface Subtask {
  title: string;
  description: string;
  priority: number;
}

export class PlannerAgent extends BaseAgent {
  get role() { return "planner"; }

  protected async tick(): Promise<void> {
    const tasks = await this.get<Task[]>("/tasks?status=todo");
    const unplanned = tasks.filter(t => !t.parent_id);

    for (const task of unplanned) {
      const subtasks = await this.get<Task[]>(`/tasks/${task.id}/subtasks`);
      if (subtasks.length > 0) continue;

      console.log(`[${this.config.id}] Planning: "${task.title}"`);
      await this.plan(task);
    }
  }

  private async plan(task: Task): Promise<void> {
    const response = await this.chat([
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: `Break down this task:\n\nTitle: ${task.title}\nDescription: ${task.description}` },
    ], { temperature: 0.3 });

    let subtasks: Subtask[];
    try {
      subtasks = this.parseAIJson<Subtask[]>(response, Array.isArray);
    } catch {
      console.error(`[${this.config.id}] Failed to parse planner response:`, response);
      return;
    }

    for (const sub of subtasks) {
      await this.api("POST", "/tasks", {
        title: sub.title,
        description: sub.description,
        priority: sub.priority,
        parent_id: task.id,
      });
    }

    await this.api("PATCH", `/tasks/${task.id}`, { status: "planned" });
    await this.post("general", `Planned task #${task.id} "${task.title}" → ${subtasks.length} subtasks`);
    console.log(`[${this.config.id}] Created ${subtasks.length} subtasks for task #${task.id}`);
  }
}
