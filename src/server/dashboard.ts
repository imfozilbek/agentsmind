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
      <h2>Tasks</h2>
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
      const res = await fetch('/api/dashboard');
      const data = await res.json();
      lastData = data;
      render(data);
      document.getElementById('status-dot').classList.remove('error');
      document.getElementById('last-update').textContent = 'live — ' + new Date().toLocaleTimeString();
    } catch (e) {
      document.getElementById('status-dot').classList.add('error');
      document.getElementById('last-update').textContent = 'disconnected';
    }
  }

  function render(data) {
    renderStats(data.stats);
    renderAgents(data.agents);
    renderTasks(data.tasks);
    renderPosts(data.posts);
    renderCommits(data.commits);
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
          '<div class="task-card ' + esc(t.status) + '">' +
            '<div class="task-title">' + esc(t.title) + '</div>' +
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
