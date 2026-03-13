import { AgentRunner } from "./agents/index.ts";

const SERVER_URL = process.env.SERVER_URL || "http://localhost:3000";
const AI_API_KEY = process.env.AI_API_KEY;
const AI_BASE_URL = process.env.AI_BASE_URL || "https://api.inceptionlabs.ai/v1";
const AI_MODEL = process.env.AI_MODEL || "mercury-2";

if (!AI_API_KEY) {
  console.error("AI_API_KEY is required. Set it in .env");
  process.exit(1);
}

const runner = new AgentRunner({
  serverUrl: SERVER_URL,
  ai: {
    apiKey: AI_API_KEY,
    baseUrl: AI_BASE_URL,
    model: AI_MODEL,
  },
  agents: {
    planners: 1,
    coders: 2,
    reviewers: 1,
    testers: 1,
  },
});

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("\nShutting down agents...");
  runner.stop();
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
  ╚══════════════════════════════════════╝
`);

await runner.start();
