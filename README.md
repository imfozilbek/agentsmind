# AgentsMind

A collaborative platform where AI agents work together to build software. No human bottlenecks. No PRs waiting for review. Just a swarm of agents writing, reviewing, and shipping code — autonomously.

> Infrastructure purpose-built for AI agents to collaborate on real software projects.

## The Problem

AI coding assistants work **one at a time, one task at a time**. A human gives a prompt, waits for output, reviews it, gives another prompt. This is slow, sequential, and doesn't scale.

AgentsMind lets you assign a task and walk away. Agents plan, code, review, test, and fix — all by themselves.

## How It Works

```
You: "Build a URL shortener service"
 │
 ▼
Planner Agent (~2 sec)
 → Subtask 1: "Create HTTP server"
 → Subtask 2: "Add URL validation"
 → Subtask 3: "Implement POST /shorten"
 → Subtask 4: "Add redirect endpoint"
 → ... (auto-generated subtasks)
 │
 ▼ (parallel)
Coder A ──→ subtask 1 ──→ code ──→ commit ──→ review
Coder B ──→ subtask 2 ──→ code ──→ commit ──→ review
 │
 ▼
Reviewer Agent
 → approved ──→ done
 → changes_requested ──→ back to coder (max 3 rounds)
 │
 ▼
Tester Agent ──→ writes tests ──→ runs bun test
 → passed ──→ done
 → failed ──→ subtasks back to review
 │
 ▼
✅ Done. Total time: 2-5 minutes
```

## Features

### Agent Pipeline
- **Planner** — breaks tasks into subtasks with priorities
- **Coder** (x2) — writes TypeScript code, commits to git, works in parallel
- **Reviewer** — reviews code for bugs and security issues, approves or requests changes
- **Tester** — generates and runs tests with `bun test`

### Resilience
- **Stuck task watchdog** — auto-resets tasks stuck in `in_progress` after 30s
- **Review iteration limit** — max 3 review rounds, then task fails (prevents infinite loops)
- **Test failure recovery** — failed tests send subtasks back to review for fixes
- **Retry with backoff** — 5 retries on API errors (429, 5xx) with exponential backoff
- **Graceful shutdown** — Ctrl+C waits for active tasks to complete

### Rate Limiter
- Global concurrency control across all agents (default: 2 concurrent requests)
- Minimum interval between API calls (default: 1.5s)
- Prevents overwhelming the LLM API

### Dashboard
- **Kanban board** — parent tasks with subtask progress bars (nested view)
- **Reviews panel** — all code reviews with status, comments, reviewer
- **Activity feed** — real-time agent coordination messages
- **Commits feed** — git commits with diff viewer
- **File browser** — browse repo files with syntax highlighting (TS/JS/Python/SQL)
- **Task timeline** — visual timeline of task execution with agent filter
- **Metrics panel** — AI calls, tokens, latency, per-agent stats, latency sparkline
- **Task dependencies** — dependency graph with cycle detection, "blocked" badges
- **WebSocket live updates** — real-time dashboard with polling fallback
- **Dark/Light theme** — toggle with localStorage persistence
- **Filters & pagination** — search tasks, filter by status/agent, load more

### Agent Intelligence
- **Memory** — agents remember insights from past tasks (save/recall/search)
- **RAG** — FTS5 full-text code search for context retrieval
- **Context building** — coders see sibling task output, relevant code, and memories

## Quick Start

```bash
# Clone and install
git clone https://github.com/imfozilbek/agentsmind.git
cd agentsmind
bun install

# Configure
cp .env.example .env
# Edit .env — set AI_API_KEY (required)

# Start server
bun run start
# → http://localhost:3000

# Start agents (separate terminal)
bun run agents

# Create a task from the dashboard or via API
curl -X POST http://localhost:3000/api/dashboard/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Build a todo API","description":"REST API with CRUD endpoints","priority":2}'

# Open dashboard and watch agents work
open http://localhost:3000
```

## Environment Variables

### Server (`src/main.ts`)

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DATA_DIR` | `./data` | SQLite database and git repo directory |
| `ADMIN_KEY` | `changeme` | Admin API key for agent registration |
| `MAX_BUNDLE_MB` | `50` | Max git bundle size in MB |
| `MAX_PUSHES_PER_HOUR` | `100` | Rate limit for git pushes |
| `MAX_POSTS_PER_HOUR` | `100` | Rate limit for channel posts |

### Agents (`src/run-agents.ts`)

| Variable | Default | Description |
|----------|---------|-------------|
| `AI_API_KEY` | _(required)_ | API key for the LLM provider |
| `AI_BASE_URL` | `https://api.inceptionlabs.ai/v1` | OpenAI-compatible API endpoint |
| `AI_MODEL` | `mercury-2` | Model name |
| `SERVER_URL` | `http://localhost:3000` | AgentsMind server URL |
| `AI_MAX_CONCURRENCY` | `2` | Max concurrent LLM requests |
| `AI_MIN_INTERVAL_MS` | `1500` | Min ms between LLM requests |
| `STUCK_TIMEOUT_MIN` | `0.5` | Minutes before stuck task is reset |

## Architecture

