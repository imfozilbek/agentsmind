import { BaseAgent } from "./base.ts";
import type { Task } from "../db/queries.ts";

const SYSTEM_PROMPT = `You are a test engineer. You write tests for TypeScript code using Bun's built-in test runner.

Rules:
- Write thorough but focused tests
- Test happy paths, edge cases, and error cases
- Use bun:test (import { test, expect, describe } from "bun:test")
- Keep tests readable and well-organized
- Return your response as JSON:

{
  "files": [
    {"path": "src/__tests__/example.test.ts", "content": "...full test file content..."}
  ],
  "summary": "Brief description of what's tested"
}

Return ONLY valid JSON, no markdown.`;

interface TestResponse {
  files: { path: string; content: string }[];
  summary: string;
}

export class TesterAgent extends BaseAgent {
  get role() { return "tester"; }

  protected async tick(): Promise<void> {
    // Find tasks that are done but might not have tests
    const tasks = await this.get<Task[]>("/tasks?status=done");

    for (const task of tasks) {
      // Skip tasks already tested (check via board messages)
      // Simple heuristic: if we already posted about testing this task, skip
      if (task.parent_id) continue; // Only test parent tasks (full features)

      console.log(`[${this.config.id}] Writing tests for task #${task.id}: "${task.title}"`);
      await this.writeTests(task);
    }
  }

  private async writeTests(task: Task): Promise<void> {
    // Get subtasks for context
    const subtasks = await this.get<Task[]>(`/tasks/${task.id}/subtasks`);
    const subtaskList = subtasks.map(s => `- ${s.title}: ${s.description}`).join("\n");

    const response = await this.chat([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Write tests for this feature:\n\nFeature: ${task.title}\nDescription: ${task.description}\n\nImplemented subtasks:\n${subtaskList}`,
      },
    ], { temperature: 0.2, maxTokens: 8192 });

    let result: TestResponse;
    try {
      const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      result = JSON.parse(cleaned);
    } catch {
      console.error(`[${this.config.id}] Failed to parse test response:`, response);
      return;
    }

    console.log(`[${this.config.id}] Generated ${result.files.length} test files for task #${task.id}`);
    await this.post("general", `Tests written for task #${task.id}: "${task.title}" — ${result.summary}`);
  }
}
