import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { KVStorage, type KVStore } from "@auth/agent";

/**
 * A disk-backed KVStore: a tiny JSON-file key/value store.
 *
 * The whole point (per the task): NEVER use MemoryStorage — it drops the
 * keypair on exit and forces a fresh human approval on every run. Backing
 * the SDK's KVStorage with a JSON file on disk means the agent keypair and
 * connection survive restarts, so a human approves exactly once.
 */
function jsonFileKVStore(file: string): KVStore {
  const load = (): Record<string, string> => {
    if (!existsSync(file)) return {};
    try {
      return JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    } catch {
      return {};
    }
  };
  const save = (data: Record<string, string>): void => {
    const dir = dirname(file);
    if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  };
  return {
    async get(key: string) {
      const data = load();
      return Object.prototype.hasOwnProperty.call(data, key) ? (data[key] ?? null) : null;
    },
    async set(key: string, value: string) {
      const data = load();
      data[key] = value;
      save(data);
    },
    async del(key: string) {
      const data = load();
      delete data[key];
      save(data);
    },
  };
}

/** Build the persistent SDK Storage backed by a JSON file on disk. */
export function fileStorage(file: string): KVStorage {
  return new KVStorage(jsonFileKVStore(file), { prefix: "battleship" });
}

/** Read a small text value (e.g. the saved agentId) from a file. */
export function readText(file: string): string | null {
  if (!existsSync(file)) return null;
  const v = readFileSync(file, "utf8").trim();
  return v.length > 0 ? v : null;
}

/** Persist a small text value (e.g. the agentId) to a file. */
export function writeText(file: string, value: string): void {
  const dir = dirname(file);
  if (dir && dir !== "." && !existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(file, value, { mode: 0o600 });
}
