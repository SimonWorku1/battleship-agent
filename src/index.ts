import { Auth } from "./auth.js";
import { GameApi } from "./api.js";
import { Brain } from "./brain.js";
import { chooseDispersedFleet, validateFleet } from "./placement.js";
import { shotOutcome } from "./interpret.js";
import { BOARD_SIZE, type NextRequiredMove, type ServerResponse } from "./types.js";

/** Placeholder opponent used before we've identified the real one. */
const NO_OPP: Opponent = { id: null, class: null };
import { DEBUG, MEMORY_FILE, POLICY_FILE, AUTO_IMPROVE } from "./config.js";
import {
  loadMemory,
  saveMemory,
  learnGame,
  offensePrior,
  dangerMap,
  recordAttempt,
  progressSummary,
  opponentScoreboard,
  type Opponent,
} from "./memory.js";
import { loadPolicy, savePolicy } from "./policy.js";

/** Read the current opponent's identity/class from the response state. */
function readOpponent(resp: ServerResponse): Opponent | null {
  const o = (resp.state as { opponent?: { opponentId?: unknown; opponentClass?: unknown } } | undefined)
    ?.opponent;
  if (!o) return null;
  return {
    id: typeof o.opponentId === "string" ? o.opponentId : null,
    class: typeof o.opponentClass === "string" ? o.opponentClass : null,
  };
}

