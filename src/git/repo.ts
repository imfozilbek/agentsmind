import { $ } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const HASH_RE = /^[0-9a-f]{4,64}$/i;

export function isValidHash(s: string): boolean {
  return HASH_RE.test(s);
}

export class GitRepo {
  constructor(public readonly path: string) {}

  async init(): Promise<void> {
    if (!existsSync(this.path)) {
      mkdirSync(this.path, { recursive: true });
      await $`git init --bare ${this.path}`.quiet();
    }
  }

  async unbundle(bundlePath: string): Promise<string[]> {
    const result = await $`git -C ${this.path} bundle unbundle ${bundlePath} 2>&1`.text();
    const hashes: string[] = [];
    for (const line of result.split("\n")) {
      const match = line.match(/^([0-9a-f]{40})\s/);
      if (match?.[1]) hashes.push(match[1]);
    }
    return hashes;
  }

  async createBundle(hash: string): Promise<string> {
    const tempRef = `refs/temp/bundle-${hash.slice(0, 8)}-${Date.now()}`;
    await $`git -C ${this.path} update-ref ${tempRef} ${hash}`.quiet();

    const bundlePath = join(this.path, `bundle-${hash.slice(0, 8)}.bundle`);
    try {
      await $`git -C ${this.path} bundle create ${bundlePath} ${tempRef}`.quiet();
    } finally {
      await $`git -C ${this.path} update-ref -d ${tempRef}`.quiet();
    }
    return bundlePath;
  }

  async commitExists(hash: string): Promise<boolean> {
    try {
      await $`git -C ${this.path} cat-file -t ${hash}`.quiet();
      return true;
    } catch {
      return false;
    }
  }

  async getCommitInfo(hash: string): Promise<{ parentHash: string | null; message: string }> {
    const log = await $`git -C ${this.path} log -1 --format=%P%n%s ${hash}`.text();
    const lines = log.trim().split("\n");
    const parentHash = lines[0]?.trim().split(" ")[0] || null;
    const message = lines.slice(1).join("\n");
    return { parentHash: parentHash || null, message };
  }

  async diff(hashA: string, hashB: string): Promise<string> {
    return $`git -C ${this.path} diff ${hashA} ${hashB}`.text();
  }

  async showFile(hash: string, filePath: string): Promise<string> {
    return $`git -C ${this.path} show ${hash}:${filePath}`.text();
  }
}
