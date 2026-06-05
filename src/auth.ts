import { AgentAuthClient, type ApprovalInfo } from "@auth/agent";
import {
  SERVER,
  CAPABILITIES,
  CREDENTIALS_FILE,
  AGENT_ID_FILE,
} from "./config.js";
import { fileStorage, readText, writeText } from "./storage.js";

/**
 * Holds an authenticated, persistent Agent Auth session and mints a fresh
 * single-use JWT per request.
 */
export class Auth {
  private constructor(
    private readonly client: AgentAuthClient,
    private readonly agentId: string,
  ) {}

  /**
   * Connect (first run only) or restore (later runs) an agent, then return
   * an Auth ready to mint JWTs.
   *
   * FIRST run: no saved agentId -> connectAgent, which is the approval step.
   * A human approves ONCE at the printed verification URL. We save the
   * returned agentId and the keypair lands in the disk-backed storage.
   *
   * LATER runs: we have a saved agentId and the keypair is on disk, so we
   * SKIP connectAgent entirely and just sign JWTs offline. No re-approval.
   */
  static async init(): Promise<Auth> {
    const storage = fileStorage(CREDENTIALS_FILE);
    const client = new AgentAuthClient({
      storage,
      // The SDK ships a default directory whose presence flips
      // allowDirectDiscovery to false; we connect straight to the game
      // server's own URL, so re-enable direct .well-known discovery.
      allowDirectDiscovery: true,
      // Poll for approval up to ~5 minutes (the device-flow default).
      approvalTimeoutMs: 5 * 60_000,
      onApprovalRequired: (info: ApprovalInfo) => {
        const url = info.verification_uri_complete ?? info.verification_uri;
        console.log("\n=== ACTION REQUIRED: approve this agent ONCE ===");
        if (url) console.log(`Open: ${url}`);
        if (info.user_code) console.log(`Code: ${info.user_code}`);
        console.log(
          `Waiting for approval (expires in ~${info.expires_in}s)...\n`,
        );
      },
    });

    // Discovery is cheap and resolves the issuer URL we hand to the rest
    // of the flow. The SDK caches it so connect/sign reuse it.
    const provider = await client.discoverProvider(SERVER);
    const issuer = provider.issuer;

    const savedAgentId = readText(AGENT_ID_FILE);
    if (savedAgentId) {
      console.log(`Reusing saved agent ${savedAgentId} (no approval needed).`);
      return new Auth(client, savedAgentId);
    }

    console.log("No saved agent found — connecting for the first time.");
    // Pick a mode the server actually advertises in discovery. We want the
    // human-approve-at-a-URL flow, which is "delegated"; fall back to
    // whatever the server supports, and omit entirely if it lists none
    // (letting the SDK choose its default).
    const supported = provider.modes ?? [];
    const mode = supported.includes("delegated")
      ? "delegated"
      : supported[0];
    const { agentId } = await client.connectAgent({
      provider: issuer,
      capabilities: [...CAPABILITIES],
      name: "battleship-agent",
      ...(mode ? { mode } : {}),
      reason: "Play the Battleships competition.",
    });

    writeText(AGENT_ID_FILE, agentId);
    console.log(`Connected and approved. Saved agent ${agentId}.`);
    return new Auth(client, agentId);
  }

  /**
   * Mint a fresh, single-use JWT carrying the FULL capability list. The
   * server intersects these with the grants, so omitting any one would turn
   * into a 403 CAPABILITY_NOT_GRANTED.
   */
  async jwt(): Promise<string> {
    const { token } = await this.client.signJwt({
      agentId: this.agentId,
      capabilities: [...CAPABILITIES],
    });
    return token;
  }
}
