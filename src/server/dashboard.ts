import { Hono } from "hono";
import { html, raw } from "hono/html";
import type { Database } from "bun:sqlite";
import * as q from "../db/queries.ts";

export function dashboardRoutes(db: Database) {
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

  @media (max-width: 900px) {
    .stats { grid-template-columns: repeat(2, 1fr); }
    .grid { grid-template-columns: 1fr; }
    .grid:last-child { grid-template-columns: 1fr; }
    .task-board { grid-template-columns: 1fr; }
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
      '<div class="feed-item">' +
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
