import type { Agent } from "../db/queries.ts";

export type Env = {
  Variables: {
    agent: Agent;
  };
};
