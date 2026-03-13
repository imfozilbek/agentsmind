import type { Context, Next } from "hono";
import type { Database } from "bun:sqlite";
import { getAgentByKey } from "../db/queries.ts";

export function authMiddleware(db: Database) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ")) {
      return c.json({ error: "Missing or invalid Authorization header" }, 401);
    }

    const apiKey = header.slice(7);
    const agent = getAgentByKey(db, apiKey);
    if (!agent) {
      return c.json({ error: "Invalid API key" }, 401);
    }

    c.set("agent", agent);
    await next();
  };
}

export function adminMiddleware(adminKey: string) {
  return async (c: Context, next: Next) => {
    const header = c.req.header("Authorization");
    if (!header?.startsWith("Bearer ") || header.slice(7) !== adminKey) {
      return c.json({ error: "Invalid admin key" }, 401);
    }
    await next();
  };
}
