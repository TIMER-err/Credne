import { describe, expect, it } from "vitest";
import { buildBetaHeader, buildClaudeSubscriptionHeaders } from "../src/api/claude-subscription/headers.ts";

const token = "sk-ant-oat-test";
const betas = ["claude-code-20250219", "oauth-2025-04-20"];

describe("buildClaudeSubscriptionHeaders", () => {
	it("writes the record in Claude Code's order and casing", () => {
		const headers = buildClaudeSubscriptionHeaders({
			token,
			betas,
			sessionId: "session-1",
			callerHeaders: { "x-custom": "kept" },
		});

		// The order of the keys is the order on the wire; it is part of the fingerprint.
		expect(Object.keys(headers)).toEqual([
			"x-custom",
			"Accept",
			"Content-Type",
			"User-Agent",
			"X-Claude-Code-Session-Id",
			"X-Stainless-Arch",
			"X-Stainless-Lang",
			"X-Stainless-OS",
			"X-Stainless-Package-Version",
			"X-Stainless-Retry-Count",
			"X-Stainless-Runtime",
			"X-Stainless-Runtime-Version",
			"X-Stainless-Timeout",
			"anthropic-beta",
			"anthropic-dangerous-direct-browser-access",
			"anthropic-version",
			"Authorization",
			"x-app",
			"Connection",
			"Accept-Encoding",
		]);
		expect(headers).toMatchObject({
			"x-custom": "kept",
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Claude-Code-Session-Id": "session-1",
			"X-Stainless-Lang": "js",
			"X-Stainless-Retry-Count": "0",
			"anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
			"anthropic-dangerous-direct-browser-access": "true",
			"anthropic-version": "2023-06-01",
			Authorization: `Bearer ${token}`,
			"x-app": "cli",
			Connection: "keep-alive",
			"Accept-Encoding": "gzip, deflate, br, zstd",
		});
		expect(headers["User-Agent"]).toMatch(/^claude-cli\/\d+\.\d+\.\d+ \(external, cli\)$/);
	});

	it("sends no session header and no beta header without a session id and betas", () => {
		const headers = buildClaudeSubscriptionHeaders({
			token,
			betas: [],
			sessionId: undefined,
			callerHeaders: undefined,
		});

		expect(headers).not.toHaveProperty("X-Claude-Code-Session-Id");
		expect(headers).not.toHaveProperty("anthropic-beta");
	});

	it("replaces a caller's enforced headers whatever their casing, and keeps the others", () => {
		const headers = buildClaudeSubscriptionHeaders({
			token,
			betas,
			sessionId: undefined,
			callerHeaders: {
				"X-APP": "custom-app",
				"anthropic-beta": "caller-beta",
				authorization: "Bearer caller-token",
				"x-stainless-os": "Custom",
				"Content-Type": "text/plain",
				"x-client-request-id": "caller-id",
				"X-Team": "kept",
			},
		});

		expect(headers["x-app"]).toBe("cli");
		expect(headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
		expect(headers.Authorization).toBe(`Bearer ${token}`);
		expect(headers["X-Stainless-OS"]).not.toBe("Custom");
		expect(headers["Content-Type"]).toBe("application/json");
		expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain("x-client-request-id");
		expect(Object.keys(headers).filter((name) => name.toLowerCase() === "x-app")).toEqual(["x-app"]);
		expect(headers["X-Team"]).toBe("kept");
		expect(Object.keys(headers)[0]).toBe("X-Team");
	});

	it("keeps a caller's User-Agent only when it is Claude Code's, and puts its X-Api-Key last", () => {
		const own = buildClaudeSubscriptionHeaders({
			token,
			betas,
			sessionId: undefined,
			callerHeaders: { "user-agent": "claude-cli/9.9.9 (external, cli)", "x-api-key": "caller-key" },
		});
		const foreign = buildClaudeSubscriptionHeaders({
			token,
			betas,
			sessionId: undefined,
			callerHeaders: { "user-agent": "custom-agent/1.0" },
		});

		expect(own["User-Agent"]).toBe("claude-cli/9.9.9 (external, cli)");
		expect(Object.keys(own).at(-1)).toBe("X-Api-Key");
		expect(own["X-Api-Key"]).toBe("caller-key");
		expect(foreign["User-Agent"]).toMatch(/^claude-cli\//);
		expect(foreign["User-Agent"]).not.toContain("custom-agent");
	});
});

describe("buildBetaHeader", () => {
	it("trims and deduplicates the betas, keeping their order", () => {
		expect(buildBetaHeader([" a", "b", "a ", "", "c"])).toBe("a,b,c");
		expect(buildBetaHeader([])).toBe("");
	});
});
