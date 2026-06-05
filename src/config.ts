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
