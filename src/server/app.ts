import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import type { Database } from "bun:sqlite";
import type { GitRepo } from "../git/repo.ts";
import { authMiddleware, adminMiddleware } from "./middleware.ts";
import { taskRoutes } from "./tasks.ts";
import { commitRoutes } from "./commits.ts";
import { reviewRoutes } from "./reviews.ts";
import { channelRoutes } from "./channels.ts";
import { agentRoutes } from "./agents.ts";
import { dashboardRoutes } from "./dashboard.ts";
import { getStats, recordMetric, saveMemory, getMemories, searchMemories, deleteMemory, searchCode, indexCode } from "../db/queries.ts";
import type { Env } from "./types.ts";

export interface ServerConfig {
  adminKey: string;
  maxBundleSize: number;
  maxPushesPerHour: number;
  maxPostsPerHour: number;
  corsOrigin?: string;
}

export function createApp(db: Database, git: GitRepo, config: ServerConfig) {
  const app = new Hono();

  app.use("*", cors({ origin: config.corsOrigin || "http://localhost:3000" }));
  app.use("*", logger());

  // Security headers
  app.use("*", async (c, next) => {
    await next();
    c.res.headers.set("X-Content-Type-Options", "nosniff");
    c.res.headers.set("X-Frame-Options", "DENY");
    c.res.headers.set("X-XSS-Protection", "1; mode=block");
    c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  });

  // Public
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/stats", (c) => c.json(getStats(db)));

  // Agent registration (public)
  app.route("/api/agents", agentRoutes(db));

  // Dashboard (public)
  app.route("/", dashboardRoutes(db, git, config.adminKey));

  // Admin
  const admin = new Hono();
  admin.use("*", adminMiddleware(config.adminKey));
  admin.post("/agents", async (c) => {
    const body = await c.req.json<{ id: string; role?: string }>();
    const { randomBytes } = await import("node:crypto");
    const apiKey = randomBytes(32).toString("hex");
    const { createAgent } = await import("../db/queries.ts");
    const agent = createAgent(db, body.id, apiKey, body.role ?? "coder");
    return c.json({ id: agent.id, api_key: agent.api_key, role: agent.role }, 201);
  });
  app.route("/api/admin", admin);

  // Authenticated routes
  const authed = new Hono();
  authed.use("*", authMiddleware(db));
  authed.route("/tasks", taskRoutes(db));
  authed.route("/commits", commitRoutes(db, git, config.maxBundleSize, config.maxPushesPerHour));
  authed.route("/reviews", reviewRoutes(db));
  authed.route("/channels", channelRoutes(db, config.maxPostsPerHour));

  // Metrics ingestion (authenticated)
  const metricsApp = new Hono<Env>();
  metricsApp.post("/", async (c) => {
    const agent = c.get("agent");
    const { event, value, meta } = await c.req.json<{ event: string; value: number; meta?: Record<string, unknown> }>();
    if (!event) return c.json({ error: "event required" }, 400);
    recordMetric(db, agent.id, event, value ?? 0, meta ?? {});
    return c.json({ ok: true });
  });
  authed.route("/metrics", metricsApp);

  // Memory (authenticated)
  const memoryApp = new Hono<Env>();
  memoryApp.post("/", async (c) => {
    const agent = c.get("agent");
    const { type, content, tags } = await c.req.json<{ type?: string; content: string; tags?: string[] }>();
    if (!content) return c.json({ error: "content required" }, 400);
    const memory = saveMemory(db, agent.id, type ?? "insight", content, tags ?? []);
    return c.json(memory, 201);
  });
  memoryApp.get("/", (c) => {
    const agent = c.get("agent");
    const type = c.req.query("type");
    const limit = Math.max(1, Math.min(Number(c.req.query("limit")) || 20, 200));
    return c.json(getMemories(db, agent.id, type, limit));
  });
  memoryApp.get("/search", (c) => {
    const agent = c.get("agent");
    const query = c.req.query("q") ?? "";
    return c.json(searchMemories(db, query, agent.id));
  });
  memoryApp.delete("/:id", (c) => {
    const agent = c.get("agent");
    const id = Number(c.req.param("id"));
    const deleted = deleteMemory(db, id, agent.id);
    if (!deleted) return c.json({ error: "Memory not found" }, 404);
    return c.json({ ok: true });
  });
  authed.route("/memories", memoryApp);

  // Code search (authenticated)
  const searchApp = new Hono<Env>();
  searchApp.get("/", (c) => {
    const query = c.req.query("q") ?? "";
    const limit = Math.min(Number(c.req.query("limit")) || 10, 30);
    return c.json(searchCode(db, query, limit));
  });
  searchApp.post("/index", async (c) => {
    const { commit_hash, file_path, content } = await c.req.json<{
      commit_hash: string; file_path: string; content: string;
    }>();
    if (!commit_hash || !file_path || !content) return c.json({ error: "Missing fields" }, 400);
    indexCode(db, commit_hash, file_path, content);
    return c.json({ ok: true });
  });
  authed.route("/search", searchApp);

  app.route("/api", authed);

  return app;
}
