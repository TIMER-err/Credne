// The Claude Code wire fingerprint of subscription requests: CLI version and its override, User-Agent strings, the
// Stainless client headers, the beta profiles, and version adoption after a `claude_code_version_too_old` rejection.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	adoptRequiredClaudeCodeVersion,
	buildClaudeCodeBetas,
	buildClaudeCodeHeaders,
	CLAUDE_CODE_SDK_VERSION,
	DEFAULT_CLAUDE_CODE_VERSION,
	getClaudeCodeOAuthUserAgent,
	getClaudeCodeUserAgent,
	getClaudeCodeVersion,
	mapStainlessArch,
	mapStainlessOs,
} from "../src/api/claude-subscription/fingerprint.ts";

beforeEach(() => {
	vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("Claude Code version", () => {
	it("pins 2.1.326 with SDK 0.128.0", () => {
		expect(DEFAULT_CLAUDE_CODE_VERSION).toBe("2.1.326");
		expect(CLAUDE_CODE_SDK_VERSION).toBe("0.128.0");
	});

	it("lets PI_AI_CLAUDE_CODE_VERSION override the pinned version", () => {
		vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", "3.4.5");

		expect(getClaudeCodeVersion()).toBe("3.4.5");
		expect(getClaudeCodeUserAgent()).toBe("claude-cli/3.4.5 (external, cli)");
	});

	it("builds the CLI inference and the SDK refresh user agents", () => {
		expect(getClaudeCodeUserAgent()).toBe(`claude-cli/${getClaudeCodeVersion()} (external, cli)`);
		expect(getClaudeCodeOAuthUserAgent()).toBe("anthropic-sdk-typescript/0.128.0 userOAuthProvider");
	});
});

describe("Stainless values", () => {
	it.each([
		["darwin", "MacOS"],
		["win32", "Windows"],
		["windows", "Windows"],
		["WIN32", "Windows"],
		["linux", "Linux"],
		["freebsd", "FreeBSD"],
		["sunos", "Other::sunos"],
		["Aix", "Other::aix"],
	])("maps the platform %s to %s", (platform, expected) => {
		expect(mapStainlessOs(platform)).toBe(expected);
	});

	it.each([
		["x64", "x64"],
		["amd64", "x64"],
		["arm64", "arm64"],
		["aarch64", "arm64"],
		["ia32", "x86"],
		["x86", "x86"],
		["386", "x86"],
		["riscv64", "other::riscv64"],
		["S390X", "other::s390x"],
	])("maps the architecture %s to %s", (arch, expected) => {
		expect(mapStainlessArch(arch)).toBe(expected);
	});

	it("sends the Claude Code client headers in its order and casing", () => {
		const headers = buildClaudeCodeHeaders("session-1");

		expect(Object.keys(headers)).toEqual([
			"Accept",
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
			"anthropic-dangerous-direct-browser-access",
			"x-app",
		]);
		expect(headers).toMatchObject({
			Accept: "application/json",
			"User-Agent": getClaudeCodeUserAgent(),
			"X-Claude-Code-Session-Id": "session-1",
			"X-Stainless-Arch": mapStainlessArch(process.arch),
			"X-Stainless-Lang": "js",
			"X-Stainless-OS": mapStainlessOs(process.platform),
			"X-Stainless-Package-Version": "0.128.0",
			"X-Stainless-Retry-Count": "0",
			"X-Stainless-Runtime": "node",
			"X-Stainless-Runtime-Version": "v26.12.1",
			"X-Stainless-Timeout": "600",
			"anthropic-dangerous-direct-browser-access": "true",
			"x-app": "cli",
		});
	});

	it("sends no session header without a session id", () => {
		expect(buildClaudeCodeHeaders(undefined)).not.toHaveProperty("X-Claude-Code-Session-Id");
	});
});

describe("buildClaudeCodeBetas", () => {
	const oauth = "oauth-2025-04-20";
	const interleaved = "interleaved-thinking-2025-05-14";
	const thinkingCount = "thinking-token-count-2026-05-13";
	const contextManagement = "context-management-2025-06-27";
	const cacheScope = "prompt-caching-scope-2026-01-05";
	const structured = "structured-outputs-2025-12-15";
	const claudeCode = "claude-code-20250219";
	const effort = "effort-2025-11-24";
	const fallbackCredit = "fallback-credit-2026-06-01";

	it("gives a request without tools or thinking the utility profile", () => {
		expect(buildClaudeCodeBetas({ agentRequest: false, thinkingRequest: false })).toEqual([
			oauth,
			interleaved,
			thinkingCount,
			contextManagement,
			cacheScope,
			structured,
		]);
	});

	it("gives an agent request its profile and ends it with the fallback credit beta", () => {
		expect(buildClaudeCodeBetas({ agentRequest: true, thinkingRequest: false })).toEqual([
			claudeCode,
			oauth,
			interleaved,
			thinkingCount,
			contextManagement,
			cacheScope,
			fallbackCredit,
		]);
	});

	it("adds the effort beta before the fallback credit beta for a thinking agent request", () => {
		expect(buildClaudeCodeBetas({ agentRequest: true, thinkingRequest: true })).toEqual([
			claudeCode,
			oauth,
			interleaved,
			thinkingCount,
			contextManagement,
			cacheScope,
			effort,
			fallbackCredit,
		]);
	});

	it("never adds the effort or the fallback credit beta to a utility request", () => {
		const betas = buildClaudeCodeBetas({ agentRequest: false, thinkingRequest: true });

		expect(betas).not.toContain(effort);
		expect(betas).not.toContain(fallbackCredit);
		expect(betas).not.toContain(claudeCode);
	});

	it("leaves structured outputs out of the utility profile when strict tools are off", () => {
		const betas = buildClaudeCodeBetas({ agentRequest: false, thinkingRequest: false, disableStrictTools: true });

		expect(betas).toEqual([oauth, interleaved, thinkingCount, contextManagement, cacheScope]);
	});

	it("leaves context management out for a model without it", () => {
		for (const agentRequest of [false, true]) {
			const betas = buildClaudeCodeBetas({ agentRequest, thinkingRequest: false, supportsContextManagement: false });
			expect(betas).not.toContain(contextManagement);
			expect(betas).toContain(oauth);
		}
	});

	it("withholds the prompt-cache scope beta once the endpoint refused cache_control", () => {
		for (const agentRequest of [false, true]) {
			const betas = buildClaudeCodeBetas({ agentRequest, thinkingRequest: false, dropPromptCacheBetas: true });
			expect(betas).not.toContain(cacheScope);
			expect(betas).toContain(contextManagement);
		}
	});

	it("never advertises the 1m context beta, and sends no beta twice", () => {
		for (const agentRequest of [false, true]) {
			for (const thinkingRequest of [false, true]) {
				const betas = buildClaudeCodeBetas({ agentRequest, thinkingRequest });
				expect(betas.some((beta) => beta.startsWith("context-1m"))).toBe(false);
				expect(new Set(betas).size).toBe(betas.length);
			}
		}
	});
});

// Version adoption is process-global with no reset, so these cases run in order and come last.
describe("adoptRequiredClaudeCodeVersion", () => {
	const tooOld = (version: string) =>
		`claude_code_version_too_old: Claude Code version ${version} or newer is required to use this model`;

	it("starts from the pinned default version", () => {
		expect(getClaudeCodeVersion()).toBe(DEFAULT_CLAUDE_CODE_VERSION);
	});

	it.each([
		["an unrelated error", "Overloaded"],
		["the code without a version", "claude_code_version_too_old: upgrade"],
		["a version without the code", "Claude Code version 9.9.9 or newer is required"],
		["a malformed version", "claude_code_version_too_old: version 9.9 or newer is required"],
		["the same version", tooOld(DEFAULT_CLAUDE_CODE_VERSION)],
		["an older version", tooOld("2.0.0")],
		["an older patch version", tooOld("2.1.325")],
	])("ignores %s", (_name, message) => {
		expect(adoptRequiredClaudeCodeVersion(message, DEFAULT_CLAUDE_CODE_VERSION)).toBe(false);
		expect(getClaudeCodeVersion()).toBe(DEFAULT_CLAUDE_CODE_VERSION);
	});

	it("respects a version pinned by PI_AI_CLAUDE_CODE_VERSION", () => {
		vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", "2.1.100");

		expect(adoptRequiredClaudeCodeVersion(tooOld("9.9.9"), "2.1.100")).toBe(false);
		expect(getClaudeCodeVersion()).toBe("2.1.100");

		vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", undefined);
		expect(getClaudeCodeVersion()).toBe(DEFAULT_CLAUDE_CODE_VERSION);
	});

	it("adopts a newer required version named by an error, for the rest of the process", () => {
		expect(adoptRequiredClaudeCodeVersion(new Error(tooOld("2.1.400")), DEFAULT_CLAUDE_CODE_VERSION)).toBe(true);

		expect(getClaudeCodeVersion()).toBe("2.1.400");
		expect(getClaudeCodeUserAgent()).toBe("claude-cli/2.1.400 (external, cli)");
	});

	it("matches the message case insensitively and compares versions numerically", () => {
		expect(
			adoptRequiredClaudeCodeVersion("claude_code_version_too_old: VERSION 2.10.0 OR NEWER IS REQUIRED", "2.9.9"),
		).toBe(true);
		expect(getClaudeCodeVersion()).toBe("2.10.0");
	});

	it("does not retry again for the version the failed request already sent", () => {
		expect(adoptRequiredClaudeCodeVersion(tooOld("2.10.0"), "2.10.0")).toBe(false);
		expect(getClaudeCodeVersion()).toBe("2.10.0");
	});

	it("never moves the adopted version backwards", () => {
		// A concurrent request that sent an older version is told to retry, but keeps the newer adopted version.
		expect(adoptRequiredClaudeCodeVersion(tooOld("2.5.0"), "2.1.326")).toBe(true);
		expect(getClaudeCodeVersion()).toBe("2.10.0");
	});

	it("lets the pinned version win over an adopted one", () => {
		vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", "1.2.3");

		expect(getClaudeCodeVersion()).toBe("1.2.3");
	});
});
