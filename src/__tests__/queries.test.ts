import { test, expect, describe, beforeEach } from "bun:test";
import { Database } from "bun:sqlite";
import { createDatabase } from "../db/schema.ts";
import * as q from "../db/queries.ts";

let db: Database;

beforeEach(() => {
  db = createDatabase(":memory:");
  // Register a test agent
  q.createAgent(db, "agent-1", "test-key-1", "coder");
  q.createAgent(db, "agent-2", "test-key-2", "reviewer");
});

describe("updateTask", () => {
  test("rejects invalid status", () => {
    const task = q.createTask(db, "Test task");
    expect(() => q.updateTask(db, task.id, { status: "invalid" })).toThrow("Invalid status");
  });

  test("accepts valid statuses", () => {
    const task = q.createTask(db, "Test task");
    for (const status of q.VALID_STATUSES) {
      const updated = q.updateTask(db, task.id, { status });
      expect(updated?.status).toBe(status);
    }
  });

  test("ignores unknown field keys (SQL injection prevention)", () => {
    const task = q.createTask(db, "Test task");
    const result = q.updateTask(db, task.id, {
      status: "planned",
      "bad; DROP TABLE tasks; --": "x",
    } as any);
    expect(result?.status).toBe("planned");
    // Table should still exist
    const count = db.query("SELECT COUNT(*) as c FROM tasks").get() as { c: number };
    expect(count.c).toBeGreaterThan(0);
  });
});

describe("claimTask", () => {
  test("claims an unassigned todo task", () => {
    const task = q.createTask(db, "Claim me");
    const claimed = q.claimTask(db, task.id, "agent-1");
    expect(claimed).not.toBeNull();
    expect(claimed!.assigned_to).toBe("agent-1");
    expect(claimed!.status).toBe("in_progress");
  });

  test("returns null if task already claimed", () => {
    const task = q.createTask(db, "Race test");
    const first = q.claimTask(db, task.id, "agent-1");
    const second = q.claimTask(db, task.id, "agent-2");
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("returns null if task not in todo status", () => {
    const task = q.createTask(db, "Not todo");
    q.updateTask(db, task.id, { status: "planned" });
    const claimed = q.claimTask(db, task.id, "agent-1");
    expect(claimed).toBeNull();
  });
});

describe("deleteMemory", () => {
  test("deletes own memory", () => {
    const mem = q.saveMemory(db, "agent-1", "insight", "test memory", []);
    const deleted = q.deleteMemory(db, mem.id, "agent-1");
    expect(deleted).toBe(true);
  });

  test("cannot delete another agent's memory", () => {
    const mem = q.saveMemory(db, "agent-1", "insight", "private memory", []);
    const deleted = q.deleteMemory(db, mem.id, "agent-2");
    expect(deleted).toBe(false);
    // Memory should still exist
    const memories = q.getMemories(db, "agent-1");
    expect(memories.length).toBe(1);
  });
});

describe("task dependencies", () => {
  test("addDependency and getDependencies", () => {
    const t1 = q.createTask(db, "Task 1");
    const t2 = q.createTask(db, "Task 2");
    q.addDependency(db, t2.id, t1.id);
    const deps = q.getDependencies(db, t2.id);
    expect(deps.length).toBe(1);
    expect(deps[0]!.id).toBe(t1.id);
  });

  test("cycle detection prevents circular deps", () => {
    const t1 = q.createTask(db, "Task 1");
    const t2 = q.createTask(db, "Task 2");
    const t3 = q.createTask(db, "Task 3");
    q.addDependency(db, t2.id, t1.id); // t2 depends on t1
    q.addDependency(db, t3.id, t2.id); // t3 depends on t2
    expect(() => q.addDependency(db, t1.id, t3.id)).toThrow("cycle"); // t1 depends on t3 → cycle
  });

  test("getReadyTasks excludes tasks with unmet deps", () => {
    const t1 = q.createTask(db, "Task 1");
    const t2 = q.createTask(db, "Task 2");
    q.addDependency(db, t2.id, t1.id);

    const ready = q.getReadyTasks(db);
    const readyIds = ready.map(t => t.id);
    expect(readyIds).toContain(t1.id);
    expect(readyIds).not.toContain(t2.id);
  });

  test("getReadyTasks includes tasks after deps done", () => {
    const t1 = q.createTask(db, "Task 1");
    const t2 = q.createTask(db, "Task 2");
    q.addDependency(db, t2.id, t1.id);
    q.updateTask(db, t1.id, { status: "done" });

    const ready = q.getReadyTasks(db);
    const readyIds = ready.map(t => t.id);
    expect(readyIds).toContain(t2.id);
  });
});

describe("status log", () => {
  test("logs status changes", () => {
    const task = q.createTask(db, "Log test");
    q.updateTask(db, task.id, { status: "planned" });
    q.updateTask(db, task.id, { status: "in_progress" });
    q.updateTask(db, task.id, { status: "done" });

    const log = q.getStatusLog(db, task.id);
    expect(log.length).toBe(3);
    expect(log.map(l => l.status)).toEqual(["planned", "in_progress", "done"]);
  });
});
