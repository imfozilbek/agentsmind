import type { Database } from "bun:sqlite";

// ─── Types ───

export interface Agent {
  id: string;
  api_key: string;
  role: string;
  status: string;
  created_at: string;
}

export interface Task {
  id: number;
  title: string;
  description: string;
  status: string;
  priority: number;
  parent_id: number | null;
  assigned_to: string | null;
  created_by: string | null;
  commit_hash: string | null;
  output: string;
  created_at: string;
  updated_at: string;
}

export interface Commit {
  hash: string;
  parent_hash: string | null;
  agent_id: string | null;
  task_id: number | null;
  message: string | null;
  created_at: string;
}

export interface Review {
  id: number;
  commit_hash: string;
  reviewer_id: string;
  status: string;
  comment: string;
  created_at: string;
}

export interface Channel {
  id: number;
  name: string;
  description: string;
  created_at: string;
}

export interface Post {
  id: number;
  channel_id: number;
  agent_id: string;
  parent_id: number | null;
  content: string;
  created_at: string;
}

export interface Memory {
  id: number;
  agent_id: string;
  type: string;
  content: string;
  tags: string;
  relevance: number;
  created_at: string;
}

export interface CodeFile {
  id: number;
  commit_hash: string;
  file_path: string;
  content: string;
  language: string;
  created_at: string;
}

export interface CodeSearchResult {
  file_path: string;
  content: string;
  commit_hash: string;
  rank: number;
}

// ─── Constants ───

export const VALID_STATUSES = new Set([
  "todo", "planned", "in_progress", "review",
  "changes_requested", "done", "failed",
]);

const ALLOWED_TASK_FIELDS = new Set([
  "status", "assigned_to", "commit_hash", "output",
  "title", "description", "priority",
]);

// ─── Agents ───

export function createAgent(db: Database, id: string, apiKey: string, role = "coder"): Agent {
  return db.query<Agent, [string, string, string]>(
    "INSERT INTO agents (id, api_key, role) VALUES (?, ?, ?) RETURNING *"
  ).get(id, apiKey, role)!;
}

export function getAgentByKey(db: Database, apiKey: string): Agent | null {
  return db.query<Agent, [string]>(
    "SELECT * FROM agents WHERE api_key = ?"
  ).get(apiKey);
}

export function getAgentById(db: Database, id: string): Agent | null {
  return db.query<Agent, [string]>(
    "SELECT * FROM agents WHERE id = ?"
  ).get(id);
}

export function listAgents(db: Database): Omit<Agent, "api_key">[] {
  return db.query<Omit<Agent, "api_key">, []>(
    "SELECT id, role, status, created_at FROM agents ORDER BY created_at DESC"
  ).all();
}

export function updateAgentStatus(db: Database, id: string, status: string): void {
  db.query("UPDATE agents SET status = ? WHERE id = ?").run(status, id);
}

// ─── Tasks ───

export function createTask(db: Database, title: string, description = "", priority = 0, createdBy: string | null = null, parentId: number | null = null): Task {
  return db.query<Task, [string, string, number, string | null, number | null]>(
    "INSERT INTO tasks (title, description, priority, created_by, parent_id) VALUES (?, ?, ?, ?, ?) RETURNING *"
  ).get(title, description, priority, createdBy, parentId)!;
}

export function getTask(db: Database, id: number): Task | null {
  return db.query<Task, [number]>(
    "SELECT * FROM tasks WHERE id = ?"
  ).get(id);
}

