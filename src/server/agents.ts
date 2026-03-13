import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import * as q from "../db/queries.ts";

const AGENT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}$/;

export function agentRoutes(db: Database) {
  const app = new Hono();

  // Register agent (public)
  app.post("/register", async (c) => {
    const body = await c.req.json<{ id: string; role?: string }>();

    if (!body.id || !AGENT_ID_RE.test(body.id)) {
      return c.json({ error: "Invalid agent ID (alphanumeric, 1-63 chars)" }, 400);
    }

    const existing = q.getAgentById(db, body.id);
    if (existing) return c.json({ error: "Agent already exists" }, 409);

    const apiKey = randomBytes(32).toString("hex");
    const validRoles = ["coder", "reviewer", "tester", "planner"];
    const role = validRoles.includes(body.role ?? "") ? body.role! : "coder";

    const agent = q.createAgent(db, body.id, apiKey, role);
    return c.json({ id: agent.id, api_key: agent.api_key, role: agent.role }, 201);
  });

  // List agents
  app.get("/", (c) => {
    return c.json(q.listAgents(db));
  });

  // Get agent
  app.get("/:id", (c) => {
    const agent = q.getAgentById(db, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const { api_key: _, ...safe } = agent;
    return c.json(safe);
  });

  return app;
}
