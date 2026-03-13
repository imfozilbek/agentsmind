import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import * as q from "../db/queries.ts";

export function taskRoutes(db: Database) {
  const app = new Hono();

  // Create task
  app.post("/", async (c) => {
    const body = await c.req.json<{ title: string; description?: string; priority?: number; parent_id?: number }>();

    if (!body.title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    const agent = c.get("agent") as q.Agent;
    const task = q.createTask(db, body.title.trim(), body.description ?? "", body.priority ?? 0, agent.id, body.parent_id ?? null);
    return c.json(task, 201);
  });

  // List tasks
  app.get("/", (c) => {
    const status = c.req.query("status");
    const agentId = c.req.query("agent");
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const offset = Number(c.req.query("offset")) || 0;
    const tasks = q.listTasks(db, status, agentId, limit, offset);
    return c.json(tasks);
  });

  // Get task
  app.get("/:id", (c) => {
    const id = Number(c.req.param("id"));
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(task);
  });

  // Update task
  app.patch("/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    const body = await c.req.json<Partial<Pick<q.Task, "status" | "title" | "description" | "priority" | "commit_hash">>>();
    const updated = q.updateTask(db, id, body);
    return c.json(updated);
  });

  // Assign task
  app.post("/:id/assign", async (c) => {
    const id = Number(c.req.param("id"));
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    const body = await c.req.json<{ agent_id: string }>();
    const agent = q.getAgentById(db, body.agent_id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    const updated = q.updateTask(db, id, { assigned_to: body.agent_id, status: "in_progress" });
    return c.json(updated);
  });

  // Get subtasks
  app.get("/:id/subtasks", (c) => {
    const id = Number(c.req.param("id"));
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(q.getSubtasks(db, id));
  });

  return app;
}