export function listTasks(db: Database, status?: string, agentId?: string, limit = 50, offset = 0): Task[] {
  if (status && agentId) {
    return db.query<Task, [string, string, number, number]>(
      "SELECT * FROM tasks WHERE status = ? AND assigned_to = ? ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?"
    ).all(status, agentId, limit, offset);
  }
  if (status) {
    return db.query<Task, [string, number, number]>(
      "SELECT * FROM tasks WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?"
    ).all(status, limit, offset);
  }
  if (agentId) {
    return db.query<Task, [string, number, number]>(
      "SELECT * FROM tasks WHERE assigned_to = ? ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?"
    ).all(agentId, limit, offset);
  }
  return db.query<Task, [number, number]>(
    "SELECT * FROM tasks ORDER BY priority DESC, created_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset);
}

export function updateTask(db: Database, id: number, fields: Partial<Pick<Task, "status" | "assigned_to" | "commit_hash" | "output" | "title" | "description" | "priority">>): Task | null {
  if (fields.status && !VALID_STATUSES.has(fields.status)) {
    throw new Error(`Invalid status: "${fields.status}"`);
  }

  const sets: string[] = [];
  const values: (string | number | null)[] = [];

  for (const [key, value] of Object.entries(fields)) {
    if (!ALLOWED_TASK_FIELDS.has(key)) continue;
    sets.push(`${key} = ?`);
    values.push(value as string | number | null);
  }

  if (sets.length === 0) return getTask(db, id);

  sets.push("updated_at = datetime('now')");
  values.push(id);

  return db.transaction(() => {
    const result = db.prepare<Task, (string | number | null)[]>(
      `UPDATE tasks SET ${sets.join(", ")} WHERE id = ? RETURNING *`
    ).get(...values);

    if (result && fields.status) {
      logStatusChange(db, id, fields.status);
    }

    return result;
  })();
}

export function getSubtasks(db: Database, parentId: number): Task[] {
  return db.query<Task, [number]>(
    "SELECT * FROM tasks WHERE parent_id = ? ORDER BY priority DESC, created_at ASC"
  ).all(parentId);
}

// ─── Task Dependencies ───

export interface TaskDependency {
  task_id: number;
  depends_on_id: number;
  created_at: string;
}

export function wouldCreateCycle(db: Database, taskId: number, dependsOnId: number): boolean {
  if (taskId === dependsOnId) return true;
  const row = db.query<{ found: number }, [number, number]>(
    `WITH RECURSIVE dep_chain(id) AS (
      SELECT depends_on_id FROM task_dependencies WHERE task_id = ?
      UNION
      SELECT td.depends_on_id FROM task_dependencies td
      JOIN dep_chain dc ON dc.id = td.task_id
    )
    SELECT 1 as found FROM dep_chain WHERE id = ? LIMIT 1`
  ).get(dependsOnId, taskId);
  return !!row;
}

export function addDependency(db: Database, taskId: number, dependsOnId: number): void {
  if (wouldCreateCycle(db, taskId, dependsOnId)) {
    throw new Error("Adding this dependency would create a cycle");
  }
  db.query("INSERT OR IGNORE INTO task_dependencies (task_id, depends_on_id) VALUES (?, ?)").run(taskId, dependsOnId);
}

export function removeDependency(db: Database, taskId: number, dependsOnId: number): void {
  db.query("DELETE FROM task_dependencies WHERE task_id = ? AND depends_on_id = ?").run(taskId, dependsOnId);
}

export function getDependencies(db: Database, taskId: number): Task[] {
  return db.query<Task, [number]>(
    `SELECT t.* FROM tasks t
     JOIN task_dependencies td ON td.depends_on_id = t.id
     WHERE td.task_id = ?
     ORDER BY t.id`
  ).all(taskId);
}

export function getDependents(db: Database, taskId: number): Task[] {
  return db.query<Task, [number]>(
    `SELECT t.* FROM tasks t
     JOIN task_dependencies td ON td.task_id = t.id
     WHERE td.depends_on_id = ?
     ORDER BY t.id`
  ).all(taskId);
}

export function getReadyTasks(db: Database): Task[] {
  return db.query<Task, []>(
    `SELECT t.* FROM tasks t
     WHERE t.status = 'todo'
     AND NOT EXISTS (
       SELECT 1 FROM task_dependencies td
       JOIN tasks dep ON dep.id = td.depends_on_id
       WHERE td.task_id = t.id AND dep.status != 'done'
     )
     ORDER BY t.priority DESC, t.created_at ASC`
  ).all();
}

export function claimTask(db: Database, taskId: number, agentId: string): Task | null {
  const result = db.query<Task, [string, number]>(
    `UPDATE tasks SET assigned_to = ?, status = 'in_progress', updated_at = datetime('now')
     WHERE id = ? AND assigned_to IS NULL AND status = 'todo'
     RETURNING *`
  ).get(agentId, taskId) ?? null;
  if (result) logStatusChange(db, taskId, "in_progress");
  return result;
}

export function claimRework(db: Database, taskId: number, agentId: string): Task | null {
  const result = db.query<Task, [number, string]>(
    `UPDATE tasks SET status = 'in_progress', updated_at = datetime('now')
     WHERE id = ? AND status = 'changes_requested' AND assigned_to = ?
     RETURNING *`
  ).get(taskId, agentId) ?? null;
  if (result) logStatusChange(db, taskId, "in_progress");
  return result;
}

export interface DepMapEntry {
  task_id: number;
  depends_on_id: number;
  dep_status: string;
}

export function getDependencyMap(db: Database): DepMapEntry[] {
  return db.query<DepMapEntry, []>(
    `SELECT td.task_id, td.depends_on_id, t.status as dep_status
     FROM task_dependencies td JOIN tasks t ON t.id = td.depends_on_id`
  ).all();
}

// ─── Task Status Log ───

export interface StatusLogEntry {
  id: number;
  task_id: number;
  status: string;
  changed_at: string;
}

export function logStatusChange(db: Database, taskId: number, status: string): void {
  db.query("INSERT INTO task_status_log (task_id, status) VALUES (?, ?)").run(taskId, status);
}

export function getStatusLog(db: Database, taskId: number): StatusLogEntry[] {
  return db.query<StatusLogEntry, [number]>(
    "SELECT * FROM task_status_log WHERE task_id = ? ORDER BY changed_at ASC"
  ).all(taskId);
}

// ─── Commits ───

export function insertCommit(db: Database, hash: string, parentHash: string | null, agentId: string | null, taskId: number | null, message: string | null): Commit {
  return db.query<Commit, [string, string | null, string | null, number | null, string | null]>(
    "INSERT INTO commits (hash, parent_hash, agent_id, task_id, message) VALUES (?, ?, ?, ?, ?) RETURNING *"
  ).get(hash, parentHash, agentId, taskId, message)!;
}

export function getCommit(db: Database, hash: string): Commit | null {
  return db.query<Commit, [string]>(
    "SELECT * FROM commits WHERE hash = ?"
  ).get(hash);
}

export function listCommits(db: Database, agentId?: string, limit = 50, offset = 0): Commit[] {
  if (agentId) {
    return db.query<Commit, [string, number, number]>(
      "SELECT * FROM commits WHERE agent_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
    ).all(agentId, limit, offset);
  }
  return db.query<Commit, [number, number]>(
    "SELECT * FROM commits ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).all(limit, offset);
}

export function getChildren(db: Database, hash: string): Commit[] {
  return db.query<Commit, [string]>(
    "SELECT * FROM commits WHERE parent_hash = ? ORDER BY created_at ASC"
  ).all(hash);
}

export function getLeaves(db: Database): Commit[] {
  return db.query<Commit, []>(
    `SELECT c.* FROM commits c
     LEFT JOIN commits child ON child.parent_hash = c.hash
     WHERE child.hash IS NULL
     ORDER BY c.created_at DESC`
  ).all();
}

export function getLineage(db: Database, hash: string, maxDepth = 1000): Commit[] {
  const lineage: Commit[] = [];
  const visited = new Set<string>();
  let current = getCommit(db, hash);

  while (current && lineage.length < maxDepth) {
    if (visited.has(current.hash)) break; // cycle guard
    visited.add(current.hash);
    lineage.push(current);
    if (!current.parent_hash) break;
    current = getCommit(db, current.parent_hash);
  }

  return lineage;
}

// ─── Reviews ───

export function createReview(db: Database, commitHash: string, reviewerId: string, status: string, comment: string): Review {
  return db.query<Review, [string, string, string, string]>(
    "INSERT INTO reviews (commit_hash, reviewer_id, status, comment) VALUES (?, ?, ?, ?) RETURNING *"
  ).get(commitHash, reviewerId, status, comment)!;
}

export function getReviewsForCommit(db: Database, commitHash: string): Review[] {
  return db.query<Review, [string]>(
    "SELECT * FROM reviews WHERE commit_hash = ? ORDER BY created_at DESC"
  ).all(commitHash);
}

export interface ReviewWithContext extends Review {
  task_id: number | null;
  task_title: string | null;
  agent_id: string | null;
}

export function listReviews(db: Database, limit = 50, offset = 0): ReviewWithContext[] {
  return db.query<ReviewWithContext, [number, number]>(
    `SELECT r.*, c.task_id, t.title as task_title, c.agent_id
     FROM reviews r
     LEFT JOIN commits c ON c.hash = r.commit_hash
     LEFT JOIN tasks t ON t.id = c.task_id
     ORDER BY r.created_at DESC LIMIT ? OFFSET ?`
  ).all(limit, offset);
}

export function getReviewCountForTask(db: Database, taskId: number): number {
  const row = db.query<{ count: number }, [number]>(
    `SELECT COUNT(*) as count FROM task_status_log WHERE task_id = ? AND status = 'review'`
  ).get(taskId);
  return row?.count ?? 0;
}

// ─── Channels ───

export function createChannel(db: Database, name: string, description = ""): Channel {
  return db.query<Channel, [string, string]>(
    "INSERT INTO channels (name, description) VALUES (?, ?) RETURNING *"
  ).get(name, description)!;
}

export function listChannels(db: Database): Channel[] {
  return db.query<Channel, []>(
    "SELECT * FROM channels ORDER BY name ASC"
  ).all();
}

export function getChannelByName(db: Database, name: string): Channel | null {
  return db.query<Channel, [string]>(
    "SELECT * FROM channels WHERE name = ?"
  ).get(name);
}

// ─── Posts ───

export function createPost(db: Database, channelId: number, agentId: string, content: string, parentId: number | null = null): Post {
  return db.query<Post, [number, string, string, number | null]>(
    "INSERT INTO posts (channel_id, agent_id, content, parent_id) VALUES (?, ?, ?, ?) RETURNING *"
  ).get(channelId, agentId, content, parentId)!;
}

export function listPosts(db: Database, channelId: number, limit = 50, offset = 0): Post[] {
  return db.query<Post, [number, number, number]>(
    "SELECT * FROM posts WHERE channel_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?"
  ).all(channelId, limit, offset);
}

export function getPost(db: Database, id: number): Post | null {
  return db.query<Post, [number]>(
    "SELECT * FROM posts WHERE id = ?"
  ).get(id);
}

export function getReplies(db: Database, postId: number): Post[] {
  return db.query<Post, [number]>(
    "SELECT * FROM posts WHERE parent_id = ? ORDER BY created_at ASC"
  ).all(postId);
}

// ─── Rate Limits ───

export function checkRateLimit(db: Database, agentId: string, action: string, maxCount: number): boolean {
  const windowStart = new Date(Date.now() - 3600_000).toISOString();
  const result = db.query<{ total: number }, [string, string, string]>(
    "SELECT COALESCE(SUM(count), 0) as total FROM rate_limits WHERE agent_id = ? AND action = ? AND window_start > ?"
  ).get(agentId, action, windowStart);
  return (result?.total ?? 0) < maxCount;
}

export function incrementRateLimit(db: Database, agentId: string, action: string): void {
  const windowStart = new Date().toISOString().slice(0, 13) + ":00:00";
  db.query(
    `INSERT INTO rate_limits (agent_id, action, window_start, count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(agent_id, action, window_start) DO UPDATE SET count = count + 1`
  ).run(agentId, action, windowStart);
}

export function cleanupRateLimits(db: Database): void {
  const cutoff = new Date(Date.now() - 7200_000).toISOString();
  db.query("DELETE FROM rate_limits WHERE window_start < ?").run(cutoff);
}

// ─── Memories ───

export function saveMemory(db: Database, agentId: string, type: string, content: string, tags: string[] = []): Memory {
  return db.query<Memory, [string, string, string, string]>(
    "INSERT INTO memories (agent_id, type, content, tags) VALUES (?, ?, ?, ?) RETURNING *"
  ).get(agentId, type, content, tags.join(","))!;
}

export function getMemories(db: Database, agentId: string, type?: string, limit = 20): Memory[] {
  if (type) {
    return db.query<Memory, [string, string, number]>(
      "SELECT * FROM memories WHERE agent_id = ? AND type = ? ORDER BY relevance DESC, created_at DESC LIMIT ?"
    ).all(agentId, type, limit);
  }
  return db.query<Memory, [string, number]>(
    "SELECT * FROM memories WHERE agent_id = ? ORDER BY relevance DESC, created_at DESC LIMIT ?"
  ).all(agentId, limit);
}

export function searchMemories(db: Database, query: string, agentId?: string, limit = 10): Memory[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  const conditions = words.map(() => "LOWER(content) LIKE ? ESCAPE '\\'").join(" AND ");
  const params = words.map(w => `%${w.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);

  if (agentId) {
    return db.query<Memory, (string | number)[]>(
      `SELECT * FROM memories WHERE agent_id = ? AND ${conditions} ORDER BY relevance DESC LIMIT ?`
    ).all(agentId, ...params, limit);
  }
  return db.query<Memory, (string | number)[]>(
    `SELECT * FROM memories WHERE ${conditions} ORDER BY relevance DESC LIMIT ?`
  ).all(...params, limit);
}

export function deleteMemory(db: Database, id: number, agentId: string): boolean {
  const result = db.query<{ id: number }, [number, string]>(
    "DELETE FROM memories WHERE id = ? AND agent_id = ? RETURNING id"
  ).get(id, agentId);
  return !!result;
}

// ─── Code Index ───

export function indexCode(db: Database, commitHash: string, filePath: string, content: string): void {
  const ext = filePath.split(".").pop() ?? "";
  const langMap: Record<string, string> = { ts: "typescript", js: "javascript", py: "python", rs: "rust", go: "go" };
  const language = langMap[ext] ?? ext;

  db.query(
    "INSERT OR REPLACE INTO code_index (commit_hash, file_path, content, language) VALUES (?, ?, ?, ?)"
  ).run(commitHash, filePath, content, language);
}

export function searchCode(db: Database, query: string, limit = 10): CodeSearchResult[] {
  const words = query.split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];

  // Use FTS5 for fast search
  const ftsQuery = words.map(w => `"${w.replace(/"/g, '""')}"`).join(" AND ");

  try {
    return db.query<CodeSearchResult, [string, number]>(
      `SELECT file_path, content, commit_hash, rank
       FROM code_fts WHERE code_fts MATCH ?
       ORDER BY rank LIMIT ?`
    ).all(ftsQuery, limit);
  } catch {
    // Fallback to LIKE search if FTS fails
    const conditions = words.map(() => "LOWER(content) LIKE ? ESCAPE '\\'").join(" AND ");
    const params = words.map(w => `%${w.toLowerCase().replace(/%/g, "\\%").replace(/_/g, "\\_")}%`);

    return db.query<CodeSearchResult, (string | number)[]>(
      `SELECT file_path, content, commit_hash, 0 as rank
       FROM code_index WHERE ${conditions}
       ORDER BY created_at DESC LIMIT ?`
    ).all(...params, limit);
  }
}

export function getLatestFiles(db: Database, limit = 50): CodeFile[] {
  return db.query<CodeFile, [number]>(
    `SELECT ci.* FROM code_index ci
     INNER JOIN (
       SELECT file_path, MAX(created_at) as max_time FROM code_index GROUP BY file_path
     ) latest ON ci.file_path = latest.file_path AND ci.created_at = latest.max_time
     ORDER BY ci.created_at DESC LIMIT ?`
  ).all(limit);
}

// ─── Metrics ───

export interface Metric {
  id: number;
  agent_id: string;
  event: string;
  value: number;
  meta: string;
  created_at: string;
}

export function recordMetric(db: Database, agentId: string, event: string, value: number, meta: Record<string, unknown> = {}): void {
  db.query(
    "INSERT INTO metrics (agent_id, event, value, meta) VALUES (?, ?, ?, ?)"
  ).run(agentId, event, value, JSON.stringify(meta));
}

export function getAgentMetrics(db: Database, agentId: string, event?: string, limit = 100): Metric[] {
  if (event) {
    return db.query<Metric, [string, string, number]>(
      "SELECT * FROM metrics WHERE agent_id = ? AND event = ? ORDER BY created_at DESC LIMIT ?"
    ).all(agentId, event, limit);
  }
  return db.query<Metric, [string, number]>(
    "SELECT * FROM metrics WHERE agent_id = ? ORDER BY created_at DESC LIMIT ?"
  ).all(agentId, limit);
}

export function getMetricsSummary(db: Database) {
  // AI call stats
  const aiCalls = db.query<{ count: number; total_tokens: number; total_latency: number; total_prompt: number; total_completion: number }, []>(`
    SELECT
      COUNT(*) as count,
      COALESCE(SUM(value), 0) as total_tokens,
      COALESCE(SUM(json_extract(meta, '$.latency_ms')), 0) as total_latency,
      COALESCE(SUM(json_extract(meta, '$.prompt_tokens')), 0) as total_prompt,
      COALESCE(SUM(json_extract(meta, '$.completion_tokens')), 0) as total_completion
    FROM metrics WHERE event = 'ai_chat'
  `).get()!;

  // Task completion stats
  const taskStats = db.query<{ completed: number; failed: number; avg_duration: number }, []>(`
    SELECT
      COUNT(CASE WHEN event = 'task_done' THEN 1 END) as completed,
      COUNT(CASE WHEN event = 'task_failed' THEN 1 END) as failed,
      COALESCE(AVG(CASE WHEN event = 'task_done' THEN value END), 0) as avg_duration
    FROM metrics WHERE event IN ('task_done', 'task_failed')
  `).get()!;

  // Per-agent stats
  const agentStats = db.query<{ agent_id: string; ai_calls: number; tokens: number; tasks_done: number; tasks_failed: number; avg_task_ms: number }, []>(`
    SELECT
      agent_id,
      COUNT(CASE WHEN event = 'ai_chat' THEN 1 END) as ai_calls,
      COALESCE(SUM(CASE WHEN event = 'ai_chat' THEN value ELSE 0 END), 0) as tokens,
      COUNT(CASE WHEN event = 'task_done' THEN 1 END) as tasks_done,
      COUNT(CASE WHEN event = 'task_failed' THEN 1 END) as tasks_failed,
      COALESCE(AVG(CASE WHEN event = 'task_done' THEN value END), 0) as avg_task_ms
    FROM metrics
    GROUP BY agent_id
    ORDER BY tokens DESC
  `).all();

  // Recent AI latency (last 50 calls)
  const recentLatency = db.query<{ latency: number; created_at: string; agent_id: string }, []>(`
    SELECT json_extract(meta, '$.latency_ms') as latency, created_at, agent_id
    FROM metrics WHERE event = 'ai_chat'
    ORDER BY created_at DESC LIMIT 50
  `).all();

  return { aiCalls, taskStats, agentStats, recentLatency };
}

// ─── Stats ───

export function getStats(db: Database) {
  const agents = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM agents").get()!.count;
  const tasks = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM tasks").get()!.count;
  const commits = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM commits").get()!.count;
  const reviews = db.query<{ count: number }, []>("SELECT COUNT(*) as count FROM reviews").get()!.count;
  return { agents, tasks, commits, reviews };
}
