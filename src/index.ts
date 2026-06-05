import { Auth } from "./auth.js";
import { GameApi } from "./api.js";
import { Brain } from "./brain.js";
import { randomFleet, validateFleet } from "./placement.js";
import { shotOutcome } from "./interpret.js";
import type { NextRequiredMove, ServerResponse } from "./types.js";
import { DEBUG } from "./config.js";

function nextMove(resp: ServerResponse): NextRequiredMove | undefined {
  return (
    resp.state?.nextRequiredMove ??
    (resp as { nextRequiredMove?: NextRequiredMove }).nextRequiredMove
  );
}

async function main(): Promise<void> {
  const auth = await Auth.init();
  const api = new GameApi(auth);

  // Cheap auth check — and the capability that 403s first if the JWT omits
  // any capability, so a clean response here proves the JWT scope is right.
  const rules = await api.getRules();
  if (DEBUG) console.log("[rules]", JSON.stringify(rules));
  console.log("Authenticated. Starting attempt (15 games)...");

  let resp = await api.createAttempt();
  let brain = new Brain();
  let lastShot: [number, number] | null = null;
  let game = 1;

  for (let guard = 0; guard < 100_000; guard++) {
    switch (resp.responseType) {
      case "ATTEMPT_COMPLETED": {
        const score = resp.result?.finalScore;
        console.log("\n=== ATTEMPT COMPLETED ===");
        console.log(
          "Final score:",
          typeof score === "object" ? JSON.stringify(score, null, 2) : score,
        );
        return;
      }

      case "ATTEMPT_DISQUALIFIED": {
        console.error("\n=== ATTEMPT DISQUALIFIED ===");
        console.error("Reason:", resp.reason ?? resp.message ?? JSON.stringify(resp));
        process.exitCode = 1;
        return;
      }

      case "GAME_COMPLETED": {
        console.log(`Game ${game} complete.`);
        game += 1;
        brain = new Brain(); // fresh board for the next opponent
        lastShot = null;
        // Continue from the embedded next response, or re-read state.
        resp = resp.next ?? (await api.getCurrent());
        continue;
      }

      case "MOVE_REQUIRED": {
        // If we were waiting on a shot result, feed it to the strategy.
        if (lastShot) {
          const outcome = shotOutcome(resp);
          if (outcome) brain.record(lastShot[0], lastShot[1], outcome);
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

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
