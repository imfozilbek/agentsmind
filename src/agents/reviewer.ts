import { BaseAgent } from "./base.ts";
import type { Task } from "../db/queries.ts";

const SYSTEM_PROMPT = `You are a senior code reviewer. You review code changes for quality, correctness, and security.

Rules:
- Focus on bugs, security issues, and logic errors
- Ignore style preferences (formatting, naming conventions)
- Be concise and actionable
- Return your response as JSON:

If code is good:
{"status": "approved", "comment": "Brief summary of what looks good"}

If changes needed:
{"status": "changes_requested", "comment": "Specific issues found:\\n1. Issue description\\n2. Issue description"}

Return ONLY valid JSON, no markdown.`;

interface ReviewResponse {
  status: "approved" | "changes_requested";
  comment: string;
}

export class ReviewerAgent extends BaseAgent {
  get role() { return "reviewer"; }

  protected async tick(): Promise<void> {
    const tasks = await this.get<Task[]>("/tasks?status=review");

    for (const task of tasks) {
      // Don't review own work
      if (task.assigned_to === this.config.id) continue;

      console.log(`[${this.config.id}] Reviewing task #${task.id}: "${task.title}"`);
      await this.review(task);
    }
  }

  private async review(task: Task): Promise<void> {
    if (!task.output) {
      console.log(`[${this.config.id}] Task #${task.id} has no output, skipping`);
      return;
    }

    const response = await this.chat([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Review this task implementation:\n\nTask: ${task.title}\nDescription: ${task.description}\nAssigned to: ${task.assigned_to}\n\nGenerated code:\n${task.output}`,
      },
    ], { temperature: 0.1 });

    let result: ReviewResponse;
    try {
      const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      result = JSON.parse(cleaned);
    } catch {
      console.error(`[${this.config.id}] Failed to parse review response:`, response);
      return;
    }

    if (task.commit_hash) {
      await this.api("POST", "/reviews", {
        commit_hash: task.commit_hash,
        status: result.status,
        comment: result.comment,
      });
    }

    if (result.status === "approved") {
      await this.api("PATCH", `/tasks/${task.id}`, { status: "done" });
      await this.post("general", `Approved task #${task.id}: "${task.title}"`);
    } else {
      await this.api("PATCH", `/tasks/${task.id}`, { status: "in_progress" });
      await this.post("general", `Changes requested on task #${task.id}: ${result.comment}`);
    }

    console.log(`[${this.config.id}] Review for task #${task.id}: ${result.status}`);
  }
}
