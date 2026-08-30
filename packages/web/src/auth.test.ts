import { describe, expect, it } from "bun:test";
import {
	checkCredentials,
	isAuthEnabled,
	isValidSession,
	isValidUrlToken,
	mintSession,
	mintUrlToken,
	parseCookies,
	readAuthConfig,
	SESSION_COOKIE,
} from "./auth.js";

describe("readAuthConfig", () => {
	it("reads and trims the env vars", () => {
		const config = readAuthConfig({
			PICAMBER_TOKEN: "  abc  ",
			PICAMBER_PASSWORD: "  secret  ",
		});
		expect(config.token).toBe("abc");
		expect(config.password).toBe("secret");
	});

	it("defaults to empty when unset", () => {
		const config = readAuthConfig({});
		expect(config.token).toBe("");
		expect(config.password).toBe("");
	});

	it("enabled when either credential is set", () => {
		expect(isAuthEnabled({ token: "x", password: "" })).toBe(true);
		expect(isAuthEnabled({ token: "", password: "x" })).toBe(true);
		expect(isAuthEnabled({ token: "", password: "" })).toBe(false);
	});
});

describe("session tokens", () => {
	it("mints a valid session and rejects unknown/undefined ids", () => {
		const id = mintSession();
		expect(id.length).toBeGreaterThan(32);
		expect(isValidSession(id)).toBe(true);
		expect(isValidSession("nope")).toBe(false);
		expect(isValidSession(undefined)).toBe(false);
	});
});

describe("url tokens", () => {
	it("mints a valid url token and rejects unknown/undefined", () => {
		const token = mintUrlToken();
		expect(token.length).toBeGreaterThan(16);
		expect(isValidUrlToken(token)).toBe(true);
		expect(isValidUrlToken("nope")).toBe(false);
		expect(isValidUrlToken(undefined)).toBe(false);
	});
});

describe("parseCookies", () => {
	it("parses a cookie header", () => {
		expect(parseCookies("a=1; b=2; c=")).toEqual({ a: "1", b: "2", c: "" });
	});
});

describe("checkCredentials", () => {
	it("open mode matches nothing (caller bypasses via isAuthEnabled)", () => {
		expect(checkCredentials({}, { token: "", password: "" })).toBe(false);
	});

	it("static token via bearer or query", () => {
		const config = { token: "tok", password: "" };
		expect(checkCredentials({ bearer: "tok" }, config)).toBe(true);
		expect(checkCredentials({ query: "tok" }, config)).toBe(true);
		expect(checkCredentials({ bearer: "wrong" }, config)).toBe(false);
	});

	it("url token via query or bearer", () => {
		const token = mintUrlToken();
		const config = { token: "", password: "pw" };
		expect(checkCredentials({ query: token }, config)).toBe(true);
		expect(checkCredentials({ bearer: token }, config)).toBe(true);
	});

	it("session cookie authenticates in password mode", () => {
		const id = mintSession();
		const config = { token: "", password: "pw" };
		expect(
			checkCredentials({ cookieHeader: `${SESSION_COOKIE}=${id}` }, config),
		).toBe(true);
		expect(
			checkCredentials({ cookieHeader: `${SESSION_COOKIE}=wrong` }, config),
		).toBe(false);
	});

	it("rejects when nothing valid is present in password mode", () => {
		expect(checkCredentials({}, { token: "", password: "pw" })).toBe(false);
	});
});
