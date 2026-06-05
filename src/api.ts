import { SERVER, COMPETITION, DEBUG } from "./config.js";
import type { Auth } from "./auth.js";
import type { Placement, ServerResponse } from "./types.js";

const BASE = `${SERVER}/competitions/${COMPETITION}`;

/**
 * Thin REST client for the gameplay endpoints. Every call mints a fresh
 * single-use JWT (Authorization: Bearer <jwt>) and only sets a JSON
 * Content-Type when it actually sends a body — a JSON content-type on an
 * empty body makes the server try to parse it and 422s (MALFORMED_REQUEST).
 */
export class GameApi {
  constructor(private readonly auth: Auth) {}

  private async request(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<ServerResponse> {
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

    const res = await fetch(`${BASE}${path}`, init);
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

    // An illegal move or timeout ends the attempt with HTTP 200 and
    // responseType ATTEMPT_DISQUALIFIED — it is NOT a 4xx. So we do not
    // treat 200 as success blindly; the caller drives off responseType.
    // But a genuine transport/auth error (4xx/5xx without a responseType)
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

  /** GET /rules — echoes the competition id back; also a cheap auth check. */
  getRules(): Promise<ServerResponse> {
    return this.request("GET", "/rules");
  }

  /** POST /attempts — NO body. Starts an attempt; first move is PLACE_SHIPS. */
  createAttempt(): Promise<ServerResponse> {
    return this.request("POST", "/attempts");
  }

  /** GET /attempts/current — re-read state after a crash. */
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
