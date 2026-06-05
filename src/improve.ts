import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { z } from "zod";
import { BOARD_SIZE } from "./types.js";
import { MEMORY_FILE, POLICY_FILE } from "./config.js";
import { loadMemory, type Memory } from "./memory.js";
import {
  loadPolicy,
  savePolicy,
  clampPolicy,
  POLICY_BOUNDS,
  type Policy,
} from "./policy.js";

/**
 * The closed-loop strategist. Between attempts, it hands the Claude API the
 * agent's own performance record — per-attempt scores, which policy produced
 * each, and a summary of where opponents' ships have historically sat — and
 * asks for a tuned policy. The model reasons about *why* the agent is losing
 * points and proposes new knob values; we clamp them to the safe bounds in
 * policy.ts and persist them, so the next run plays with the improved policy.
 *
 * This is the genuine "improves upon itself" loop: play → analyse → re-tune →
 * play. The inner firing loop stays deterministic (an LLM call per shot would
 * risk the 10s/move timeout); the LLM operates only at the strategy layer,
 * where it runs once per attempt and latency/cost are irrelevant.
 */

const MODEL = process.env["IMPROVE_MODEL"] ?? "claude-opus-4-8";

/** The structured policy we ask Claude to return, with rationale. */
const ProposalSchema = z.object({
  reasoning: z
    .string()
    .describe("Brief explanation of what you changed and why, grounded in the data."),
  lambda: z
    .number()
    .describe(`Heatmap prior strength, ${bounds("lambda")}.`),
  targetBonus: z
    .number()
    .describe(`Weight per outstanding hit a placement covers, ${bounds("targetBonus")}.`),
  huntParityBias: z
    .number()
    .describe(`Extra weight for checkerboard cells while hunting, ${bounds("huntParityBias")}.`),
  edgeAversion: z
    .number()
    .describe(`Down-weight the board's outer ring, ${bounds("edgeAversion")}.`),
});

function bounds(key: keyof Policy): string {
  const [lo, hi] = POLICY_BOUNDS[key];
  return `in [${lo}, ${hi}]`;
}

/** A compact, model-friendly digest of what the agent has learned. */
function summarize(mem: Memory, current: Policy): string {
  const size = mem.size || BOARD_SIZE;
  const scores = mem.attempts.map((a) => a.score);
  const history = mem.attempts
    .slice(-12)
    .map((a) => {
      const p = a.policy;
      const pol = p
        ? `λ=${p.lambda} bonus=${p.targetBonus} parity=${p.huntParityBias} edge=${p.edgeAversion}`
        : "policy=unknown";
      const wr =
        typeof a.wins === "number"
          ? ` ${a.wins}W-${a.losses ?? "?"}L`
          : "";
      return `  score ${a.score}${wr}  (${pol})`;
    })
    .join("\n");

  // Heatmap geometry: edge-ring vs interior density, and parity asymmetry.
  const total = mem.heat.reduce((a, b) => a + b, 0);
  let edge = 0;
  let interior = 0;
  let even = 0;
  let odd = 0;
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const h = mem.heat[r * size + c] ?? 0;
      const onRing = r === 0 || r === size - 1 || c === 0 || c === size - 1;
      if (onRing) edge += h;
      else interior += h;
      if ((r + c) % 2 === 0) even += h;
      else odd += h;
    }
  }
  const pct = (x: number) => (total > 0 ? ((100 * x) / total).toFixed(1) + "%" : "n/a");

  const scoreLine =
    scores.length > 0
      ? `best ${mem.bestScore}, latest ${scores[scores.length - 1]}, mean ${(
          scores.reduce((a, b) => a + b, 0) / scores.length
        ).toFixed(1)} over ${scores.length} attempts`
      : "no attempts recorded yet";

  return [
    `Games learned from: ${mem.gamesObserved}. Scores: ${scoreLine}.`,
    `This is a DUEL: both agents fire simultaneously. Score is driven by wins (clearing the opponent's fleet first) and hit differential. Win = sink their 17 cells before they sink our 17 cells. Goal: win all 15 games (perfect score). We play against a fixed roster: 5 SCOUT + 10 WARSHIP agents.`,
    ``,
    `Opponent ship-cell distribution (of all ship cells seen):`,
    `  outer ring: ${pct(edge)} of cells   interior: ${pct(interior)}`,
    `  even-parity cells: ${pct(even)}   odd-parity cells: ${pct(odd)}`,
    ``,
    `Current policy: λ(prior)=${current.lambda} targetBonus=${current.targetBonus} huntParityBias=${current.huntParityBias} edgeAversion=${current.edgeAversion}`,
    ``,
    `Recent attempts (newest last):`,
    history || "  (none)",
  ].join("\n");
}

