import { Database } from "bun:sqlite";

export function createDatabase(path: string): Database {
  const db = new Database(path, { create: true });

  db.exec("PRAGMA journal_mode=WAL");
  db.exec("PRAGMA busy_timeout=5000");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec("PRAGMA synchronous=NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      api_key TEXT UNIQUE NOT NULL,
      role TEXT NOT NULL DEFAULT 'coder',
      status TEXT NOT NULL DEFAULT 'idle',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'todo',
      priority INTEGER NOT NULL DEFAULT 0,
      parent_id INTEGER REFERENCES tasks(id),
      assigned_to TEXT REFERENCES agents(id),
      created_by TEXT,
      commit_hash TEXT,
      output TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_assigned ON tasks(assigned_to);
    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);

    CREATE TABLE IF NOT EXISTS commits (
      hash TEXT PRIMARY KEY,
      parent_hash TEXT,
      agent_id TEXT REFERENCES agents(id),
      task_id INTEGER REFERENCES tasks(id),
      message TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_commits_parent ON commits(parent_hash);
    CREATE INDEX IF NOT EXISTS idx_commits_agent ON commits(agent_id);
    CREATE INDEX IF NOT EXISTS idx_commits_task ON commits(task_id);

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      commit_hash TEXT NOT NULL REFERENCES commits(hash),
      reviewer_id TEXT NOT NULL REFERENCES agents(id),
      status TEXT NOT NULL DEFAULT 'pending',
      comment TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_commit ON reviews(commit_hash);

    CREATE TABLE IF NOT EXISTS channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER NOT NULL REFERENCES channels(id),
      agent_id TEXT NOT NULL REFERENCES agents(id),
      parent_id INTEGER REFERENCES posts(id),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_posts_channel ON posts(channel_id);
    CREATE INDEX IF NOT EXISTS idx_posts_parent ON posts(parent_id);

    CREATE TABLE IF NOT EXISTS rate_limits (
      agent_id TEXT NOT NULL,
      action TEXT NOT NULL,
      window_start TEXT NOT NULL,
      count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (agent_id, action, window_start)
    );

    CREATE TABLE IF NOT EXISTS metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT NOT NULL,
      event TEXT NOT NULL,
      value REAL NOT NULL DEFAULT 0,
      meta TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_metrics_agent ON metrics(agent_id);
    CREATE INDEX IF NOT EXISTS idx_metrics_event ON metrics(event);
    CREATE INDEX IF NOT EXISTS idx_metrics_time ON metrics(created_at);
  `);

  return db;
}
