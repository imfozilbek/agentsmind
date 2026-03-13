import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { BaseAgent } from "./base.ts";
import type { Task } from "../db/queries.ts";

const SYSTEM_PROMPT = `You are a senior software engineer. You write clean, minimal TypeScript code.

Rules:
- Write only the code needed for the task
- No over-engineering, no unnecessary abstractions
- Include proper error handling
- Use TypeScript strict mode conventions
- When existing code is provided, BUILD ON IT — extend existing files rather than rewriting from scratch
- If a file already exists, include the FULL updated file content (not just the diff)
- Keep all existing functionality intact when adding new code
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
  private repoPath: string = "";

  get role() { return "coder"; }

  override async start(): Promise<void> {
    this.repoPath = resolve(
      this.config.workDir
        ? join(this.config.workDir, this.config.id)
        : join("data", "workspaces", this.config.id)
    );

    this.initRepo();
    await super.start();
  }

  private initRepo(): void {
    if (!existsSync(this.repoPath)) {
      mkdirSync(this.repoPath, { recursive: true });
      Bun.spawnSync(["git", "-C", this.repoPath, "init"]);
      Bun.spawnSync(["git", "-C", this.repoPath, "commit", "--allow-empty", "-m", "init"]);
      console.log(`[${this.config.id}] Initialized workspace at ${this.repoPath}`);
    }
  }

  protected async tick(): Promise<void> {
    const tasks = await this.get<Task[]>("/tasks?status=todo");
    const available = tasks.filter(t => t.parent_id && !t.assigned_to);

    if (available.length === 0) return;

    const task = available[0]!;
    await this.api("POST", `/tasks/${task.id}/assign`, { agent_id: this.config.id });
    console.log(`[${this.config.id}] Working on: "${task.title}"`);
    await this.post("general", `Taking task #${task.id}: "${task.title}"`);

    const done = this.trackTask(task.id);
    try {
      await this.implement(task);
      await done();
    } catch (err) {
      console.error(`[${this.config.id}] Failed task #${task.id}:`, err);
      await this.reportTaskFailed(task.id, String(err));
      await this.api("PATCH", `/tasks/${task.id}`, { status: "failed" });
      await this.post("general", `Failed task #${task.id}: ${err}`);
    }
  }

  private async buildContext(task: Task): Promise<string> {
    let context = "";

    // Parent task context
    if (task.parent_id) {
      const parent = await this.get<Task>(`/tasks/${task.parent_id}`);
      context += `\nParent task: ${parent.title}\nParent description: ${parent.description}`;
    }

    // Sibling tasks — gather code from completed ones
    const siblings = task.parent_id
      ? await this.get<Task[]>(`/tasks/${task.parent_id}/subtasks`)
      : [];

    const done = siblings.filter(s => (s.status === "done" || s.status === "review") && s.id !== task.id);

    // Collect existing files from completed siblings
    const existingFiles = new Map<string, string>();
    for (const sibling of done) {
      if (!sibling.output) continue;
      try {
        const parsed = JSON.parse(sibling.output) as CodeResponse;
        for (const file of parsed.files) {
          existingFiles.set(file.path, file.content);
        }
      } catch { /* skip unparseable output */ }
    }

    if (existingFiles.size > 0) {
      context += "\n\n--- EXISTING CODE (from completed subtasks) ---";
      for (const [path, content] of existingFiles) {
        context += `\n\nFile: ${path}\n\`\`\`typescript\n${content}\n\`\`\``;
      }
      context += "\n\n--- END EXISTING CODE ---";
      context += "\nIMPORTANT: Build on the existing code above. Extend files, don't rewrite them.";
    } else if (done.length > 0) {
      const titles = done.map(s => `- ${s.title}`).join("\n");
      context += `\n\nAlready completed subtasks:\n${titles}`;
    }

    // RAG — search codebase for relevant code
    const keywords = `${task.title} ${task.description}`.slice(0, 200);
    const searchResults = await this.searchCode(keywords);
    if (searchResults.length > 0) {
      const seen = new Set(existingFiles.keys());
      const relevant = searchResults.filter(r => !seen.has(r.file_path));
      if (relevant.length > 0) {
        context += "\n\n--- RELEVANT CODE (from codebase search) ---";
        for (const r of relevant.slice(0, 3)) {
          const truncated = r.content.length > 2000 ? r.content.slice(0, 2000) + "\n// ...truncated" : r.content;
          context += `\n\nFile: ${r.file_path}\n\`\`\`\n${truncated}\n\`\`\``;
        }
        context += "\n\n--- END RELEVANT CODE ---";
      }
    }

    // Memory — recall relevant insights
    const memories = await this.recallRelevant(task.title);
    if (memories.length > 0) {
      context += "\n\n--- AGENT MEMORY (lessons from past tasks) ---";
      for (const m of memories.slice(0, 5)) {
        context += `\n- [${m.type}] ${m.content}`;
      }
      context += "\n\n--- END MEMORY ---";
    }

    return context;
  }

  private async implement(task: Task): Promise<void> {
    const context = await this.buildContext(task);

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
      console.error(`[${this.config.id}] Failed to parse coder response`);
      await this.api("PATCH", `/tasks/${task.id}`, { status: "failed" });
      return;
    }

    // Write files to workspace
    for (const file of result.files) {
      const filePath = join(this.repoPath, file.path);
      const dir = join(filePath, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      await Bun.write(filePath, file.content);
    }

    // Git add + commit
    Bun.spawnSync(["git", "-C", this.repoPath, "add", "-A"]);
    const commitMsg = result.commit_message || `task #${task.id}: ${task.title}`;
    Bun.spawnSync(["git", "-C", this.repoPath, "commit", "-m", commitMsg, "--allow-empty"]);

    // Get commit hash
    const hashProc = Bun.spawnSync(["git", "-C", this.repoPath, "rev-parse", "HEAD"]);
    const hash = hashProc.stdout.toString().trim();
    console.log(`[${this.config.id}] Committed ${hash.slice(0, 8)} for task #${task.id}`);

    // Create bundle and push to server
    const bundlePath = join(this.repoPath, `task-${task.id}.bundle`);
    try {
      const proc = Bun.spawnSync(["git", "-C", this.repoPath, "bundle", "create", bundlePath, "--all"]);
      if (proc.exitCode !== 0) {
        console.error(`[${this.config.id}] Bundle create failed: ${proc.stderr.toString()}`);
      } else {
        const bundleFile = Bun.file(bundlePath);
        console.log(`[${this.config.id}] Bundle created: ${bundleFile.size} bytes`);
        const pushResult = await this.pushBundle(bundlePath);
        console.log(`[${this.config.id}] Pushed ${pushResult.indexed.length} commits to server`);
      }
    } catch (err) {
      console.error(`[${this.config.id}] Push failed:`, err);
    } finally {
      const f = Bun.file(bundlePath);
      if (await f.exists()) { try { await Bun.file(bundlePath).unlink?.(); } catch { /* ignore */ } }
    }

    // Index files for RAG
    for (const file of result.files) {
      await this.indexFile(hash, file.path, file.content);
    }

    // Save output + commit hash to task, mark for review
    const output = JSON.stringify(result, null, 2);
    await this.api("PATCH", `/tasks/${task.id}`, {
      status: "review",
      output,
      commit_hash: hash,
    });

    // Save memory about what was done
    await this.remember(
      `Task "${task.title}": implemented ${result.files.map(f => f.path).join(", ")}. ${result.commit_message}`,
      "task_completed",
      [task.title.split(" ")[0]!.toLowerCase()],
    );

    await this.post(
      "general",
      `Completed task #${task.id}: "${task.title}" → ${result.files.length} files, commit ${hash.slice(0, 8)}. Ready for review.`,
    );
  }
}
