import { Hono } from "hono";
import type { Database } from "bun:sqlite";
import * as q from "../db/queries.ts";

export function reviewRoutes(db: Database) {
  const app = new Hono();

  // Submit review
  app.post("/", async (c) => {
    const agent = c.get("agent") as q.Agent;
    const body = await c.req.json<{ commit_hash: string; status: string; comment: string }>();

    if (!body.commit_hash || !body.status || !body.comment?.trim()) {
      return c.json({ error: "commit_hash, status, and comment are required" }, 400);
    }

    const validStatuses = ["approved", "changes_requested", "commented"];
    if (!validStatuses.includes(body.status)) {
      return c.json({ error: `status must be one of: ${validStatuses.join(", ")}` }, 400);
    }

    const commit = q.getCommit(db, body.commit_hash);
    if (!commit) return c.json({ error: "Commit not found" }, 404);

    if (commit.agent_id === agent.id) {
      return c.json({ error: "Cannot review your own commit" }, 400);
    }

    const review = q.createReview(db, body.commit_hash, agent.id, body.status, body.comment.trim());
    return c.json(review, 201);
  });

  // Get reviews for commit
  app.get("/:commitHash", (c) => {
    const commitHash = c.req.param("commitHash");
    const reviews = q.getReviewsForCommit(db, commitHash);
    return c.json(reviews);
  });

  return app;
}
