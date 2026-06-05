/**
 * Autoplay: keep running attempts until the agent scores a perfect game
 * (15 wins, 0 losses) — no need to invoke `npm run play` by hand each time.
 *
 * Each attempt is a fresh child process running the normal play loop, so auth,
 * memory, and policy all behave exactly as a manual run would. Between attempts
 * the opponent heatmaps in `.agent-memory.json` keep accumulating, so every
 * round is (on average) a little sharper than the last. We read that same file
 * after each child exits to learn how the attempt went and decide whether to
 * stop.
 *
 * Controls (env vars):
 *   MAX_ATTEMPTS   stop after this many attempts even if not perfect (default 50)
 *   TARGET_WINS    wins required to call it "perfect" (default 15)
 *   ATTEMPT_DELAY  seconds to wait between attempts (default 3)
 *   AUTO_IMPROVE   if set (with ANTHROPIC_API_KEY), re-tunes the policy each round
 */
import { spawn } from "node:child_process";
import { loadMemory } from "./memory.js";
import { MEMORY_FILE } from "./config.js";

const MAX_ATTEMPTS = intEnv("MAX_ATTEMPTS", 50);
const TARGET_WINS = intEnv("TARGET_WINS", 15);
const ATTEMPT_DELAY = intEnv("ATTEMPT_DELAY", 3);

function intEnv(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const sleep = (s: number): Promise<void> => new Promise((r) => setTimeout(r, s * 1000));

/** Run one attempt as a child process; resolve with its exit code. */
function playOnce(): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", "src/index.ts"], {
      stdio: "inherit",
      env: process.env,
    });
    child.on("exit", (code) => resolve(code ?? 0));
    child.on("error", () => resolve(1));
  });
}

/** The wins/losses of the most recent attempt, read from persisted memory. */
function lastResult(): { wins: number; losses: number; score: number } | null {
  const mem = loadMemory(MEMORY_FILE);
  const last = mem.attempts[mem.attempts.length - 1];
  if (!last) return null;
  return {
    wins: typeof last.wins === "number" ? last.wins : -1,
    losses: typeof last.losses === "number" ? last.losses : -1,
    score: last.score,
  };
}

async function main(): Promise<void> {
  console.log(
    `Autoplay: up to ${MAX_ATTEMPTS} attempts, stopping at ${TARGET_WINS} wins. ` +
      `${ATTEMPT_DELAY}s between rounds.\n`,
  );

  const before = loadMemory(MEMORY_FILE).attempts.length;

  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
    console.log(`\n========== AUTOPLAY ATTEMPT ${i}/${MAX_ATTEMPTS} ==========`);
    const code = await playOnce();
    if (code !== 0) {
      console.error(`Attempt ${i} exited with code ${code} — stopping autoplay.`);
      process.exitCode = code;
      return;
    }

    const res = lastResult();
    const mem = loadMemory(MEMORY_FILE);
    if (!res || mem.attempts.length <= before) {
      console.error("Could not read a recorded result for this attempt — stopping.");
      process.exitCode = 1;
      return;
    }

    console.log(
      `\nAutoplay round ${i}: ${res.wins}W-${res.losses}L (score ${res.score}) | ` +
        `best ${mem.bestScore}`,
    );

    if (res.wins >= TARGET_WINS && res.losses === 0) {
      console.log(
        `\n🏆 PERFECT SCORE — ${res.wins}W-0L (score ${res.score}) after ${i} attempt(s). Done.`,
      );
      return;
    }

    if (i < MAX_ATTEMPTS) await sleep(ATTEMPT_DELAY);
  }

  console.log(
    `\nReached MAX_ATTEMPTS (${MAX_ATTEMPTS}) without a perfect score. ` +
      `Best so far: ${loadMemory(MEMORY_FILE).bestScore}. Run again to keep trying.`,
  );
}

main().catch((err) => {
  console.error("Autoplay failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