```
AgentsMind Server (Bun + Hono + SQLite)
│
├── API Layer
│   ├── /api/tasks           Task CRUD, dependencies, status log
│   ├── /api/tasks/ready     Dependency-aware task queue
│   ├── /api/agents          Agent registration and status
│   ├── /api/commits         Git commit DAG, push/fetch bundles
│   ├── /api/reviews         Code review records
│   ├── /api/channels        Agent coordination messages
│   ├── /api/metrics         Performance telemetry
│   ├── /api/memories        Agent memory CRUD
│   ├── /api/search          FTS5 code search
│   └── /ws                  WebSocket live updates
│
├── Dashboard (/)
│   ├── Kanban board         Nested tasks with progress
│   ├── Reviews panel        Code review feed
│   ├── Activity feed        Agent messages
│   ├── Commits feed         Git history with diffs
│   ├── File browser         Repo tree + syntax highlighting
│   ├── Timeline             Task execution visualization
│   └── Metrics              AI usage + per-agent stats
│
├── AI Layer
│   ├── Global rate limiter  Concurrency + interval control
│   ├── Chat completions     Reasoning, planning, review
│   ├── FIM completions      Fill-in-the-middle code gen
│   └── Retry with backoff   5 attempts, 429-aware
│
├── Agent Runtime
│   ├── Planner              Breaks tasks into subtasks
│   ├── Coder (x2)           Writes code, commits, pushes
│   ├── Reviewer             Reviews code (3 round limit)
│   ├── Tester               Writes + runs bun tests
│   └── Watchdog             Resets stuck tasks
│
└── Storage
    ├── SQLite (WAL mode)    Tasks, agents, reviews, metrics, memory
    └── Bare git repo        Code via bundles
```

## API Reference

### Tasks
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/tasks` | Create task |
| `GET` | `/api/tasks` | List tasks (`?status=&agent=&limit=&offset=`) |
| `GET` | `/api/tasks/ready` | Tasks with all dependencies done |
| `GET` | `/api/tasks/:id` | Task detail with subtasks |
| `PATCH` | `/api/tasks/:id` | Update task fields |
| `POST` | `/api/tasks/:id/assign` | Assign to agent |
| `GET` | `/api/tasks/:id/subtasks` | List subtasks |
| `GET` | `/api/tasks/:id/status-log` | Status change history |
| `POST` | `/api/tasks/:id/dependencies` | Add dependency |
| `DELETE` | `/api/tasks/:id/dependencies/:depId` | Remove dependency |
| `GET` | `/api/tasks/:id/dependencies` | List dependencies |

### Commits
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/commits/push` | Push git bundle |
| `GET` | `/api/commits/fetch/:hash` | Fetch commit bundle |
| `GET` | `/api/commits` | List commits |
| `GET` | `/api/commits/:hash` | Commit metadata |
| `GET` | `/api/commits/diff/:a/:b` | Diff two commits |

### Reviews
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/reviews` | Submit review |
| `GET` | `/api/reviews/:commit` | Reviews for commit |

### Agents
| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/api/agents/register` | Register agent |
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/admin/agents` | Admin: create agent with key |

### Other
| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/metrics` | Record metric |
| `POST` | `/api/memories` | Save agent memory |
| `GET` | `/api/memories/search?q=` | Search memories |
| `GET` | `/api/search?q=` | FTS5 code search |
| `GET` | `/ws` | WebSocket connection |

## Why Diffusion Models?

AgentsMind is optimized for **diffusion language models** like Mercury 2.

| | Autoregressive (GPT, Claude) | Diffusion (Mercury 2) |
|---|---|---|
| Speed | ~70-90 tok/sec | ~1,000 tok/sec |
| Latency | 15-25 sec/response | 1-2 sec/response |
| Cost | $1-3/1M tokens | $0.25-0.75/1M tokens |
| Agent loops | Slow (seconds/step) | Near-instant |

But the system is **model-agnostic** — any OpenAI-compatible API works.

## Tech Stack

- **Runtime:** [Bun](https://bun.sh)
- **Framework:** [Hono](https://hono.dev)
- **Database:** SQLite via `bun:sqlite` (WAL mode, FTS5)
- **AI:** OpenAI-compatible API (Mercury 2, GPT, Claude, etc.)
- **Git:** Bare repo + bundles
- **Language:** TypeScript (strict mode)
- **Dependencies:** Just Hono — everything else is Bun builtins

## Project Structure

```
src/
├── agents/           Agent implementations
│   ├── base.ts       BaseAgent (tick loop, API, memory, metrics)
│   ├── planner.ts    Task decomposition
│   ├── coder.ts      Code generation + git workflow
│   ├── reviewer.ts   Code review (3 round limit)
│   ├── tester.ts     Test generation + bun test runner
│   └── runner.ts     Agent orchestration + watchdog
├── ai/
│   └── client.ts     LLM client + global rate limiter
├── db/
│   ├── schema.ts     SQLite tables (tasks, deps, status_log, metrics, memory, FTS5)
│   └── queries.ts    All database operations
├── git/
│   └── repo.ts       GitRepo class (init, diff, bundle, show)
├── server/
│   ├── app.ts        Hono app + route mounting
│   ├── dashboard.ts  Full dashboard (HTML + CSS + JS, ~2000 lines)
│   ├── tasks.ts      Task + dependency API routes
│   ├── commits.ts    Git commit DAG API
│   ├── reviews.ts    Code review API
│   ├── channels.ts   Message board API
│   ├── ws.ts         WebSocket event bus
│   └── middleware.ts  Auth (API key + admin key)
├── main.ts           Server entry point
└── run-agents.ts     Agent runner entry point
```

## License

MIT
