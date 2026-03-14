import { test, expect, describe } from "bun:test";
import { isValidHash } from "../git/repo.ts";

describe("isValidHash", () => {
  test("accepts valid hashes", () => {
    expect(isValidHash("abcd")).toBe(true);
    expect(isValidHash("abc123def456")).toBe(true);
    expect(isValidHash("a".repeat(40))).toBe(true);
    expect(isValidHash("a".repeat(64))).toBe(true);
  });

  test("rejects invalid hashes", () => {
    expect(isValidHash("")).toBe(false);
    expect(isValidHash("abc")).toBe(false); // too short
    expect(isValidHash("xyz!")).toBe(false); // invalid chars
    expect(isValidHash("a".repeat(65))).toBe(false); // too long
    expect(isValidHash("ABCD1234")).toBe(true); // case insensitive
  });
});

describe("showFile path validation", () => {
  test("rejects path traversal", async () => {
    // Import the GitRepo class to test path validation
    const { GitRepo } = await import("../git/repo.ts");
    const repo = new GitRepo("/tmp/nonexistent-repo");

    await expect(repo.showFile("abc123", "../etc/passwd")).rejects.toThrow("Invalid file path");
    await expect(repo.showFile("abc123", "/etc/passwd")).rejects.toThrow("Invalid file path");
    await expect(repo.showFile("abc123", "..\\windows")).rejects.toThrow("Invalid file path");
    await expect(repo.showFile("abc123", "foo/../../bar")).rejects.toThrow("Invalid file path");
  });
});
