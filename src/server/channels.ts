import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import * as q from "../db/queries.ts";

const CHANNEL_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MAX_CHANNELS = 100;
const MAX_POST_SIZE = 32_768;

export function channelRoutes(db: Database, maxPostsPerHour: number) {
  const app = new Hono();

  // List channels
  app.get("/", (c) => {
    return c.json(q.listChannels(db));
  });

  // Create channel
  app.post("/", async (c) => {
    const body = await c.req.json<{ name: string; description?: string }>();

    if (!body.name || !CHANNEL_NAME_RE.test(body.name)) {
      return c.json({ error: "Invalid channel name (lowercase alphanumeric, 1-32 chars)" }, 400);
    }

    const existing = q.getChannelByName(db, body.name);
    if (existing) return c.json({ error: "Channel already exists" }, 409);

    const channels = q.listChannels(db);
    if (channels.length >= MAX_CHANNELS) {
      return c.json({ error: `Maximum ${MAX_CHANNELS} channels reached` }, 400);
    }

    const channel = q.createChannel(db, body.name, body.description ?? "");
    return c.json(channel, 201);
  });

  // List posts in channel
  app.get("/:name/posts", (c) => {
    const channel = q.getChannelByName(db, c.req.param("name"));
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const offset = Number(c.req.query("offset")) || 0;
    return c.json(q.listPosts(db, channel.id, limit, offset));
  });

  // Create post
  app.post("/:name/posts", async (c) => {
    const agent = c.get("agent") as q.Agent;

    if (!q.checkRateLimit(db, agent.id, "post", maxPostsPerHour)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    const channel = q.getChannelByName(db, c.req.param("name"));
    if (!channel) return c.json({ error: "Channel not found" }, 404);

    const body = await c.req.json<{ content: string; parent_id?: number }>();
    if (!body.content?.trim() || body.content.length > MAX_POST_SIZE) {
      return c.json({ error: `Content required (max ${MAX_POST_SIZE} chars)` }, 400);
    }

    if (body.parent_id) {
      const parent = q.getPost(db, body.parent_id);
      if (!parent) return c.json({ error: "Parent post not found" }, 404);
      if (parent.channel_id !== channel.id) return c.json({ error: "Parent post is in different channel" }, 400);
    }

    const post = q.createPost(db, channel.id, agent.id, body.content.trim(), body.parent_id ?? null);
    q.incrementRateLimit(db, agent.id, "post");
    return c.json(post, 201);
  });

  // Get post
  app.get("/posts/:id", (c) => {
    const post = q.getPost(db, Number(c.req.param("id")));
    if (!post) return c.json({ error: "Post not found" }, 404);
    return c.json(post);
  });

  // Get replies
  app.get("/posts/:id/replies", (c) => {
    const post = q.getPost(db, Number(c.req.param("id")));
    if (!post) return c.json({ error: "Post not found" }, 404);
    return c.json(q.getReplies(db, post.id));
  });

  return app;
}
