/**
 * Offline self-test. Since this environment can't reach the live server,
 * we validate the agent's brain against a local simulator: random legal
 * fleets, then drive the firing strategy until every ship sinks — asserting
 * no repeated shots, no off-board shots, and a sensible shot count.
 */
import { BOARD_SIZE, FLEET } from "./types.js";
import { randomFleet, validateFleet, cellsFor } from "./placement.js";
import { Brain, type Outcome } from "./brain.js";

function buildBoard() {
  const fleet = randomFleet();
  validateFleet(fleet);
  // cell key -> ship index; ship index -> remaining cells
  const cellToShip = new Map<string, number>();
  const remaining: number[] = [];
  fleet.forEach((p, i) => {
    const spec = FLEET.find((f) => f.shipClass === p.shipClass);
    const len = spec?.length ?? 0;
    const cells = cellsFor(p, len) ?? [];
    cells.forEach(([r, c]) => cellToShip.set(`${r},${c}`, i));
    remaining[i] = len;
  });
  return { cellToShip, remaining };
}

function runGame(): number {
  const { cellToShip, remaining } = buildBoard();
  const brain = new Brain();
  const fired = new Set<string>();
  let shots = 0;
  const targetCells = FLEET.reduce((a, f) => a + f.length, 0);
  let sunkCells = 0;

  while (sunkCells < targetCells) {
    const [r, c] = brain.nextShot();
    if (r < 0 || r >= BOARD_SIZE || c < 0 || c >= BOARD_SIZE) {
      throw new Error(`Off-board shot at ${r},${c}`);
    }
    const key = `${r},${c}`;
    if (fired.has(key)) throw new Error(`Repeated shot at ${key}`);
    fired.add(key);
    shots++;

    const ship = cellToShip.get(key);
    let outcome: Outcome = "MISS";
    if (ship !== undefined) {
      const prev = remaining[ship] ?? 0;
      const next = prev - 1;
      remaining[ship] = next;
      sunkCells++;
      outcome = next === 0 ? "SUNK" : "HIT";
    }
    brain.record(r, c, outcome);

    if (shots > BOARD_SIZE * BOARD_SIZE) {
      throw new Error("Exceeded board size in shots — strategy stuck");
    }
  }
  return shots;
}

function main(): void {
  const TRIALS = 2000;
  let total = 0;
  let max = 0;
  let min = Infinity;

  for (let i = 0; i < TRIALS; i++) {
    const s = runGame();
    total += s;
    max = Math.max(max, s);
    min = Math.min(min, s);
  }

  const avg = total / TRIALS;
  console.log(`Self-test passed over ${TRIALS} simulated games.`);
  console.log(
    `Shots to clear all 17 ship cells — avg ${avg.toFixed(1)}, min ${min}, max ${max} (random hunting baseline ~95).`,
  );
  if (max > 100) throw new Error("A game exceeded 100 shots — unexpected");
  if (avg > 75) throw new Error(`Average ${avg} too high — targeting is ineffective`);
  console.log("OK: no repeats, no off-board shots, targeting works.");
}

main();