const SYSTEM = `You tune the strategy parameters of a Battleships DUEL engine. Both agents fire simultaneously — the winner is whoever clears the opponent's 17-cell fleet first. The goal is a perfect score (15W-0L). You cannot change the algorithm — only four bounded knobs:

- lambda: how strongly a learned per-cell heatmap of past opponent ship positions biases the search. Raise it if opponents cluster ships predictably; keep it low if the distribution is uniform, since a strong prior on noise hurts.
- targetBonus: how aggressively the engine extends a line once it has adjacent hits. Higher sinks ships faster once found, but very high values over-commit to a wrong orientation and waste shots.
- huntParityBias: extra weight on checkerboard (even-parity) cells while hunting. The smallest ship is length 2, so a parity pattern guarantees coverage; a mild bias speeds hunting without discarding density signal.
- edgeAversion: down-weight the board's outer ring while hunting. Only useful if opponents demonstrably avoid the edges.

This is a race: we need to clear 17 cells faster than our opponent clears ours. Fewer shots per game = more wins. Move conservatively: make small, justified adjustments based on the data. Return values within the stated bounds.`;

export async function proposePolicy(
  mem: Memory,
  current: Policy,
): Promise<{ policy: Policy; reasoning: string }> {
  const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

  const response = await client.messages.parse({
    model: MODEL,
    max_tokens: 2000,
    thinking: { type: "adaptive" },
    system: SYSTEM,
    messages: [
      {
        role: "user",
        content: `Here is the agent's performance record. Propose a tuned policy.\n\n${summarize(
          mem,
          current,
        )}`,
      },
    ],
    output_config: { format: zodOutputFormat(ProposalSchema) },
  });

  const parsed = response.parsed_output;
  if (!parsed) throw new Error("Strategist returned no structured policy");

  const policy = clampPolicy({
    lambda: parsed.lambda,
    targetBonus: parsed.targetBonus,
    huntParityBias: parsed.huntParityBias,
    edgeAversion: parsed.edgeAversion,
  });
  return { policy, reasoning: parsed.reasoning };
}

async function main(): Promise<void> {
  if (!process.env["ANTHROPIC_API_KEY"]) {
    console.error(
      "ANTHROPIC_API_KEY is not set — the Claude strategist needs it. Skipping.",
    );
    process.exitCode = 1;
    return;
  }

  const mem = loadMemory(MEMORY_FILE);
  if (mem.attempts.length === 0) {
    console.error(
      "No attempts recorded yet. Run `npm run play` at least once before improving.",
    );
    process.exitCode = 1;
    return;
  }

  const current = loadPolicy(POLICY_FILE);
  console.log(`Asking ${MODEL} to tune the strategy from ${mem.attempts.length} attempts...`);
  const { policy, reasoning } = await proposePolicy(mem, current);

  console.log("\n--- strategist ---");
  console.log(reasoning);
  console.log("\nBefore:", JSON.stringify(current));
  console.log("After: ", JSON.stringify(policy));
  savePolicy(POLICY_FILE, policy);
  console.log(`\nSaved new policy to ${POLICY_FILE}. The next \`npm run play\` will use it.`);
}

// Only run the CLI when invoked directly (not when imported by index.ts).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error("Strategist failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
