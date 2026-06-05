// Static configuration for the Battleships agent.
// Values can be overridden with environment variables, but the defaults
// match the competition this agent was built for.

/** Base URL of the game server (also the Agent Auth provider). */
export const SERVER =
  process.env["BATTLESHIP_SERVER"] ??
  "https://intern-battleship-game-server.vercel.app";

/**
 * Competition content hash. Used verbatim as {comp} in every gameplay
 * path: /competitions/{comp}/...
 */
export const COMPETITION =
  process.env["BATTLESHIP_COMPETITION"] ??
  "295cccc9137b5335cc581d67d655d6fa3b41dac6610dad0e7ed201625523ad8c";

/** Where the persistent Agent Auth credentials are stored on disk. */
export const CREDENTIALS_FILE =
  process.env["BATTLESHIP_CREDENTIALS"] ?? ".agent-auth.json";

/** Where we remember the connected agentId so we never re-approve. */
export const AGENT_ID_FILE =
  process.env["BATTLESHIP_AGENT_ID"] ?? ".agent-id";

/**
 * Where the agent stores what it has learned across runs: a per-cell ship
 * heatmap (a placement prior) and the per-attempt score history. Persisting
 * this is what lets the agent improve upon itself between runs.
 */
export const MEMORY_FILE =
  process.env["BATTLESHIP_MEMORY"] ?? ".agent-memory.json";

/**
 * Where the self-tuned strategy policy lives. The Claude strategist
 * (src/improve.ts) writes proposed knob values here; the firing engine reads
 * them on the next run. This is the persisted state of the closed loop.
 */
export const POLICY_FILE =
  process.env["BATTLESHIP_POLICY"] ?? ".agent-policy.json";

/**
 * When set (and ANTHROPIC_API_KEY is present), the agent calls the Claude
 * strategist automatically after each attempt to re-tune its policy — closing
 * the play → analyse → re-tune loop in a single run.
 */
export const AUTO_IMPROVE = Boolean(process.env["AUTO_IMPROVE"]);

/**
 * Full capability list. Per the protocol the server intersects the JWT's
 * capabilities with the grants, so EVERY request must carry the full list
 * or the omitted capability returns 403 CAPABILITY_NOT_GRANTED. This bites
 * getCompetitionRules first even though it is auto-granted.
 */
export const CAPABILITIES = [
  "getCompetitionRules",
  "createAttempt",
  "getCurrentAttempt",
  "placeShips",
  "submitShot",
  "abandonAttempt",
] as const;

/** Verbose logging of raw server responses when truthy. */
export const DEBUG = Boolean(process.env["DEBUG"]);
