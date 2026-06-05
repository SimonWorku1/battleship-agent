import type { Outcome } from "./brain.js";
import type { ServerResponse, ShotResultObject } from "./types.js";

/**
 * Pull the outcome (HIT / MISS / SUNK) of the shot we just fired out of the
 * server's response. The live OpenAPI is the source of truth and the exact
 * field names can vary, so we read defensively from the most likely places
 * and normalise casing. If nothing is found we return null and the caller
 * falls back to pure hunting (still legal, never repeats).
 *
 * Run with DEBUG=1 to print raw responses and confirm the real shape.
 */
export function shotOutcome(resp: ServerResponse): Outcome | null {
  // Try direct string fields first (e.g. state.shotResult == "HIT")
  const directStrings: unknown[] = [
    resp.state?.shotResult,
    resp.state?.lastShot,
    (resp as Record<string, unknown>)["shotResult"],
    (resp as Record<string, unknown>)["lastShot"],
  ];
  for (const v of directStrings) {
    if (typeof v === "string") {
      const o = outcomeFromString(v);
      if (o) return o;
    }
  }

  // Try object-shaped result fields
  const candidates: unknown[] = [
    resp.state?.lastShot,
    resp.state?.shotResult,
    (resp as Record<string, unknown>)["lastShot"],
    (resp as Record<string, unknown>)["shotResult"],
    resp.result,
  ];
  for (const c of candidates) {
    if (c && typeof c === "object") {
      const o = fromShotResultObject(c as ShotResultObject);
      if (o) return o;
    }
  }

  return null;
}

function outcomeFromString(s: string): Outcome | null {
  const up = s.toUpperCase();
  if (up.includes("SUNK") || up.includes("SINK")) return "SUNK";
  if (up.includes("HIT")) return "HIT";
  if (up.includes("MISS")) return "MISS";
  return null;
}

function fromShotResultObject(s: ShotResultObject): Outcome | null {
  if (s.sunk === true) return "SUNK";

  const label = (s.result ?? s.outcome ?? s.status)?.toString();
  if (label) {
    const o = outcomeFromString(label);
    if (o) return o;
  }

  if (s.hit === true) return "HIT";
  if (s.hit === false) return "MISS";
  return null;
}
