import type { Context, Next } from "hono";
import type { Database } from "bun:sqlite";
import { timingSafeEqual } from "node:crypto";
import type { Env } from "./types.ts";
import { getAgentByKey } from "../db/queries.ts";

function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function authMiddleware(db: Database) {
  return async (c: Context<Env>, next: Next) => {
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
    if (!header?.startsWith("Bearer ") || !safeCompare(header.slice(7), adminKey)) {
      return c.json({ error: "Invalid admin key" }, 401);
    }
    await next();
  };
}
