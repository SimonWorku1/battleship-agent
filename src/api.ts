import { SERVER, COMPETITION, DEBUG } from "./config.js";
import type { Auth } from "./auth.js";
import type { Placement, ServerResponse } from "./types.js";

const BASE = `${SERVER}/competitions/${COMPETITION}`;

const RETRY_DELAYS = [2_000, 4_000, 8_000, 16_000]; // ms, for transient 5xx

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Thin REST client for the gameplay endpoints. Every call mints a fresh
 * single-use JWT (Authorization: Bearer <jwt>) and only sets a JSON
 * Content-Type when it actually sends a body — a JSON content-type on an
 * empty body makes the server try to parse it and 422s (MALFORMED_REQUEST).
 *
 * Transient 5xx errors are retried with exponential back-off (2s→4s→8s→16s)
 * before bubbling up, so a momentary server hiccup never crashes the agent.
 */
export class GameApi {
  constructor(private readonly auth: Auth) {}

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<ServerResponse> {
    let lastErr: Error | undefined;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1]!;
        console.warn(`[retry ${attempt}] ${method} ${path} — waiting ${delay / 1000}s…`);
        await sleep(delay);
      }

      const token = await this.auth.jwt();
      const headers: Record<string, string> = {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
      };
      const init: RequestInit = { method, headers };
      if (body !== undefined) {
        headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(body);
      }

      let res: Response;
      try {
        res = await fetch(`${BASE}${path}`, init);
      } catch (err) {
        // Network-level failure (DNS, TCP reset) — retry.
        lastErr = err instanceof Error ? err : new Error(String(err));
        continue;
      }

      const text = await res.text();
      let json: unknown;
      try {
        json = text ? JSON.parse(text) : {};
      } catch {
        throw new Error(
          `Non-JSON response from ${method} ${path} (HTTP ${res.status}): ${text.slice(0, 300)}`,
        );
      }

      if (DEBUG) {
        console.log(`[${method} ${path}] HTTP ${res.status}:`, JSON.stringify(json));
      }

      // 5xx = transient server error → retry
      if (res.status >= 500) {
        const detail =
          (json as { message?: string })?.message ??
          (json as { error?: string })?.error ??
          text.slice(0, 200);
        lastErr = new Error(`${method} ${path} failed: HTTP ${res.status} — ${detail}`);
        continue;
      }

      // An illegal move or timeout ends the attempt with HTTP 200 and
      // responseType ATTEMPT_DISQUALIFIED — it is NOT a 4xx. So we do not
      // treat 200 as success blindly; the caller drives off responseType.
      // But a genuine transport/auth error (4xx without a responseType)
      // should surface loudly.
      const r = json as ServerResponse;
      if (!res.ok && !r?.responseType) {
        const detail =
          (r as { message?: string })?.message ??
          (r as { error?: string })?.error ??
          text.slice(0, 300);
        throw new Error(`${method} ${path} failed: HTTP ${res.status} — ${detail}`);
      }

      return r;
    }

    throw lastErr ?? new Error(`${method} ${path} failed after retries`);
  }

  /** GET /rules — echoes the competition id back; also a cheap auth check. */
  getRules(): Promise<ServerResponse> {
    return this.request("GET", "/rules");
  }

  /**
   * POST /attempts — starts a new attempt.
   * Returns HTTP 409 if one is already active; in that case we transparently
   * resume it with GET /attempts/current so a crash never leaves the agent
   * stuck unable to play.
   */
  async createAttempt(): Promise<ServerResponse> {
    try {
      return await this.request("POST", "/attempts");
    } catch (err) {
      if (err instanceof Error && err.message.includes("HTTP 409")) {
        console.warn("Active attempt already exists — resuming it instead of creating a new one.");
        return this.getCurrent();
      }
      throw err;
    }
  }

  /** GET /attempts/current — re-read state after a crash or resume. */
  getCurrent(): Promise<ServerResponse> {
    return this.request("GET", "/attempts/current");
  }

  /** POST /attempts/current/placements — body { placements }. */
  placeShips(placements: Placement[]): Promise<ServerResponse> {
    return this.request("POST", "/attempts/current/placements", { placements });
  }

  /** POST /attempts/current/shots — body { row, col }. */
  submitShot(row: number, col: number): Promise<ServerResponse> {
    return this.request("POST", "/attempts/current/shots", { row, col });
  }

  /** POST /attempts/current/abandon — NO body. */
  abandon(): Promise<ServerResponse> {
    return this.request("POST", "/attempts/current/abandon");
  }
}
