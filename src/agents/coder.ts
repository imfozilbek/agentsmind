import { BaseAgent } from "./base.ts";
import type { Task } from "../db/queries.ts";

const SYSTEM_PROMPT = `You are a senior software engineer. You write clean, minimal TypeScript code.

Rules:
- Write only the code needed for the task
- No over-engineering, no unnecessary abstractions
- Include proper error handling
- Use TypeScript strict mode conventions
- Return your response as a JSON object with this structure:

{
  "files": [
    {"path": "src/example.ts", "content": "...full file content..."},
    {"path": "src/other.ts", "content": "...full file content..."}
  ],
  "commit_message": "feat: short description of changes"
}

Return ONLY valid JSON, no markdown.`;

interface CodeResponse {
  files: { path: string; content: string }[];
  commit_message: string;
}

export class CoderAgent extends BaseAgent {
  get role() { return "coder"; }

  protected async tick(): Promise<void> {
    // Find unassigned subtasks (tasks with parent_id that are still todo)
    const tasks = await this.get<Task[]>("/tasks?status=todo");
    const available = tasks.filter(t => t.parent_id && !t.assigned_to);

    if (available.length === 0) return;

    // Take the highest priority task
    const task = available[0]!;
    await this.api("POST", `/tasks/${task.id}/assign`, { agent_id: this.config.id });
    console.log(`[${this.config.id}] Working on: "${task.title}"`);

    await this.post("general", `Taking task #${task.id}: "${task.title}"`);

    try {
      await this.implement(task);
    } catch (err) {
      console.error(`[${this.config.id}] Failed task #${task.id}:`, err);
      await this.api("PATCH", `/tasks/${task.id}`, { status: "failed" });
      await this.post("general", `Failed task #${task.id}: ${err}`);
    }
  }

  private async implement(task: Task): Promise<void> {
    // Get parent task for context
    let context = "";
    if (task.parent_id) {
      const parent = await this.get<Task>(`/tasks/${task.parent_id}`);
      context = `\nParent task: ${parent.title}\nParent description: ${parent.description}`;
    }

    // Get sibling tasks for awareness
    const siblings = task.parent_id
      ? await this.get<Task[]>(`/tasks/${task.parent_id}/subtasks`)
      : [];
    const completed = siblings.filter(s => s.status === "done" && s.id !== task.id);
    if (completed.length > 0) {
      context += `\n\nAlready completed subtasks:\n${completed.map(s => `- ${s.title}`).join("\n")}`;
    }

    const response = await this.chat([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Implement this task:\n\nTitle: ${task.title}\nDescription: ${task.description}${context}`,
      },
    ], { temperature: 0.2, maxTokens: 8192 });

    let result: CodeResponse;
    try {
      const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      result = JSON.parse(cleaned);
    } catch {
      console.error(`[${this.config.id}] Failed to parse coder response:`, response);
      await this.api("PATCH", `/tasks/${task.id}`, { status: "failed" });
      return;
    }

    console.log(`[${this.config.id}] Generated ${result.files.length} files for task #${task.id}`);

    // Save generated code to task output and mark for review
    const output = JSON.stringify(result, null, 2);
    await this.api("PATCH", `/tasks/${task.id}`, { status: "review", output });
    await this.post(
      "general",
      `Completed task #${task.id}: "${task.title}" → ${result.files.length} files. Ready for review.`,
    );
  }
}
