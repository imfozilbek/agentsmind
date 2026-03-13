import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { Database } from "bun:sqlite";
import { GitRepo, isValidHash } from "../git/repo.ts";
import * as q from "../db/queries.ts";

export function dashboardRoutes(db: Database, git: GitRepo) {
  const app = new Hono();

  // Dashboard data API (public, no auth)
  app.get("/api/dashboard", (c) => {
    const stats = q.getStats(db);
    const agents = q.listAgents(db);
    const tasks = db.query<q.Task, [number]>(
      "SELECT * FROM tasks ORDER BY priority DESC, created_at DESC LIMIT ?"
    ).all(100);
    const commits = q.listCommits(db, undefined, 50, 0);
    const channels = q.listChannels(db);

    // Recent posts across all channels
    const posts = db.query<q.Post & { channel_name: string; agent_role: string }, [number]>(
      `SELECT p.*, c.name as channel_name, COALESCE(a.role, 'unknown') as agent_role
       FROM posts p
       JOIN channels c ON c.id = p.channel_id
       LEFT JOIN agents a ON a.id = p.agent_id
       ORDER BY p.created_at DESC LIMIT ?`
    ).all(100);

    return c.json({ stats, agents, tasks, commits, channels, posts });
  });

  // Commit detail: info + file list
  app.get("/api/dashboard/commits/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!isValidHash(hash)) return c.json({ error: "Invalid hash" }, 400);

    const commit = q.getCommit(db, hash);
    if (!commit) return c.json({ error: "Commit not found" }, 404);

    const exists = await git.commitExists(hash);
    if (!exists) return c.json({ ...commit, files: [] });

    try {
      const files = await git.listFiles(hash);
      return c.json({ ...commit, files });
    } catch {
      return c.json({ ...commit, files: [] });
    }
  });

  // Commit diff (against parent or show full first commit)
  app.get("/api/dashboard/commits/:hash/diff", async (c) => {
    const hash = c.req.param("hash");
    if (!isValidHash(hash)) return c.json({ error: "Invalid hash" }, 400);

    const commit = q.getCommit(db, hash);
    if (!commit) return c.json({ error: "Commit not found" }, 404);

    const exists = await git.commitExists(hash);
    if (!exists) return c.text("Commit not in git repo");

    try {
      let diff: string;
      if (commit.parent_hash) {
        diff = await git.diff(commit.parent_hash, hash);
      } else {
        diff = await git.diffShow(hash);
      }
      return c.text(diff);
    } catch {
      return c.text("Unable to generate diff");
    }
  });

  // File content at commit
  app.get("/api/dashboard/commits/:hash/files/*", async (c) => {
    const hash = c.req.param("hash");
    if (!isValidHash(hash)) return c.json({ error: "Invalid hash" }, 400);

    const filePath = c.req.path.split("/files/")[1];
    if (!filePath) return c.json({ error: "File path required" }, 400);

    try {
      const content = await git.showFile(hash, filePath);
      return c.text(content);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  });

  // ─── Task Management API (public) ───

  app.post("/api/dashboard/tasks", async (c) => {
    const { title, description, priority, parent_id } = await c.req.json<{
      title: string; description?: string; priority?: number; parent_id?: number;
    }>();
    if (!title?.trim()) return c.json({ error: "Title required" }, 400);
    const task = q.createTask(db, title.trim(), description ?? "", priority ?? 0, null, parent_id ?? null);
    return c.json(task, 201);
  });

  app.get("/api/dashboard/tasks/:id", (c) => {
    const id = Number(c.req.param("id"));
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Not found" }, 404);
    const subtasks = q.getSubtasks(db, id);
    return c.json({ ...task, subtasks });
  });

  app.patch("/api/dashboard/tasks/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const fields = await c.req.json<Partial<Pick<q.Task, "status" | "title" | "description" | "priority">>>();
    const task = q.updateTask(db, id, fields);
    if (!task) return c.json({ error: "Not found" }, 404);
    return c.json(task);
  });

  app.delete("/api/dashboard/tasks/:id", (c) => {
    const id = Number(c.req.param("id"));
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Not found" }, 404);
    db.query("DELETE FROM tasks WHERE id = ?").run(id);
    return c.json({ ok: true });
  });

  // Metrics API (public)
  app.get("/api/dashboard/metrics", (c) => {
    return c.json(q.getMetricsSummary(db));
  });

  // Dashboard HTML
  app.get("/", (c) => {
    return c.html(dashboardHTML());
  });

  return app;
}

