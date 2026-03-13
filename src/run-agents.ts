import { AgentRunner } from "./agents/index.ts";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const AI_API_KEY = process.env.AI_API_KEY;
const AI_BASE_URL = process.env.AI_BASE_URL || "https://api.inceptionlabs.ai/v1";
const AI_MODEL = process.env.AI_MODEL || "mercury-2";
const AI_MAX_CONCURRENCY = Number(process.env.AI_MAX_CONCURRENCY) || 2;
const AI_MIN_INTERVAL_MS = Number(process.env.AI_MIN_INTERVAL_MS) || 1500;

if (!AI_API_KEY) {
  console.error("AI_API_KEY is required. Set it in .env");
  process.exit(1);
}

const STUCK_TIMEOUT_MIN = Number(process.env.STUCK_TIMEOUT_MIN) || 0.5;

const runner = new AgentRunner({
  serverUrl: SERVER_URL,
  ai: {
    apiKey: AI_API_KEY,
    baseUrl: AI_BASE_URL,
    model: AI_MODEL,
    maxConcurrency: AI_MAX_CONCURRENCY,
    minIntervalMs: AI_MIN_INTERVAL_MS,
  },
  agents: {
    planners: 1,
    coders: 2,
    reviewers: 1,
    testers: 1,
  },
  stuckTimeoutMinutes: STUCK_TIMEOUT_MIN,
});

// Graceful shutdown
let shuttingDown = false;
process.on("SIGINT", async () => {
  if (shuttingDown) { process.exit(1); }
  shuttingDown = true;
  console.log("\nGraceful shutdown — waiting for active tasks to finish...");
  await runner.stop();
  process.exit(0);
});

console.log(`
  ╔══════════════════════════════════════╗
  ║        AgentsMind — Agents           ║
  ╠══════════════════════════════════════╣
  ║  Server:  ${SERVER_URL.padEnd(25)}║
  ║  Model:   ${AI_MODEL.padEnd(25)}║
  ║  Agents:  1 planner, 2 coders,      ║
  ║           1 reviewer, 1 tester       ║
  ║  Rate:    ${(AI_MAX_CONCURRENCY + " concurrent, " + AI_MIN_INTERVAL_MS + "ms gap").padEnd(25)}║
  ╚══════════════════════════════════════╝
`);

await runner.start();
