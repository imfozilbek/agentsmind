import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import type { Env } from "./types.ts";
import * as q from "../db/queries.ts";
import { broadcast } from "./ws.ts";

function parseId(s: string): number | null {
  const n = Number(s);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function taskRoutes(db: Database) {
  const app = new Hono<Env>();

  // Create task
  app.post("/", async (c) => {
    const body = await c.req.json<{ title: string; description?: string; priority?: number; parent_id?: number }>();

    if (!body.title?.trim()) {
      return c.json({ error: "title is required" }, 400);
    }

    const agent = c.get("agent");
    const task = q.createTask(db, body.title.trim(), body.description ?? "", body.priority ?? 0, agent.id, body.parent_id ?? null);
    broadcast({ type: "task_created", data: task });
    return c.json(task, 201);
  });

  // List tasks
  app.get("/", (c) => {
    const status = c.req.query("status");
    const agentId = c.req.query("agent");
    const limit = Math.max(1, Math.min(Number(c.req.query("limit")) || 50, 200));
    const offset = Math.max(0, Number(c.req.query("offset")) || 0);
    const tasks = q.listTasks(db, status, agentId, limit, offset);
    return c.json(tasks);
  });

  // Ready tasks (must be before /:id)
  app.get("/ready", (c) => {
    return c.json(q.getReadyTasks(db));
  });

  // Status log (for review count tracking)
  app.get("/:id/status-log", (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid ID" }, 400);
    return c.json(q.getStatusLog(db, id));
  });

  // Get task
  app.get("/:id", (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid ID" }, 400);
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(task);
  });

  // Update task
  app.patch("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid ID" }, 400);
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    const body = await c.req.json<Partial<Pick<q.Task, "status" | "assigned_to" | "title" | "description" | "priority" | "commit_hash">>>();
    try {
      const updated = q.updateTask(db, id, body);
      broadcast({ type: "task_updated", data: updated });
      return c.json(updated);
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Assign task (atomic claim)
  app.post("/:id/assign", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{ agent_id: string }>();
    const agent = q.getAgentById(db, body.agent_id);
    if (!agent) return c.json({ error: "Agent not found" }, 404);

    const claimed = q.claimTask(db, id, body.agent_id);
    if (!claimed) return c.json({ error: "Task not available" }, 409);

    broadcast({ type: "task_assigned", data: claimed });
    return c.json(claimed);
  });

  // Claim rework (atomic: changes_requested → in_progress)
  app.post("/:id/claim-rework", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid ID" }, 400);
    const body = await c.req.json<{ agent_id: string }>();
    const claimed = q.claimRework(db, id, body.agent_id);
    if (!claimed) return c.json({ error: "Task not available for rework" }, 409);
    broadcast({ type: "task_updated", data: claimed });
    return c.json(claimed);
  });

  // Get subtasks
  app.get("/:id/subtasks", (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid ID" }, 400);
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);
    return c.json(q.getSubtasks(db, id));
  });

  // ─── Dependencies ───

  // Add dependency
  app.post("/:id/dependencies", async (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid ID" }, 400);
    const task = q.getTask(db, id);
    if (!task) return c.json({ error: "Task not found" }, 404);

    const { depends_on_id } = await c.req.json<{ depends_on_id: number }>();
    const dep = q.getTask(db, depends_on_id);
    if (!dep) return c.json({ error: "Dependency task not found" }, 404);

    try {
      q.addDependency(db, id, depends_on_id);
      broadcast({ type: "task_updated", data: task });
      return c.json({ ok: true });
    } catch (e: unknown) {
      return c.json({ error: (e as Error).message }, 400);
    }
  });

  // Remove dependency
  app.delete("/:id/dependencies/:depId", (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid ID" }, 400);
    const depId = parseId(c.req.param("depId"));
    if (!depId) return c.json({ error: "Invalid ID" }, 400);
    q.removeDependency(db, id, depId);
    broadcast({ type: "task_updated", data: { id } });
    return c.json({ ok: true });
  });

  // List dependencies
  app.get("/:id/dependencies", (c) => {
    const id = parseId(c.req.param("id"));
    if (!id) return c.json({ error: "Invalid ID" }, 400);
    return c.json(q.getDependencies(db, id));
  });

  return app;
}