/** Cells the opponent has fired at us so far (where THEY hunt). */
function incomingCells(resp: ServerResponse): [number, number][] {
  const inc = (resp.state as { incomingShots?: unknown } | undefined)?.incomingShots;
  if (!Array.isArray(inc)) return [];
  const out: [number, number][] = [];
  for (const s of inc as Array<{ row?: unknown; col?: unknown }>) {
    if (typeof s?.row === "number" && typeof s?.col === "number") out.push([s.row, s.col]);
  }
  return out;
}

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
  if (DEBUG) console.log("[policy]", JSON.stringify(policy));
  console.log("Authenticated. Starting attempt (15 games)...");

  let resp = await api.createAttempt();
  // The brain is (re)built per game once we know the opponent, so its firing
  // prior can be tailored to that specific opponent. Start with a generic one.
  let brain = new Brain(BOARD_SIZE, offensePrior(memory, NO_OPP, policy.lambda), undefined, policy);
  let lastShot: [number, number] | null = null;
  let game = 1;

  // Opponent identity + their cumulative fire at us, tracked per game.
  let opp: Opponent = NO_OPP;
  let incoming: [number, number][] = [];

  // Per-game instrumentation: confirms firing happens and results parse.
  let shots = 0;
  let hits = 0;
  let parsed = 0;
  // Auto-capture the raw shape the first time a shot result fails to parse —
  // this is exactly what's needed to fix interpret.ts, no DEBUG flag required.
  let dumpedShotShape = false;
  // Dump the GAME_COMPLETED shape once if we can't read a win/loss field, so
  // the real field can be wired into gameWon() instead of relying on inference.
  let dumpedGameShape = false;
  // Guard against double-learning the same game (GAME_COMPLETED + ATTEMPT_COMPLETED
  // can both fire for the final game when the server embeds one inside the other).
  let currentGameLearned = false;

  for (let guard = 0; guard < 100_000; guard++) {
    switch (resp.responseType) {
      case "ATTEMPT_COMPLETED": {
        // The final game's completion can fold directly into this response
        // (no preceding GAME_COMPLETED). Only learn if we haven't already.
        if (!currentGameLearned) {
          const finalInc = incomingCells(resp);
          if (finalInc.length > 0) incoming = finalInc;
          // Win/loss for this final game: prefer a server field, else infer
          // from whether we cleared the enemy's whole fleet.
          const won = gameWon(resp) ?? (brain.enemyCleared() ? true : false);
          learnGame(memory, opp, brain.discoveredShipCells(), incoming, won);
          // The final game's completion folded directly into this response (no
          // discrete GAME_COMPLETED). Print its stats so the last game is never
          // a silent gap — shots=0 here would mean it was forfeited.
          const cls = opp.class ? ` vs ${opp.class}` : "";
          console.log(
            `Game ${game} complete${cls} — ${shots} shots, ${hits} hits, ${parsed} parsed (final)` +
              (won ? ", WON" : ", lost"),
          );
          if (shots === 0) {
            console.warn(
              `WARNING: final game fired 0 shots — it was forfeited (auto-loss). Check the placement/timeout path.`,
            );
          }
        }
        const score = resp.result?.finalScore;
        const r2 = resp.result as Record<string, unknown> | undefined;
        const winsN = typeof r2?.["wins"] === "number" ? (r2["wins"] as number) : undefined;
        const lossesN = typeof r2?.["losses"] === "number" ? (r2["losses"] as number) : undefined;
        recordAttempt(memory, numericScore(score), policy, winsN, lossesN);
        saveMemory(MEMORY_FILE, memory);

        console.log("\n=== ATTEMPT COMPLETED ===");
        console.log(
          "Final score:",
          typeof score === "object" ? JSON.stringify(score, null, 2) : score,
        );
        if (r2 && typeof r2["wins"] === "number") {
          console.log(
            `Record: ${r2["wins"]}W-${r2["losses"]}L | opponent ships sunk ${r2["opponentShipsSunk"]}, our ships lost ${r2["agentShipsLost"]}, hit differential ${r2["hitDifferential"]}`,
          );
        }
        console.log("\n--- learning ---");
        console.log(progressSummary(memory));
        console.log(opponentScoreboard(memory));

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
        // Win/loss: prefer an explicit server field; if absent, infer it from
        // whether our firing engine cleared the enemy's entire fleet (a duel
        // ends when one side is fully sunk).
        const serverWon = gameWon(resp);
        if (serverWon === null && !dumpedGameShape) {
          dumpedGameShape = true;
          console.log("[game-completed shape]", JSON.stringify(resp).slice(0, 600));
        }
        const won = serverWon ?? (brain.enemyCleared() ? true : false);
        const cls = opp.class ? ` vs ${opp.class}` : "";
        console.log(
          `Game ${game} complete${cls} — ${shots} shots, ${hits} hits, ${parsed} parsed` +
            (won ? ", WON" : ", lost"),
        );
        if (!currentGameLearned) {
          // Capture any final incoming-shot state the server bundles here.
          const finalInc = incomingCells(resp);
          if (finalInc.length > 0) incoming = finalInc;
          learnGame(memory, opp, brain.discoveredShipCells(), incoming, won);
          currentGameLearned = true;
        }
        game += 1;
        lastShot = null;
        // Note: currentGameLearned is reset at PLACE_SHIPS for the next game, NOT
        // here — if resp.next is ATTEMPT_COMPLETED (final game), resetting now
        // would double-learn this same board.
        // Continue from the embedded next response, or re-read state.
        resp = resp.next ?? (await api.getCurrent());
        continue;
      }

      case "MOVE_REQUIRED": {
        // Keep opponent identity and their incoming fire up to date.
        const seen = readOpponent(resp);
        if (seen) opp = seen;
        const inc = incomingCells(resp);
        if (inc.length > 0) incoming = inc;

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
          // New game: reset per-game state and build an opponent-tailored brain.
          shots = 0;
          hits = 0;
          parsed = 0;
          incoming = [];
          currentGameLearned = false;
          brain = new Brain(
            BOARD_SIZE,
            offensePrior(memory, opp, policy.lambda), // fire at THIS opponent's likely cells first
            undefined,
            policy,
          );
          // Hide in this opponent's coldest zone (where they rarely fire).
          const fleet = chooseDispersedFleet(dangerMap(memory, opp));
          validateFleet(fleet); // prove it's legal before sending
          const cls = opp.class ? ` (${opp.class})` : "";
          console.log(`Game ${game}: placing ships${cls}...`);
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
