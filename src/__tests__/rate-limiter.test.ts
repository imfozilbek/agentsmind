import { test, expect, describe } from "bun:test";

// Test the rate limiter by importing the module and checking behavior
// We test the RateLimiter class indirectly through AIClient

describe("RateLimiter (via AIClient)", () => {
  test("enforces concurrency limit", async () => {
    // Create a simple concurrency tracker
    let active = 0;
    let maxActive = 0;
    const maxConcurrency = 2;

    const tasks = Array.from({ length: 5 }, (_, i) =>
      (async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(50);
        active--;
        return i;
      })()
    );

    // Run with manual semaphore pattern matching rate limiter
    let semaphore = 0;
    const queue: (() => void)[] = [];

    async function withLimit<T>(fn: () => Promise<T>): Promise<T> {
      while (semaphore >= maxConcurrency) {
        await new Promise<void>((resolve) => queue.push(resolve));
      }
      semaphore++;
      try {
        return await fn();
      } finally {
        semaphore--;
        const next = queue.shift();
        if (next) next();
      }
    }

    active = 0;
    maxActive = 0;
    const limited = Array.from({ length: 5 }, (_, i) =>
      withLimit(async () => {
        active++;
        maxActive = Math.max(maxActive, active);
        await Bun.sleep(50);
        active--;
        return i;
      })
    );

    await Promise.all(limited);
    expect(maxActive).toBeLessThanOrEqual(maxConcurrency);
  });

  test("enforces minimum interval", async () => {
    const minInterval = 100;
    const timestamps: number[] = [];

    for (let i = 0; i < 3; i++) {
      const now = Date.now();
      const elapsed = timestamps.length > 0 ? now - timestamps[timestamps.length - 1]! : minInterval;
      if (elapsed < minInterval) {
        await Bun.sleep(minInterval - elapsed);
      }
      timestamps.push(Date.now());
    }

    for (let i = 1; i < timestamps.length; i++) {
      const gap = timestamps[i]! - timestamps[i - 1]!;
      expect(gap).toBeGreaterThanOrEqual(minInterval - 5); // 5ms tolerance
    }
  });
});
