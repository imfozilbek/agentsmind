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
import { getStats, recordMetric } from "../db/queries.ts";
import type { Env } from "./types.ts";

export interface ServerConfig {
  adminKey: string;
  maxBundleSize: number;
  maxPushesPerHour: number;
  maxPostsPerHour: number;
}

export function createApp(db: Database, git: GitRepo, config: ServerConfig) {
  const app = new Hono();

  app.use("*", cors());
  app.use("*", logger());

  // Public
  app.get("/api/health", (c) => c.json({ status: "ok" }));
  app.get("/api/stats", (c) => c.json(getStats(db)));

  // Agent registration (public)
  app.route("/api/agents", agentRoutes(db));

  // Dashboard (public)
  app.route("/", dashboardRoutes(db, git));

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

  app.route("/api", authed);

  return app;
}
