import { Auth } from "./auth.js";
import { GameApi } from "./api.js";
import { Brain } from "./brain.js";
import { randomFleet, validateFleet } from "./placement.js";
import { shotOutcome } from "./interpret.js";
import type { NextRequiredMove, ServerResponse } from "./types.js";
import { DEBUG, MEMORY_FILE, POLICY_FILE, AUTO_IMPROVE } from "./config.js";
import {
  loadMemory,
  saveMemory,
  learnShipCells,
  priorFromMemory,
  recordAttempt,
  progressSummary,
} from "./memory.js";
import { loadPolicy, savePolicy } from "./policy.js";

function nextMove(resp: ServerResponse): NextRequiredMove | undefined {
  return (
    resp.state?.nextRequiredMove ??
    (resp as { nextRequiredMove?: NextRequiredMove }).nextRequiredMove
  );
}

/**
 * Best-effort read of whether we won a single game from a GAME_COMPLETED
 * response. The exact field isn't documented, so we check the likely spots
 * and return null (print nothing) when unsure.
 */
function gameWon(resp: ServerResponse): boolean | null {
  const candidates: unknown[] = [
    (resp.result as { won?: unknown; outcome?: unknown; result?: unknown } | undefined)?.won,
    (resp.result as { outcome?: unknown } | undefined)?.outcome,
    (resp.result as { result?: unknown } | undefined)?.result,
    (resp.state as { outcome?: unknown } | undefined)?.outcome,
    (resp as { won?: unknown }).won,
    (resp as { outcome?: unknown }).outcome,
  ];
  for (const v of candidates) {
    if (typeof v === "boolean") return v;
    if (typeof v === "string") {
      const up = v.toUpperCase();
      if (up.includes("WIN") || up === "WON") return true;
      if (up.includes("LOSS") || up.includes("LOSE") || up.includes("LOST")) return false;
    }
  }
  return null;
}

/** Pull a numeric final score out of the (loosely-typed) result envelope. */
function numericScore(score: unknown): number | null {
  if (typeof score === "number") return score;
  if (score && typeof score === "object") {
    for (const key of ["finalScore", "score", "total", "value"]) {
      const v = (score as Record<string, unknown>)[key];
      if (typeof v === "number") return v;
    }
  }
  return null;
}

