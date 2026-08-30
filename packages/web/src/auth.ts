/**
 * pichamber auth — password-gate session + url-token store shared by the HTTP
 * layer (index.ts) and the terminal WebSocket upgrade (terminalRoutes.ts).
 *
 * Model:
 *   - `PICAMBER_PASSWORD` drives the browser password gate (openchamber's
 *     desktop-ui-password equivalent). A correct login mints a session, stored
 *     as an HttpOnly cookie. SSE/WS transports that cannot carry headers get a
 *     short-lived url token instead (`?token=`).
 *   - `PICAMBER_TOKEN` is a static bearer for API/automation clients.
 *   - Neither set → server stays open (previous default behaviour).
 *
 * Sessions are in-memory only: a restart invalidates them (acceptable — the
 * desktop shell behaves the same way).
 */
import crypto from "node:crypto";

export interface AuthConfig {
	/** Static bearer token (PICAMBER_TOKEN) for API/automation clients. */
	token: string;
	/** UI password (PICAMBER_PASSWORD) — enables the browser password gate. */
	password: string;
}

export function readAuthConfig(env: NodeJS.ProcessEnv = process.env): AuthConfig {
	return {
		token: (env.PICAMBER_TOKEN ?? "").trim(),
		password: (env.PICAMBER_PASSWORD ?? "").trim(),
	};
}

export function isAuthEnabled(config: AuthConfig): boolean {
	return config.token !== "" || config.password !== "";
}

export const SESSION_COOKIE = "pichamber_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
export const SESSION_MAX_AGE_SECONDS = Math.floor(SESSION_TTL_MS / 1000);
export const URL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

const sessions = new Map<string, number>(); // sessionId -> expiresAt (ms)
const urlTokens = new Map<string, number>(); // urlToken -> expiresAt (ms)

function prune(map: Map<string, number>, now: number): void {
	for (const [key, expiresAt] of map) {
		if (expiresAt <= now) map.delete(key);
	}
}

/** Mint a fresh session id (the value stored in the HttpOnly cookie). */
export function mintSession(): string {
	prune(sessions, Date.now());
	const id = crypto.randomBytes(32).toString("hex");
	sessions.set(id, Date.now() + SESSION_TTL_MS);
	return id;
}

export function isValidSession(id: string | undefined): boolean {
	if (!id) return false;
	const expiresAt = sessions.get(id);
	if (expiresAt === undefined) return false;
	if (expiresAt <= Date.now()) {
		sessions.delete(id);
		return false;
	}
	return true;
}

/** Mint a short-lived url token (used as `?token=` on SSE/WS URLs). */
export function mintUrlToken(): string {
	prune(urlTokens, Date.now());
	const token = crypto.randomBytes(24).toString("hex");
	urlTokens.set(token, Date.now() + URL_TOKEN_TTL_MS);
	return token;
}

export function isValidUrlToken(token: string | undefined): boolean {
	if (!token) return false;
	const expiresAt = urlTokens.get(token);
	if (expiresAt === undefined) return false;
	if (expiresAt <= Date.now()) {
		urlTokens.delete(token);
		return false;
	}
	return true;
}

export function parseCookies(header: string): Record<string, string> {
	const out: Record<string, string> = {};
	for (const part of header.split(";")) {
		const idx = part.indexOf("=");
		if (idx === -1) continue;
		const key = part.slice(0, idx).trim();
		const value = part.slice(idx + 1).trim();
		if (key) out[key] = value;
	}
	return out;
}

export interface CredentialInput {
	/** `Authorization: Bearer <token>` value (already stripped of the prefix). */
	bearer?: string;
	/** `?token=` query value (SSE/WS transports). */
	query?: string;
	/** Raw `Cookie` header (browser session cookie). */
	cookieHeader?: string;
}

/** True when any credential (static token, url token, session cookie) is valid. */
export function checkCredentials(input: CredentialInput, config: AuthConfig): boolean {
	const bearer = input.bearer ?? "";
	const query = input.query ?? "";
	const cookieHeader = input.cookieHeader ?? "";

	// Static bearer token (API/automation).
	if (config.token && (bearer === config.token || query === config.token)) return true;

	// Minted url token.
	if (isValidUrlToken(query) || isValidUrlToken(bearer)) return true;

	// Password session cookie.
	if (config.password) {
		const session = parseCookies(cookieHeader)[SESSION_COOKIE];
		if (isValidSession(session)) return true;
	}

	return false;
}
