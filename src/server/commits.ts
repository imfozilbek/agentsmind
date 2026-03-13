import { Hono } from "hono";
import { $ } from "bun";
import type { Database } from "bun:sqlite";
import { GitRepo, isValidHash } from "../git/repo.ts";
import * as q from "../db/queries.ts";

export function commitRoutes(db: Database, git: GitRepo, maxBundleSize: number, maxPushesPerHour: number) {
  const app = new Hono();

  // Push bundle
  app.post("/push", async (c) => {
    const agent = c.get("agent") as q.Agent;

    if (!q.checkRateLimit(db, agent.id, "push", maxPushesPerHour)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    const body = await c.req.arrayBuffer();
    if (body.byteLength > maxBundleSize) {
      return c.json({ error: `Bundle too large (max ${maxBundleSize} bytes)` }, 400);
    }

    const tempPath = `/tmp/agentsmind-bundle-${Date.now()}.bundle`;
    await Bun.write(tempPath, body);

    try {
      const hashes = await git.unbundle(tempPath);
      const indexed: string[] = [];

      for (const hash of hashes) {
        if (q.getCommit(db, hash)) continue;

        const info = await git.getCommitInfo(hash);
        q.insertCommit(db, hash, info.parentHash, agent.id, null, info.message);
        indexed.push(hash);
      }

      q.incrementRateLimit(db, agent.id, "push");
      return c.json({ indexed });
    } finally {
      await Bun.file(tempPath).exists() && (await $`rm ${tempPath}`.quiet());
    }
  });

  // Fetch bundle
  app.get("/fetch/:hash", async (c) => {
    const hash = c.req.param("hash");
    if (!isValidHash(hash)) return c.json({ error: "Invalid hash" }, 400);

    const exists = await git.commitExists(hash);
    if (!exists) return c.json({ error: "Commit not found" }, 404);

    const bundlePath = await git.createBundle(hash);
    const file = Bun.file(bundlePath);
    const content = await file.arrayBuffer();
    await $`rm ${bundlePath}`.quiet();

    return new Response(content, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": `attachment; filename="${hash.slice(0, 8)}.bundle"`,
      },
    });
  });

  // List commits
  app.get("/", (c) => {
    const agentId = c.req.query("agent");
    const limit = Math.min(Number(c.req.query("limit")) || 50, 200);
    const offset = Number(c.req.query("offset")) || 0;
    return c.json(q.listCommits(db, agentId, limit, offset));
  });

  // Get commit
  app.get("/:hash", (c) => {
    const hash = c.req.param("hash");
    if (!isValidHash(hash)) return c.json({ error: "Invalid hash" }, 400);
    const commit = q.getCommit(db, hash);
    if (!commit) return c.json({ error: "Commit not found" }, 404);
    return c.json(commit);
  });

  // Get children
  app.get("/:hash/children", (c) => {
    const hash = c.req.param("hash");
    if (!isValidHash(hash)) return c.json({ error: "Invalid hash" }, 400);
    return c.json(q.getChildren(db, hash));
  });

  // Get lineage
  app.get("/:hash/lineage", (c) => {
    const hash = c.req.param("hash");
    if (!isValidHash(hash)) return c.json({ error: "Invalid hash" }, 400);
    return c.json(q.getLineage(db, hash));
  });

  // Get leaves
  app.get("/leaves", (c) => {
    return c.json(q.getLeaves(db));
  });

  // Diff
  app.get("/diff/:a/:b", async (c) => {
    const a = c.req.param("a");
    const b = c.req.param("b");
    if (!isValidHash(a) || !isValidHash(b)) return c.json({ error: "Invalid hash" }, 400);

    const agent = c.get("agent") as q.Agent;
    if (!q.checkRateLimit(db, agent.id, "diff", 60)) {
      return c.json({ error: "Rate limit exceeded" }, 429);
    }

    const diff = await git.diff(a, b);
    q.incrementRateLimit(db, agent.id, "diff");
    return c.text(diff);
  });

  // Show file at commit
  app.get("/:hash/files/*", async (c) => {
    const hash = c.req.param("hash");
    if (!isValidHash(hash)) return c.json({ error: "Invalid hash" }, 400);

    const filePath = c.req.path.split("/files/")[1];
    if (!filePath) return c.json({ error: "File path required" }, 400);

    try {
      const content = await git.showFile(hash, filePath);
      return c.text(content);
    } catch {
      return c.json({ error: "File not found" }, 404);
    }
  });

  return app;
}
