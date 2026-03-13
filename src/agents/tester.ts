import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BaseAgent } from "./base.ts";
import type { Task } from "../db/queries.ts";

const SYSTEM_PROMPT = `You are a test engineer. You write tests for TypeScript code using Bun's built-in test runner.

Rules:
- Write thorough but focused tests
- Test happy paths, edge cases, and error cases
- Use bun:test (import { test, expect, describe } from "bun:test")
- Keep tests readable and well-organized
- Tests must be self-contained — mock external dependencies if needed
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

interface TestResult {
  passed: boolean;
  output: string;
  exitCode: number;
}

export class TesterAgent extends BaseAgent {
  private repoPath: string = "";

  get role() { return "tester"; }

  override async start(): Promise<void> {
    this.repoPath = resolve(
      this.config.workDir
        ? join(this.config.workDir, this.config.id)
        : join("data", "workspaces", this.config.id)
    );

    if (!existsSync(this.repoPath)) {
      mkdirSync(this.repoPath, { recursive: true });
    }

    await super.start();
  }

  protected async tick(): Promise<void> {
    const tasks = await this.get<Task[]>("/tasks?status=done");

    for (const task of tasks) {
      if (task.parent_id) continue; // Only test parent tasks (full features)
      if (!task.output) continue;

      console.log(`[${this.config.id}] Writing tests for task #${task.id}: "${task.title}"`);
      await this.writeAndRunTests(task);
    }
  }

  private async writeAndRunTests(task: Task): Promise<void> {
    // Gather code from subtasks
    const subtasks = await this.get<Task[]>(`/tasks/${task.id}/subtasks`);
    const done = subtasks.filter(s => s.status === "done" || s.status === "review");

    let codeContext = "";
    for (const sub of done) {
      if (!sub.output) continue;
      try {
        const parsed = JSON.parse(sub.output) as { files: { path: string; content: string }[] };
        for (const file of parsed.files) {
          codeContext += `\nFile: ${file.path}\n\`\`\`typescript\n${file.content}\n\`\`\`\n`;
        }
      } catch { /* skip */ }
    }

    const response = await this.chat([
      { role: "system", content: SYSTEM_PROMPT },
      {
        role: "user",
        content: `Write tests for this feature:\n\nFeature: ${task.title}\nDescription: ${task.description}\n\nSource code:\n${codeContext}`,
      },
    ], { temperature: 0.2, maxTokens: 8192 });

    let result: TestResponse;
    try {
      const cleaned = response.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      result = JSON.parse(cleaned);
    } catch {
      console.error(`[${this.config.id}] Failed to parse test response`);
      return;
    }

    // Write source files from subtasks to workspace
    for (const sub of done) {
      if (!sub.output) continue;
      try {
        const parsed = JSON.parse(sub.output) as { files: { path: string; content: string }[] };
        for (const file of parsed.files) {
          await this.writeFile(file.path, file.content);
        }
      } catch { /* skip */ }
    }

    // Write test files to workspace
    for (const file of result.files) {
      await this.writeFile(file.path, file.content);
    }

    // Run tests
    const testFiles = result.files.map(f => f.path);
    const testResult = await this.runTests(testFiles);

    console.log(`[${this.config.id}] Tests for task #${task.id}: ${testResult.passed ? "PASSED" : "FAILED"} (exit ${testResult.exitCode})`);

    const status = testResult.passed ? "passed" : "failed";
    const outputTruncated = testResult.output.length > 2000
      ? testResult.output.slice(-2000)
      : testResult.output;

    await this.post(
      "general",
      `Tests ${status} for task #${task.id}: "${task.title}" — ${result.summary}\n\`\`\`\n${outputTruncated}\n\`\`\``,
    );
  }

  private async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = join(this.repoPath, filePath);
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await Bun.write(fullPath, content);
  }

  private async runTests(testFiles: string[]): Promise<TestResult> {
    const absolutePaths = testFiles.map(f => join(this.repoPath, f));

    const proc = Bun.spawnSync(["bun", "test", ...absolutePaths], {
      cwd: this.repoPath,
      env: { ...process.env, NO_COLOR: "1" },
      timeout: 30_000,
    });

    const stdout = proc.stdout.toString();
    const stderr = proc.stderr.toString();
    const output = (stdout + "\n" + stderr).trim();

    return {
      passed: proc.exitCode === 0,
      output,
      exitCode: proc.exitCode ?? 1,
    };
  }
}