async function main(): Promise<void> {
  const auth = await Auth.init();
  const api = new GameApi(auth);

  // Cheap auth check — and the capability that 403s first if the JWT omits
  // any capability, so a clean response here proves the JWT scope is right.
  const rules = await api.getRules();
  if (DEBUG) console.log("[rules]", JSON.stringify(rules));

  // Load what we've learned so far and turn it into a firing prior.
  const memory = loadMemory(MEMORY_FILE);
  if (memory.gamesObserved > 0) {
    console.log(
      `Loaded memory: ${memory.gamesObserved} games learned, best score ${memory.bestScore}.`,
    );
  }
  const policy = loadPolicy(POLICY_FILE);
  const prior = priorFromMemory(memory, policy.lambda);
  if (DEBUG) console.log("[policy]", JSON.stringify(policy));
  console.log("Authenticated. Starting attempt (15 games)...");

  let resp = await api.createAttempt();
  let brain = new Brain(undefined, prior, undefined, policy);
  let lastShot: [number, number] | null = null;
  let game = 1;

  // Per-game instrumentation so we can see firing actually happening, and
  // whether shot results are being parsed (hits/parsed == 0 means
  // interpret.ts isn't matching the server's result shape).
  let shots = 0;
  let hits = 0;
  let parsed = 0;
  // Auto-capture the raw shape the first time a shot result fails to parse —
  // this is exactly what's needed to fix interpret.ts, no DEBUG flag required.
  let dumpedShotShape = false;

  for (let guard = 0; guard < 100_000; guard++) {
    switch (resp.responseType) {
      case "ATTEMPT_COMPLETED": {
        // The final game's completion folds into this response, so learn from
        // the board we just finished before recording the score.
        learnShipCells(memory, brain.discoveredShipCells());
        const score = resp.result?.finalScore;
        recordAttempt(memory, numericScore(score), policy);
        saveMemory(MEMORY_FILE, memory);

        console.log("\n=== ATTEMPT COMPLETED ===");
        console.log(
          "Final score:",
          typeof score === "object" ? JSON.stringify(score, null, 2) : score,
        );
        const r = resp.result as Record<string, unknown> | undefined;
        if (r && typeof r["wins"] === "number") {
          console.log(
            `Record: ${r["wins"]}W-${r["losses"]}L | opponent ships sunk ${r["opponentShipsSunk"]}, our ships lost ${r["agentShipsLost"]}, hit differential ${r["hitDifferential"]}`,
          );
        }
        console.log("\n--- learning ---");
        console.log(progressSummary(memory));

        // Close the loop: ask the Claude strategist to re-tune the policy for
        // next time. Opt-in, and degrades gracefully without an API key.
        if (AUTO_IMPROVE) await autoImprove(memory, policy);
        return;
      }

      case "ATTEMPT_DISQUALIFIED": {
        console.error("\n=== ATTEMPT DISQUALIFIED ===");
        console.error("Reason:", resp.reason ?? resp.message ?? JSON.stringify(resp));
        process.exitCode = 1;
        return;
      }

      case "GAME_COMPLETED": {
        const won = gameWon(resp);
        console.log(
          `Game ${game} complete — ${shots} shots, ${hits} hits, ${parsed} parsed` +
            (won === null ? "" : won ? ", WON" : ", lost"),
        );
        // Learn where this opponent's ships sat before resetting.
        learnShipCells(memory, brain.discoveredShipCells());
        game += 1;
        brain = new Brain(undefined, prior, undefined, policy); // fresh board, same prior+policy
        lastShot = null;
        shots = 0;
        hits = 0;
        parsed = 0;
        // Continue from the embedded next response, or re-read state.
        resp = resp.next ?? (await api.getCurrent());
        continue;
      }

      case "MOVE_REQUIRED": {
        // If we were waiting on a shot result, feed it to the strategy.
        if (lastShot) {
          const info = shotOutcome(resp, lastShot);
          if (info) {
            parsed += 1;
            if (info.outcome !== "MISS") hits += 1;
            brain.record(lastShot[0], lastShot[1], info.outcome, info.sunkLength);
          } else if (!dumpedShotShape) {
            // First unparsed result — dump the shape so interpret.ts can be fixed.
            dumpedShotShape = true;
            console.log("[unparsed shot result]", JSON.stringify(resp).slice(0, 800));
          }
          lastShot = null;
        }

        const move = nextMove(resp);
        if (move === "PLACE_SHIPS") {
          const fleet = randomFleet();
          validateFleet(fleet); // prove it's legal before sending
          console.log(`Game ${game}: placing ships...`);
          resp = await api.placeShips(fleet);
        } else {
          // SUBMIT_SHOT (default)
          const [r, c] = brain.nextShot();
          lastShot = [r, c];
          shots += 1;
          resp = await api.submitShot(r, c);
        }
        continue;
      }

      default:
        throw new Error(
          `Unexpected responseType: ${String(resp.responseType)} — ${JSON.stringify(resp).slice(0, 300)}`,
        );
    }
  }

  throw new Error("Loop guard tripped — aborting to avoid an infinite loop");
}

/**
 * Run the Claude strategist after an attempt and persist the tuned policy.
 * Imported lazily so the gameplay path has no hard dependency on the
 * Anthropic SDK or an API key.
 */
async function autoImprove(
  memory: import("./memory.js").Memory,
  current: import("./policy.js").Policy,
): Promise<void> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.log("\n(AUTO_IMPROVE set but ANTHROPIC_API_KEY is missing — skipping re-tune.)");
    return;
  }
  try {
    const { proposePolicy } = await import("./improve.js");
    console.log("\n--- strategist (re-tuning policy) ---");
    const { policy, reasoning } = await proposePolicy(memory, current);
    console.log(reasoning);
    console.log("New policy:", JSON.stringify(policy));
    savePolicy(POLICY_FILE, policy);
    console.log(`Saved to ${POLICY_FILE} — next run will use it.`);
  } catch (err) {
    console.error("Strategist failed (continuing):", err instanceof Error ? err.message : err);
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