function dashboardHTML() {
  return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentsMind — Dashboard</title>
  <style>
    ${raw(CSS)}
  </style>
</head>
<body>
  <header>
    <div class="logo">
      <span class="logo-icon">◈</span> AgentsMind
    </div>
    <div class="header-meta">
      <span id="status-dot" class="dot"></span>
      <span id="last-update">connecting...</span>
    </div>
  </header>

  <section class="stats" id="stats"></section>

  <div class="grid">
    <section class="panel">
      <h2>Agents</h2>
      <div id="agents" class="card-list"></div>
    </section>

    <section class="panel wide">
      <div class="panel-header">
        <h2>Tasks</h2>
        <button class="btn-new" onclick="openNewTaskForm()">+ New Task</button>
      </div>
      <div class="task-board" id="tasks"></div>
    </section>
  </div>

  <div class="grid">
    <section class="panel">
      <h2>Activity</h2>
      <div id="posts" class="feed"></div>
    </section>

    <section class="panel">
      <h2>Commits</h2>
      <div id="commits" class="feed"></div>
    </section>
  </div>

  <section class="panel metrics-panel">
    <h2>Metrics</h2>
    <div id="metrics"></div>
  </section>

  <script>
    ${raw(JS)}
  </script>
</body>
</html>`;
}

const CSS = `
  :root {
    --bg: #0a0a0f;
    --surface: #12121a;
    --border: #1e1e2e;
    --text: #e0e0e8;
    --text-dim: #6b6b80;
    --accent: #7c6df0;
    --accent-dim: #7c6df020;
    --green: #4ade80;
    --yellow: #fbbf24;
    --red: #f87171;
    --blue: #60a5fa;
    --orange: #fb923c;
    --radius: 8px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    background: var(--bg);
    color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
    font-size: 14px;
    line-height: 1.5;
    padding: 24px;
    max-width: 1400px;
    margin: 0 auto;
  }

  header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 32px;
    padding-bottom: 16px;
    border-bottom: 1px solid var(--border);
  }

  .logo {
    font-size: 20px;
    font-weight: 700;
    letter-spacing: -0.5px;
  }

  .logo-icon {
    color: var(--accent);
    font-size: 24px;
  }

  .header-meta {
    display: flex;
    align-items: center;
    gap: 8px;
    color: var(--text-dim);
    font-size: 13px;
  }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--green);
    display: inline-block;
    animation: pulse 2s ease-in-out infinite;
  }

  .dot.error { background: var(--red); animation: none; }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.4; }
  }

  /* Stats */
  .stats {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 16px;
    margin-bottom: 32px;
  }

  .stat-card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
  }

  .stat-card .label {
    color: var(--text-dim);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }

  .stat-card .value {
    font-size: 32px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  /* Grid */
  .grid {
    display: grid;
    grid-template-columns: 300px 1fr;
    gap: 24px;
    margin-bottom: 24px;
  }

  .grid:last-child {
    grid-template-columns: 1fr 1fr;
  }

  .panel {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 20px;
    min-height: 200px;
    max-height: 500px;
    overflow-y: auto;
  }

  .panel.wide { grid-column: span 1; }

  .panel h2 {
    font-size: 13px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    margin-bottom: 16px;
  }

  /* Agents */
  .card-list { display: flex; flex-direction: column; gap: 8px; }

  .agent-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: var(--bg);
    border-radius: 6px;
  }

  .agent-avatar {
    width: 36px;
    height: 36px;
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 16px;
    font-weight: 700;
    color: white;
  }

  .agent-avatar.coder { background: var(--accent); }
  .agent-avatar.reviewer { background: var(--blue); }
  .agent-avatar.tester { background: var(--green); color: #000; }
  .agent-avatar.planner { background: var(--orange); color: #000; }

  .agent-info { flex: 1; }
  .agent-name { font-weight: 600; font-size: 13px; }
  .agent-role { color: var(--text-dim); font-size: 12px; }

  .agent-status {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    font-weight: 500;
  }

  .agent-status.idle { background: var(--border); color: var(--text-dim); }
  .agent-status.working { background: var(--accent-dim); color: var(--accent); }

  /* Task Board */
  .task-board {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 12px;
  }

  .task-column h3 {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    margin-bottom: 8px;
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .task-column h3 .count {
    background: var(--border);
    padding: 1px 6px;
    border-radius: 8px;
    font-size: 10px;
  }

  .task-card {
    background: var(--bg);
    border-radius: 6px;
    padding: 10px;
    margin-bottom: 6px;
    border-left: 3px solid transparent;
    font-size: 12px;
  }

  .task-card.todo { border-left-color: var(--text-dim); }
  .task-card.planned { border-left-color: var(--blue); }
  .task-card.in_progress { border-left-color: var(--accent); }
  .task-card.review { border-left-color: var(--yellow); }
  .task-card.done { border-left-color: var(--green); }
  .task-card.failed { border-left-color: var(--red); }

  .task-title { font-weight: 500; margin-bottom: 4px; }
  .task-meta { color: var(--text-dim); font-size: 11px; }

  /* Feed */
  .feed { display: flex; flex-direction: column; gap: 2px; }

  .feed-item {
    padding: 10px;
    border-radius: 6px;
    font-size: 13px;
  }

  .feed-item:hover { background: var(--bg); }

  .feed-header {
    display: flex;
    justify-content: space-between;
    margin-bottom: 4px;
  }

  .feed-agent {
    font-weight: 600;
    font-size: 12px;
  }

  .feed-time {
    color: var(--text-dim);
    font-size: 11px;
  }

  .feed-content {
    color: var(--text);
    font-size: 12px;
    word-break: break-word;
  }

  .feed-channel {
    color: var(--accent);
    font-size: 11px;
  }

  .commit-hash {
    font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--accent);
    font-size: 12px;
  }

  .commit-msg {
    font-size: 12px;
    margin-left: 8px;
  }

  .empty {
    color: var(--text-dim);
    text-align: center;
    padding: 40px;
    font-size: 13px;
  }

  /* Panel header with button */
  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 16px;
  }

  .panel-header h2 { margin-bottom: 0; }

  .btn-new {
    background: var(--accent);
    color: white;
    border: none;
    padding: 6px 14px;
    border-radius: 6px;
    font-size: 12px;
    font-weight: 600;
    cursor: pointer;
    font-family: inherit;
  }

  .btn-new:hover { opacity: 0.85; }

  /* Form styles */
  .form-group {
    margin-bottom: 14px;
  }

  .form-group label {
    display: block;
    font-size: 12px;
    color: var(--text-dim);
    margin-bottom: 4px;
    font-weight: 500;
  }

  .form-input {
    width: 100%;
    background: var(--bg);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px 12px;
    color: var(--text);
    font-size: 13px;
    font-family: inherit;
    outline: none;
  }

  .form-input:focus { border-color: var(--accent); }

  textarea.form-input {
    min-height: 80px;
    resize: vertical;
  }

  .form-row {
    display: flex;
    gap: 12px;
  }

  .form-row .form-group { flex: 1; }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  .btn {
    padding: 8px 16px;
    border-radius: 6px;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
    border: none;
    font-family: inherit;
  }

  .btn-primary { background: var(--accent); color: white; }
  .btn-primary:hover { opacity: 0.85; }
  .btn-secondary { background: var(--border); color: var(--text); }
  .btn-secondary:hover { background: var(--text-dim); }
  .btn-danger { background: var(--red); color: white; }
  .btn-danger:hover { opacity: 0.85; }

  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* Task detail */
  .task-detail-grid {
    display: grid;
    grid-template-columns: 1fr 180px;
    gap: 16px;
    padding: 16px 20px;
  }

  .task-detail-main { overflow: auto; }

  .task-detail-sidebar {
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .detail-field {
    margin-bottom: 12px;
  }

  .detail-field .label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
    margin-bottom: 4px;
  }

  .detail-field .value {
    font-size: 13px;
  }

  .status-badge {
    display: inline-block;
    padding: 3px 10px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 600;
  }

  .status-badge.todo { background: var(--border); color: var(--text-dim); }
  .status-badge.planned { background: rgba(96,165,250,0.15); color: var(--blue); }
  .status-badge.in_progress { background: var(--accent-dim); color: var(--accent); }
  .status-badge.review { background: rgba(251,191,36,0.15); color: var(--yellow); }
  .status-badge.done { background: rgba(74,222,128,0.15); color: var(--green); }
  .status-badge.failed { background: rgba(248,113,113,0.15); color: var(--red); }

  .subtask-list {
    margin-top: 8px;
  }

  .subtask-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 0;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
  }

  .subtask-item:last-child { border-bottom: none; }

  .task-card.clickable { cursor: pointer; }
  .task-card.clickable:hover { background: var(--accent-dim); }

  select.form-input {
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%236b6b80' d='M3 5l3 3 3-3'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 10px center;
    padding-right: 30px;
  }

  /* Metrics */
  .metrics-panel {
    margin-bottom: 24px;
    max-height: none;
  }

  .metrics-grid {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 12px;
    margin-bottom: 20px;
  }

  .metric-card {
    background: var(--bg);
    border-radius: 6px;
    padding: 14px;
  }

  .metric-card .label {
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    margin-bottom: 4px;
  }

  .metric-card .value {
    font-size: 24px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .metric-card .sub {
    font-size: 11px;
    color: var(--text-dim);
    margin-top: 2px;
  }

  .agent-metrics-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 12px;
  }

  .agent-metrics-table th {
    text-align: left;
    padding: 8px 12px;
    color: var(--text-dim);
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    border-bottom: 1px solid var(--border);
    font-weight: 500;
  }

  .agent-metrics-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--border);
    font-variant-numeric: tabular-nums;
  }

  .agent-metrics-table tr:last-child td { border-bottom: none; }

  .latency-bar {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 40px;
    margin-top: 12px;
  }

  .latency-bar .bar {
    flex: 1;
    background: var(--accent);
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    opacity: 0.7;
  }

  .latency-bar .bar:hover { opacity: 1; }

  .metrics-section-title {
    font-size: 12px;
    color: var(--text-dim);
    margin: 16px 0 8px;
    font-weight: 600;
  }

  .latency-labels {
    display: flex;
    justify-content: space-between;
    font-size: 10px;
    color: var(--text-dim);
    margin-top: 4px;
  }

  @media (max-width: 900px) {
    .metrics-grid { grid-template-columns: repeat(2, 1fr); }
  }

  /* Commit detail modal */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    z-index: 100;
    display: flex;
    align-items: center;
    justify-content: center;
    backdrop-filter: blur(4px);
  }

  .modal {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 12px;
    width: 90vw;
    max-width: 1000px;
    max-height: 85vh;
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .modal-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 16px 20px;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .modal-header h3 {
    font-size: 14px;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .modal-close {
    background: none;
    border: none;
    color: var(--text-dim);
    font-size: 20px;
    cursor: pointer;
    padding: 4px 8px;
    border-radius: 4px;
  }

  .modal-close:hover { background: var(--border); color: var(--text); }

  .modal-body {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  .modal-sidebar {
    width: 220px;
    border-right: 1px solid var(--border);
    overflow-y: auto;
    flex-shrink: 0;
    padding: 12px 0;
  }

  .modal-sidebar .sidebar-item {
    padding: 6px 16px;
    font-size: 12px;
    font-family: 'SF Mono', 'Fira Code', monospace;
    color: var(--text-dim);
    cursor: pointer;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .modal-sidebar .sidebar-item:hover { background: var(--bg); color: var(--text); }
  .modal-sidebar .sidebar-item.active { background: var(--accent-dim); color: var(--accent); }

  .sidebar-label {
    padding: 8px 16px 4px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    color: var(--text-dim);
  }

  .modal-content {
    flex: 1;
    overflow: auto;
    padding: 0;
  }

  /* Diff view */
  .diff-view {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre;
    padding: 12px 0;
  }

  .diff-line {
    padding: 0 16px;
    min-height: 1.6em;
  }

  .diff-line.add { background: rgba(74, 222, 128, 0.1); color: var(--green); }
  .diff-line.del { background: rgba(248, 113, 113, 0.1); color: var(--red); }
  .diff-line.hunk { color: var(--blue); background: rgba(96, 165, 250, 0.06); }
  .diff-line.file-header { color: var(--yellow); font-weight: 600; padding-top: 12px; }

  /* File view */
  .file-view {
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 12px;
    line-height: 1.6;
    white-space: pre;
    padding: 12px 16px;
    color: var(--text);
  }

  .commit-detail-meta {
    padding: 12px 16px;
    border-bottom: 1px solid var(--border);
    font-size: 12px;
    color: var(--text-dim);
    display: flex;
    gap: 16px;
    flex-shrink: 0;
  }

  .commit-detail-meta span { display: flex; align-items: center; gap: 4px; }

  /* Clickable commit items */
  .feed-item.clickable { cursor: pointer; }
  .feed-item.clickable:hover { background: var(--accent-dim); }

  .tab-bar {
    display: flex;
    gap: 0;
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
  }

  .tab-bar button {
    background: none;
    border: none;
    padding: 8px 16px;
    font-size: 12px;
    color: var(--text-dim);
    cursor: pointer;
    border-bottom: 2px solid transparent;
    font-family: inherit;
  }

  .tab-bar button:hover { color: var(--text); }
  .tab-bar button.active { color: var(--accent); border-bottom-color: var(--accent); }

  .modal-loading {
    display: flex;
    align-items: center;
    justify-content: center;
    height: 200px;
    color: var(--text-dim);
    font-size: 13px;
  }

  @media (max-width: 900px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .grid { grid-template-columns: 1fr; }
    .grid:last-child { grid-template-columns: 1fr; }
    .task-board { grid-template-columns: 1fr; }
    .modal-sidebar { display: none; }
    .modal { width: 95vw; }
  }
`;

const JS = `
  const REFRESH_MS = 3000;
  let lastData = null;

  async function fetchData() {
    try {
      const [dashRes, metricsRes] = await Promise.all([
        fetch('/api/dashboard'),
        fetch('/api/dashboard/metrics'),
      ]);
      const data = await dashRes.json();
      const metrics = await metricsRes.json();
      lastData = data;
      render(data, metrics);
      document.getElementById('status-dot').classList.remove('error');
      document.getElementById('last-update').textContent = 'live — ' + new Date().toLocaleTimeString();
    } catch (e) {
      document.getElementById('status-dot').classList.add('error');
      document.getElementById('last-update').textContent = 'disconnected';
    }
  }

  function render(data, metrics) {
    renderStats(data.stats);
    renderAgents(data.agents);
    renderTasks(data.tasks);
    renderPosts(data.posts);
    renderCommits(data.commits);
    renderMetrics(metrics);
  }

  function renderStats(s) {
    document.getElementById('stats').innerHTML =
      statCard('Agents', s.agents, '◈') +
      statCard('Tasks', s.tasks, '▦') +
      statCard('Commits', s.commits, '⬡') +
      statCard('Reviews', s.reviews, '◉');
  }

  function statCard(label, value, icon) {
    return '<div class="stat-card"><div class="label">' + icon + ' ' + label + '</div><div class="value">' + value + '</div></div>';
  }

  function renderAgents(agents) {
    const el = document.getElementById('agents');
    if (!agents.length) { el.innerHTML = '<div class="empty">No agents registered</div>'; return; }
    el.innerHTML = agents.map(a =>
      '<div class="agent-card">' +
        '<div class="agent-avatar ' + esc(a.role) + '">' + esc(a.role[0].toUpperCase()) + '</div>' +
        '<div class="agent-info">' +
          '<div class="agent-name">' + esc(a.id) + '</div>' +
          '<div class="agent-role">' + esc(a.role) + '</div>' +
        '</div>' +
        '<span class="agent-status ' + esc(a.status) + '">' + esc(a.status) + '</span>' +
      '</div>'
    ).join('');
  }

  function renderTasks(tasks) {
    const columns = { todo: [], planned: [], in_progress: [], review: [], done: [] };
    for (const t of tasks) {
      const col = columns[t.status] || columns.todo;
      col.push(t);
    }

    const el = document.getElementById('tasks');
    el.innerHTML = Object.entries(columns).map(([status, items]) =>
      '<div class="task-column">' +
        '<h3>' + formatStatus(status) + ' <span class="count">' + items.length + '</span></h3>' +
        (items.length === 0 ? '' : items.map(t =>
          '<div class="task-card clickable ' + esc(t.status) + '" onclick="openTask(' + t.id + ')">' +
            '<div class="task-title">#' + t.id + ' ' + esc(t.title) + '</div>' +
            '<div class="task-meta">' +
              (t.assigned_to ? esc(t.assigned_to) : 'unassigned') +
              (t.parent_id ? ' · subtask' : '') +
            '</div>' +
          '</div>'
        ).join('')) +
      '</div>'
    ).join('');
  }

  function renderPosts(posts) {
    const el = document.getElementById('posts');
    if (!posts.length) { el.innerHTML = '<div class="empty">No activity yet</div>'; return; }
    el.innerHTML = posts.slice(0, 50).map(p =>
      '<div class="feed-item">' +
        '<div class="feed-header">' +
          '<span class="feed-agent">' + esc(p.agent_id) + '</span>' +
          '<span class="feed-time">' + timeAgo(p.created_at) + '</span>' +
        '</div>' +
        '<div class="feed-channel">#' + esc(p.channel_name) + '</div>' +
        '<div class="feed-content">' + esc(p.content) + '</div>' +
      '</div>'
    ).join('');
  }

  function renderCommits(commits) {
    const el = document.getElementById('commits');
    if (!commits.length) { el.innerHTML = '<div class="empty">No commits yet</div>'; return; }
    el.innerHTML = commits.slice(0, 30).map(c =>
      '<div class="feed-item clickable" onclick="openCommit(\\'' + esc(c.hash) + '\\')">' +
        '<div class="feed-header">' +
          '<span class="commit-hash">' + esc(c.hash.slice(0, 8)) + '</span>' +
          '<span class="feed-time">' + timeAgo(c.created_at) + '</span>' +
        '</div>' +
        '<div class="feed-content">' +
          '<span class="commit-msg">' + esc(c.message || 'no message') + '</span>' +
          (c.agent_id ? ' <span class="feed-channel">by ' + esc(c.agent_id) + '</span>' : '') +
        '</div>' +
      '</div>'
    ).join('');
  }

  // ─── Commit Detail Modal ───

  async function openCommit(hash) {
    showModal('<div class="modal-loading">Loading...</div>');

    try {
      const [infoRes, diffRes] = await Promise.all([
        fetch('/api/dashboard/commits/' + hash),
        fetch('/api/dashboard/commits/' + hash + '/diff'),
      ]);

      const info = await infoRes.json();
      const diff = await diffRes.text();

      renderCommitModal(info, diff, hash);
    } catch (e) {
      showModal('<div class="modal-loading">Failed to load commit</div>');
    }
  }

  function showModal(bodyHTML) {
    let overlay = document.getElementById('modal-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'modal-overlay';
      overlay.className = 'modal-overlay';
      overlay.addEventListener('click', function(e) { if (e.target === overlay) closeModal(); });
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = '<div class="modal">' + bodyHTML + '</div>';
    overlay.style.display = 'flex';
    document.addEventListener('keydown', onEsc);
  }

  function closeModal() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.style.display = 'none';
    document.removeEventListener('keydown', onEsc);
  }

  function onEsc(e) { if (e.key === 'Escape') closeModal(); }

  let currentCommitHash = '';
  let currentCommitFiles = [];

  function renderCommitModal(info, diff, hash) {
    currentCommitHash = hash;
    currentCommitFiles = info.files || [];

    const header =
      '<div class="modal-header">' +
        '<h3><span class="commit-hash">' + esc(hash.slice(0, 8)) + '</span> ' + esc(info.message || 'no message') + '</h3>' +
        '<button class="modal-close" onclick="closeModal()">&times;</button>' +
      '</div>';

    const meta =
      '<div class="commit-detail-meta">' +
        (info.agent_id ? '<span>Agent: ' + esc(info.agent_id) + '</span>' : '') +
        (info.parent_hash ? '<span>Parent: ' + esc(info.parent_hash.slice(0, 8)) + '</span>' : '<span>Root commit</span>') +
        '<span>' + esc(info.created_at || '') + '</span>' +
      '</div>';

    const tabs =
      '<div class="tab-bar">' +
        '<button class="active" onclick="switchTab(this, \\'diff\\')" data-tab="diff">Diff</button>' +
        '<button onclick="switchTab(this, \\'files\\')" data-tab="files">Files (' + currentCommitFiles.length + ')</button>' +
      '</div>';

    const sidebar = currentCommitFiles.length > 0
      ? '<div class="modal-sidebar">' +
          '<div class="sidebar-label">Files</div>' +
          currentCommitFiles.map(f =>
            '<div class="sidebar-item" onclick="viewFile(\\'' + esc(f) + '\\')" title="' + esc(f) + '">' + esc(f.split('/').pop()) + '</div>'
          ).join('') +
        '</div>'
      : '';

    const diffHTML = renderDiff(diff);

    const body =
      meta + tabs +
      '<div class="modal-body">' +
        sidebar +
        '<div class="modal-content" id="modal-content">' + diffHTML + '</div>' +
      '</div>';

    showModal(header + body);
  }

  function renderDiff(diff) {
    if (!diff || !diff.trim()) return '<div class="modal-loading">No changes</div>';

    const lines = diff.split('\\n');
    let html = '<div class="diff-view">';
    for (const line of lines) {
      let cls = '';
      if (line.startsWith('+') && !line.startsWith('+++')) cls = 'add';
      else if (line.startsWith('-') && !line.startsWith('---')) cls = 'del';
      else if (line.startsWith('@@')) cls = 'hunk';
      else if (line.startsWith('diff --git') || line.startsWith('index ') || line.startsWith('---') || line.startsWith('+++')) cls = 'file-header';
      html += '<div class="diff-line ' + cls + '">' + esc(line) + '</div>';
    }
    html += '</div>';
    return html;
  }

  function switchTab(btn, tab) {
    btn.parentElement.querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');

    if (tab === 'diff') {
      fetch('/api/dashboard/commits/' + currentCommitHash + '/diff')
        .then(r => r.text())
        .then(diff => { document.getElementById('modal-content').innerHTML = renderDiff(diff); });
    } else if (tab === 'files') {
      renderFileList();
    }
  }

  function renderFileList() {
    const content = document.getElementById('modal-content');
    if (!currentCommitFiles.length) {
      content.innerHTML = '<div class="modal-loading">No files</div>';
      return;
    }
    content.innerHTML = '<div style="padding: 12px;">' +
      currentCommitFiles.map(f =>
        '<div class="sidebar-item" onclick="viewFile(\\'' + esc(f) + '\\')" style="padding: 8px 16px;">' + esc(f) + '</div>'
      ).join('') +
    '</div>';
  }

  async function viewFile(path) {
    const content = document.getElementById('modal-content');
    content.innerHTML = '<div class="modal-loading">Loading...</div>';

    // Highlight active sidebar item
    document.querySelectorAll('.modal-sidebar .sidebar-item').forEach(el => {
      el.classList.toggle('active', el.getAttribute('title') === path);
    });

    try {
      const res = await fetch('/api/dashboard/commits/' + currentCommitHash + '/files/' + path);
      const text = await res.text();
      content.innerHTML = '<div class="file-view">' + esc(text) + '</div>';
    } catch {
      content.innerHTML = '<div class="modal-loading">Failed to load file</div>';
    }
  }

  // ─── Task Management ───

  function openNewTaskForm() {
    const header =
      '<div class="modal-header">' +
        '<h3>New Task</h3>' +
        '<button class="modal-close" onclick="closeModal()">&times;</button>' +
      '</div>';

    const body =
      '<div style="padding: 20px;">' +
        '<div class="form-group">' +
          '<label>Title</label>' +
          '<input class="form-input" id="new-task-title" placeholder="What needs to be done?" autofocus />' +
        '</div>' +
        '<div class="form-group">' +
          '<label>Description</label>' +
          '<textarea class="form-input" id="new-task-desc" placeholder="Details, requirements, context..."></textarea>' +
        '</div>' +
        '<div class="form-row">' +
          '<div class="form-group">' +
            '<label>Priority</label>' +
            '<select class="form-input" id="new-task-priority">' +
              '<option value="0">Normal</option>' +
              '<option value="1">High</option>' +
              '<option value="2">Critical</option>' +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div class="form-actions">' +
          '<button class="btn btn-secondary" onclick="closeModal()">Cancel</button>' +
          '<button class="btn btn-primary" id="btn-create-task" onclick="createTask()">Create Task</button>' +
        '</div>' +
      '</div>';

    showModal(header + body);
    setTimeout(() => document.getElementById('new-task-title')?.focus(), 100);
  }

  async function createTask() {
    const title = document.getElementById('new-task-title').value.trim();
    const description = document.getElementById('new-task-desc').value.trim();
    const priority = Number(document.getElementById('new-task-priority').value);

    if (!title) { document.getElementById('new-task-title').focus(); return; }

    const btn = document.getElementById('btn-create-task');
    btn.disabled = true;
    btn.textContent = 'Creating...';

    try {
      const res = await fetch('/api/dashboard/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, description, priority }),
      });
      if (res.ok) {
        closeModal();
        fetchData();
      }
    } catch (e) {
      btn.disabled = false;
      btn.textContent = 'Create Task';
    }
  }

  async function openTask(id) {
    showModal('<div class="modal-loading">Loading...</div>');

    try {
      const res = await fetch('/api/dashboard/tasks/' + id);
      const task = await res.json();
      renderTaskDetail(task);
    } catch {
      showModal('<div class="modal-loading">Failed to load task</div>');
    }
  }

  function renderTaskDetail(task) {
    const header =
      '<div class="modal-header">' +
        '<h3>#' + task.id + ' ' + esc(task.title) + '</h3>' +
        '<button class="modal-close" onclick="closeModal()">&times;</button>' +
      '</div>';

    const statuses = ['todo', 'planned', 'in_progress', 'review', 'done', 'failed'];
    const statusOptions = statuses.map(s =>
      '<option value="' + s + '"' + (s === task.status ? ' selected' : '') + '>' + s.replace(/_/g, ' ') + '</option>'
    ).join('');

    const subtasksHTML = task.subtasks && task.subtasks.length > 0
      ? '<div class="detail-field">' +
          '<div class="label">Subtasks</div>' +
          '<div class="subtask-list">' +
            task.subtasks.map(s =>
              '<div class="subtask-item">' +
                '<span class="status-badge ' + esc(s.status) + '">' + esc(s.status.replace(/_/g, ' ')) + '</span>' +
                '<span style="cursor:pointer" onclick="openTask(' + s.id + ')">' + esc(s.title) + '</span>' +
              '</div>'
            ).join('') +
          '</div>' +
        '</div>'
      : '';

    const body =
      '<div class="task-detail-grid">' +
        '<div class="task-detail-main">' +
          '<div class="detail-field">' +
            '<div class="label">Description</div>' +
            '<div class="value">' + (esc(task.description) || '<span style="color:var(--text-dim)">No description</span>') + '</div>' +
          '</div>' +
          subtasksHTML +
          (task.output ? '<div class="detail-field"><div class="label">Output</div><div class="file-view" style="max-height:200px;overflow:auto">' + esc(task.output.slice(0, 2000)) + '</div></div>' : '') +
        '</div>' +
        '<div class="task-detail-sidebar">' +
          '<div class="detail-field">' +
            '<div class="label">Status</div>' +
            '<select class="form-input" onchange="updateTaskStatus(' + task.id + ', this.value)">' + statusOptions + '</select>' +
          '</div>' +
          '<div class="detail-field">' +
            '<div class="label">Priority</div>' +
            '<div class="value">' + (task.priority === 0 ? 'Normal' : task.priority === 1 ? 'High' : 'Critical') + '</div>' +
          '</div>' +
          '<div class="detail-field">' +
            '<div class="label">Assigned</div>' +
            '<div class="value">' + (esc(task.assigned_to) || 'Unassigned') + '</div>' +
          '</div>' +
          '<div class="detail-field">' +
            '<div class="label">Created</div>' +
            '<div class="value">' + esc(task.created_at) + '</div>' +
          '</div>' +
          (task.commit_hash ? '<div class="detail-field"><div class="label">Commit</div><div class="value"><span class="commit-hash" style="cursor:pointer" onclick="closeModal();openCommit(\\'' + esc(task.commit_hash) + '\\')">' + esc(task.commit_hash.slice(0,8)) + '</span></div></div>' : '') +
          '<div class="form-actions" style="margin-top:auto">' +
            '<button class="btn btn-danger" onclick="deleteTask(' + task.id + ')">Delete</button>' +
          '</div>' +
        '</div>' +
      '</div>';

    showModal(header + body);
  }

  async function updateTaskStatus(id, status) {
    await fetch('/api/dashboard/tasks/' + id, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status }),
    });
    fetchData();
  }

  async function deleteTask(id) {
    if (!confirm('Delete task #' + id + '?')) return;
    await fetch('/api/dashboard/tasks/' + id, { method: 'DELETE' });
    closeModal();
    fetchData();
  }

  function renderMetrics(m) {
    const el = document.getElementById('metrics');
    if (!m || !m.aiCalls) { el.innerHTML = '<div class="empty">No metrics yet</div>'; return; }

    const ai = m.aiCalls;
    const ts = m.taskStats;
    const avgLatency = ai.count > 0 ? Math.round(ai.total_latency / ai.count) : 0;
    const tokPerSec = ai.count > 0 && ai.total_latency > 0 ? Math.round(ai.total_completion / (ai.total_latency / 1000)) : 0;

    // Summary cards
    let html = '<div class="metrics-grid">';
    html += metricCard('AI Calls', ai.count, 'Total requests');
    html += metricCard('Tokens', fmtNum(ai.total_tokens), fmtNum(ai.total_prompt) + ' prompt / ' + fmtNum(ai.total_completion) + ' completion');
    html += metricCard('Avg Latency', avgLatency + 'ms', tokPerSec + ' tok/sec');
    html += metricCard('Tasks', ts.completed + ' done / ' + ts.failed + ' failed', ts.avg_duration > 0 ? 'avg ' + fmtDuration(ts.avg_duration) : '');
    html += '</div>';

    // Agent breakdown table
    if (m.agentStats && m.agentStats.length > 0) {
      html += '<div class="metrics-section-title">Per Agent</div>';
      html += '<table class="agent-metrics-table"><thead><tr>' +
        '<th>Agent</th><th>AI Calls</th><th>Tokens</th><th>Tasks Done</th><th>Failed</th><th>Avg Task</th>' +
        '</tr></thead><tbody>';
      for (const a of m.agentStats) {
        html += '<tr>' +
          '<td>' + esc(a.agent_id) + '</td>' +
          '<td>' + a.ai_calls + '</td>' +
          '<td>' + fmtNum(a.tokens) + '</td>' +
          '<td>' + a.tasks_done + '</td>' +
          '<td>' + a.tasks_failed + '</td>' +
          '<td>' + (a.avg_task_ms > 0 ? fmtDuration(a.avg_task_ms) : '-') + '</td>' +
        '</tr>';
      }
      html += '</tbody></table>';
    }

    // Latency sparkline
    if (m.recentLatency && m.recentLatency.length > 1) {
      const vals = m.recentLatency.map(r => r.latency || 0).reverse();
      const max = Math.max(...vals, 1);
      html += '<div class="metrics-section-title">Recent AI Latency</div>';
      html += '<div class="latency-bar">';
      for (const v of vals) {
        const pct = Math.max((v / max) * 100, 3);
        html += '<div class="bar" style="height:' + pct + '%" title="' + v + 'ms"></div>';
      }
      html += '</div>';
      html += '<div class="latency-labels"><span>' + vals[0] + 'ms</span><span>' + vals[vals.length - 1] + 'ms</span></div>';
    }

    el.innerHTML = html;
  }

  function metricCard(label, value, sub) {
    return '<div class="metric-card"><div class="label">' + label + '</div><div class="value">' + value + '</div>' +
      (sub ? '<div class="sub">' + sub + '</div>' : '') + '</div>';
  }

  function fmtNum(n) {
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'K';
    return String(n);
  }

  function fmtDuration(ms) {
    if (ms < 1000) return ms + 'ms';
    if (ms < 60000) return (ms / 1000).toFixed(1) + 's';
    return (ms / 60000).toFixed(1) + 'm';
  }

  function formatStatus(s) {
    return s.replace(/_/g, ' ');
  }

  function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr + 'Z').getTime();
    const s = Math.floor(diff / 1000);
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.floor(m / 60);
    if (h < 24) return h + 'h ago';
    return Math.floor(h / 24) + 'd ago';
  }

  function esc(s) {
    if (!s) return '';
    const d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  fetchData();
  setInterval(fetchData, REFRESH_MS);
`;
