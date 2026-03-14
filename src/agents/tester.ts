import { existsSync, mkdirSync } from "node:fs";
import { join, resolve, normalize } from "node:path";
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

  private testedTasks = new Set<number>();

  protected async tick(): Promise<void> {
    const tasks = await this.get<Task[]>("/tasks?status=done");

    for (const task of tasks) {
      if (task.parent_id) continue; // Only test parent tasks (full features)
      if (this.testedTasks.has(task.id)) continue; // Don't re-test same task

      console.log(`[${this.config.id}] Writing tests for task #${task.id}: "${task.title}"`);
      await this.writeAndRunTests(task);
      this.testedTasks.add(task.id);
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
      result = this.parseAIJson<TestResponse>(response);
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

    // If tests failed, send subtasks back to review for re-iteration
    if (!testResult.passed) {
      const subtasks = await this.get<Task[]>(`/tasks/${task.id}/subtasks`);
      const doneSubtasks = subtasks.filter(s => s.status === "done");
      for (const sub of doneSubtasks) {
        await this.api("PATCH", `/tasks/${sub.id}`, { status: "review" });
      }
      console.log(`[${this.config.id}] Sent ${doneSubtasks.length} subtasks back to review due to test failure`);
      await this.post(
        "general",
        `Test failure on task #${task.id} — sent ${doneSubtasks.length} subtasks back to review for fixes.`,
      );
      // Allow re-testing after fixes
      this.testedTasks.delete(task.id);
    }
  }

  private async writeFile(filePath: string, content: string): Promise<void> {
    const fullPath = resolve(join(this.repoPath, normalize(filePath)));
    if (!fullPath.startsWith(resolve(this.repoPath) + "/")) {
      console.error(`[${this.config.id}] Path traversal blocked: ${filePath}`);
      return;
    }
    const dir = join(fullPath, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    await Bun.write(fullPath, content);
  }

  private async runTests(testFiles: string[]): Promise<TestResult> {
    const absolutePaths = testFiles.map(f => join(this.repoPath, f));

    const safeEnv: Record<string, string | undefined> = { ...process.env, NO_COLOR: "1" };
    // Strip secrets from test subprocess
    delete safeEnv.AI_API_KEY;
    delete safeEnv.ADMIN_KEY;
    const proc = Bun.spawnSync(["bun", "test", ...absolutePaths], {
      cwd: this.repoPath,
      env: safeEnv,
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
