import type { Outcome } from "./brain.js";
import { FLEET, type ServerResponse, type ShipClass } from "./types.js";

/**
 * The result of the shot we just fired: its outcome, plus (on a sink) the
 * length of the ship we sank, so the targeting engine can drop exactly that
 * ship from its remaining fleet.
 */
export interface ShotInfo {
  outcome: Outcome;
  sunkLength?: number;
}

const LENGTH_OF: Record<string, number> = Object.fromEntries(
  FLEET.map((f) => [f.shipClass, f.length]),
);

/**
 * Pull the outcome of the shot at `cell` out of the server's response.
 *
 * The real server reports our shots in `state.yourShots` — an array of
 * `{ row, col, outcome }` (outcome ∈ HIT | MISS | SINK), sorted by board
 * position, NOT chronologically. So we look up the cell we just fired rather
 * than taking the last element. A SINK entry also carries `sunkShipClass`,
 * which gives us the sunk ship's exact length.
 *
 * Falls back to a few defensive field guesses if `yourShots` isn't present,
 * and returns null if nothing matches (the caller then keeps hunting).
 */
export function shotOutcome(
  resp: ServerResponse,
  cell: [number, number] | null,
): ShotInfo | null {
  const shots = (resp.state as { yourShots?: unknown } | undefined)?.yourShots;
  if (cell && Array.isArray(shots)) {
    const [r, c] = cell;
    const entry = (shots as ShotEntry[]).find(
      (s) => s && s.row === r && s.col === c,
    );
    if (entry) {
      const outcome = normalize(entry.outcome);
      if (outcome) {
        const cls = entry.sunkShipClass ?? entry.shipClass;
        const sunkLength =
          outcome === "SUNK" && cls ? LENGTH_OF[cls] : undefined;
        return sunkLength !== undefined ? { outcome, sunkLength } : { outcome };
      }
    }
  }

  // Defensive fallback for older/alternate shapes.
  const direct =
    (resp.state as { shotResult?: unknown } | undefined)?.shotResult ??
    (resp as { shotResult?: unknown }).shotResult;
  if (typeof direct === "string") {
    const o = normalize(direct);
    if (o) return { outcome: o };
  }
  return null;
}

interface ShotEntry {
  row?: number;
  col?: number;
  outcome?: string;
  sunkShipClass?: ShipClass;
  shipClass?: ShipClass;
}

function normalize(s: string | undefined): Outcome | null {
  if (!s) return null;
  const up = s.toUpperCase();
  if (up.includes("SUNK") || up.includes("SINK")) return "SUNK";
  if (up.includes("HIT")) return "HIT";
  if (up.includes("MISS")) return "MISS";
  return null;
}
