import { createDatabase } from "./db/schema.ts";
import { cleanupRateLimits } from "./db/queries.ts";
import { GitRepo } from "./git/repo.ts";
import { createApp } from "./server/app.ts";
import { addClient, removeClient, clientCount } from "./server/ws.ts";

const PORT = Number(process.env.PORT) || 3000;
const DATA_DIR = process.env.DATA_DIR || "./data";
const ADMIN_KEY = process.env.ADMIN_KEY || "changeme";
const MAX_BUNDLE_MB = Number(process.env.MAX_BUNDLE_MB) || 50;
const MAX_PUSHES_PER_HOUR = Number(process.env.MAX_PUSHES_PER_HOUR) || 100;
const MAX_POSTS_PER_HOUR = Number(process.env.MAX_POSTS_PER_HOUR) || 100;

// Initialize
const db = createDatabase(`${DATA_DIR}/agentsmind.db`);
const git = new GitRepo(`${DATA_DIR}/repo.git`);
await git.init();

// Cleanup rate limits every 30 minutes
setInterval(() => cleanupRateLimits(db), 30 * 60 * 1000);

const app = createApp(db, git, {
  adminKey: ADMIN_KEY,
  maxBundleSize: MAX_BUNDLE_MB * 1024 * 1024,
  maxPushesPerHour: MAX_PUSHES_PER_HOUR,
  maxPostsPerHour: MAX_POSTS_PER_HOUR,
});

console.log(`
  ╔══════════════════════════════════════╗
  ║          AgentsMind Server           ║
  ╠══════════════════════════════════════╣
  ║  Port:    ${String(PORT).padEnd(25)}║
  ║  Data:    ${DATA_DIR.padEnd(25)}║
  ║  Bundles: ${(MAX_BUNDLE_MB + "MB max").padEnd(25)}║
  ╚══════════════════════════════════════╝
`);

export default {
  port: PORT,
  fetch(req: Request, server: import("bun").Server<undefined>) {
    // WebSocket upgrade
    if (new URL(req.url).pathname === "/ws") {
      if (server.upgrade(req)) return;
      return new Response("WebSocket upgrade failed", { status: 400 });
    }
    return app.fetch(req, server);
  },
  websocket: {
    open(ws: import("bun").ServerWebSocket<undefined>) {
      addClient(ws);
      ws.send(JSON.stringify({ type: "connected", data: { clients: clientCount() } }));
    },
    message(_ws: import("bun").ServerWebSocket<undefined>, _msg: string | Buffer) {
      // No client-to-server messages needed yet
    },
    close(ws: import("bun").ServerWebSocket<undefined>) {
      removeClient(ws);
    },
  },
};
