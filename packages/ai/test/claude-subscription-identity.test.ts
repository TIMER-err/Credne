// The Claude Code identity of subscription requests: the billing block and its `cch` hash, the `cc_version`
// fingerprint, the metadata `user_id`, the session header, the device id, and the wire-only tool prefix.

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getClaudeCodeVersion } from "../src/api/claude-subscription/fingerprint.ts";
import {
	applyClaudeToolPrefix,
	buildClaudeBillingBlockText,
	CLAUDE_ACCOUNT_UUID_ENV,
	CLAUDE_DEVICE_ID_ENV,
	deriveClaudeDeviceId,
	extractClaudeMetadataSessionId,
	prepareClaudeCodeRequest,
	readClaudeMetadataAccountId,
	signClaudeCodeBody,
	stripClaudeToolPrefix,
} from "../src/api/claude-subscription/identity.ts";
import { xxHash64 } from "../src/utils/xxhash64.ts";

const textEncoder = new TextEncoder();
const cchSeed = 0x4d659218e32a3268n;
const uuidShape = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function sha256Hex(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

function patternBytes(length: number): Uint8Array {
	return Uint8Array.from({ length }, (_, index) => (index * 31 + 7) & 0xff);
}

beforeEach(() => {
	vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", undefined);
	vi.stubEnv(CLAUDE_ACCOUNT_UUID_ENV, undefined);
	vi.stubEnv(CLAUDE_DEVICE_ID_ENV, undefined);
});

afterEach(() => {
	vi.unstubAllEnvs();
});

describe("xxHash64", () => {
	// Reference outputs come from Bun.hash.xxHash64 (the native xxHash implementation) and the public XXH64 vectors.
	it.each([
		["empty input, seed 0", "", 0n, 0xef46db3751d8e999n],
		["a, seed 0", "a", 0n, 0xd24ec4f1a98c6e5bn],
		["abc, seed 0", "abc", 0n, 0x44bc2cf5ad770999n],
		["abc, seed 1", "abc", 1n, 0xbea9ca8199328908n],
		["abc, billing seed", "abc", cchSeed, 0xdfc4f4d6913699b6n],
		["26 bytes, seed 0", "abcdefghijklmnopqrstuvwxyz", 0n, 0xcfe1f278fa89835cn],
		["43 bytes (one stripe), seed 0", "The quick brown fox jumps over the lazy dog", 0n, 0x0b242d361fda71bcn],
		[
			"43 bytes (one stripe), billing seed",
			"The quick brown fox jumps over the lazy dog",
			cchSeed,
			0xa5705e22f779a6d9n,
		],
		["32 bytes, billing seed", "0123456789abcdef0123456789abcdef", cchSeed, 0x7f82b050ec994b30n],
		[
			"64 bytes (two stripes), billing seed",
			"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
			cchSeed,
			0x9c50bb5328720bbfn,
		],
		["multibyte UTF-8, billing seed", "é ünïcödé ✓ 𝄞 body", cchSeed, 0x0b8cf3328474386bn],
	])("matches the reference for %s", (_name, text, seed, expected) => {
		expect(xxHash64(textEncoder.encode(text), seed)).toBe(expected);
	});

	// Every tail path (8-byte, 4-byte and 1-byte steps) and the 32-byte stripe loop, with and without a seed.
	it.each([
		[0, 0xef46db3751d8e999n, 0xb8b30e7de65b46c5n],
		[1, 0xa96c7f0ce858bbb7n, 0x24932031b1bcb5c8n],
		[7, 0xafbefc3d6c6f9a8en, 0x14dee89e4d40a5f1n],
		[8, 0x3da5c7aa269683e0n, 0x0f7b38044deb4438n],
		[33, 0x62c9fd21ed857664n, 0x46d9ee5f93d038a8n],
		[64, 0x7bbabbc45729d17en, 0xedb37c74f00505een],
		[100, 0xefa0ad2d3e70c151n, 0x20266f6569074e66n],
		[1000, 0x99594f4828043d35n, 0x6a1baa14ca41de30n],
	])("matches the reference for a %i byte pattern", (length, unseeded, seeded) => {
		const bytes = patternBytes(length);
		expect(xxHash64(bytes)).toBe(unseeded);
		expect(xxHash64(bytes, cchSeed)).toBe(seeded);
	});

	it("hashes a view into a larger buffer by its own bytes", () => {
		const padded = new Uint8Array([...textEncoder.encode("xx"), ...patternBytes(64), ...textEncoder.encode("yy")]);
		expect(xxHash64(padded.subarray(2, 66), cchSeed)).toBe(0xedb37c74f00505een);
	});
});

describe("billing block and cch", () => {
	const billingText = buildClaudeBillingBlockText("2.1.326.abc");

	function requestBody(system: unknown[], userText = "hello"): string {
		// The SDK serializes messages before system, which the marker relies on.
		return JSON.stringify({
			model: "claude-test",
			messages: [{ role: "user", content: userText }],
			system,
			max_tokens: 10,
			stream: true,
		});
	}

	function billingBody(userText = "hello"): string {
		return requestBody(
			[
				{ type: "text", text: billingText },
				{ type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude." },
			],
			userText,
		);
	}

	function expectedCch(placeholderBody: string): string {
		return (xxHash64(textEncoder.encode(placeholderBody), cchSeed) & 0xfffffn).toString(16).padStart(5, "0");
	}

	it("writes the billing block with a placeholder cch", () => {
		expect(buildClaudeBillingBlockText("2.1.326.abc")).toBe(
			"x-anthropic-billing-header: cc_version=2.1.326.abc; cc_entrypoint=cli; cch=00000;",
		);
	});

	it("patches the placeholder with the low 20 bits of the body hash", () => {
		const placeholderBody = billingBody();
		const cch = expectedCch(placeholderBody);

		const signed = signClaudeCodeBody(placeholderBody);

		expect(cch).not.toBe("00000");
		expect(signed).toBe(placeholderBody.replace("cch=00000", `cch=${cch}`));
	});

	// Golden values: low 20 bits of Bun.hash.xxHash64(body bytes, seed), computed outside this module.
	it.each([
		["ASCII", "hello", "73c38"],
		["multibyte UTF-8", "é ünïcödé ✓ 𝄞 wide text", "45caf"],
		["a hash with leading zeros", "candidate 24", "0ac9f"],
	])("signs a %s body with the reference value", (_name, userText, cch) => {
		expect(/cch=([0-9a-f]{5});/.exec(signClaudeCodeBody(billingBody(userText)))?.[1]).toBe(cch);
	});

	it("hashes the body with the placeholder in place and replaces nothing else", () => {
		const placeholderBody = billingBody();

		const signed = signClaudeCodeBody(placeholderBody);

		expect(signed).toHaveLength(placeholderBody.length);
		expect(signed.replace(/cch=[0-9a-f]{5};/, "cch=00000;")).toBe(placeholderBody);
	});

	it("leaves a body whose system[0] is not the billing block untouched", () => {
		const body = requestBody([
			{ type: "text", text: "You are a test assistant." },
			{ type: "text", text: billingText },
		]);

		expect(signClaudeCodeBody(body)).toBe(body);
	});

	it("does not treat user text that mentions the billing header as the marker", () => {
		const body = requestBody(
			[{ type: "text", text: "plain" }],
			`x-anthropic-billing-header: ${billingText} cch=00000`,
		);

		expect(signClaudeCodeBody(body)).toBe(body);
	});

	it("leaves a billing block that has no placeholder untouched", () => {
		const body = requestBody([
			{ type: "text", text: "x-anthropic-billing-header: cc_version=2.1.326.abc; cc_entrypoint=cli; cch=abcde;" },
		]);

		expect(signClaudeCodeBody(body)).toBe(body);
	});

	it("searches for the placeholder only within 150 characters of the marker", () => {
		const inside = requestBody([{ type: "text", text: `x-anthropic-billing-header:${"x".repeat(120)} cch=00000;` }]);
		const outside = requestBody([{ type: "text", text: `x-anthropic-billing-header:${"x".repeat(400)} cch=00000;` }]);

		expect(signClaudeCodeBody(inside)).not.toBe(inside);
		expect(signClaudeCodeBody(outside)).toBe(outside);
	});
});

describe("Claude tool name prefix", () => {
	it("adds one underscore to client tool names", () => {
		expect(applyClaudeToolPrefix("read")).toBe("_read");
		expect(applyClaudeToolPrefix("my_custom_tool")).toBe("_my_custom_tool");
		expect(applyClaudeToolPrefix("_already")).toBe("__already");
	});

	it.each(["web_search", "code_execution", "text_editor", "computer"])(
		"leaves the built-in tool %s unprefixed in any case",
		(name) => {
			expect(applyClaudeToolPrefix(name)).toBe(name);
			expect(applyClaudeToolPrefix(name.toUpperCase())).toBe(name.toUpperCase());
		},
	);

	it("only exempts exact built-in names", () => {
		expect(applyClaudeToolPrefix("web_search_v2")).toBe("_web_search_v2");
		expect(applyClaudeToolPrefix("computer_use")).toBe("_computer_use");
	});

	it("strips exactly one prefix and leaves other names alone", () => {
		expect(stripClaudeToolPrefix("_read")).toBe("read");
		expect(stripClaudeToolPrefix("__already")).toBe("_already");
		expect(stripClaudeToolPrefix("read")).toBe("read");
		expect(stripClaudeToolPrefix("web_search")).toBe("web_search");
		expect(stripClaudeToolPrefix("")).toBe("");
	});

	it.each(["read", "bash", "_leading", "web_search", "computer", "COMPUTER", "x"])("round trips %s", (name) => {
		expect(stripClaudeToolPrefix(applyClaudeToolPrefix(name))).toBe(name);
	});
});

describe("device id", () => {
	it("derives a 64 hex id per installation and account, v2 with an account and v1 without", async () => {
		const noAccount = await deriveClaudeDeviceId("install-1", undefined);
		const account = await deriveClaudeDeviceId("install-1", "account-1");

		expect(noAccount).toBe(sha256Hex("omp-claude-device-id-v1:install-1"));
		expect(account).toBe(sha256Hex("omp-claude-device-id-v2\0install-1\0account-1"));
		expect(await deriveClaudeDeviceId("install-1", "account-1")).toBe(account);
		expect(await deriveClaudeDeviceId("install-2", "account-1")).not.toBe(account);
		expect(await deriveClaudeDeviceId("install-1", "account-2")).not.toBe(account);
		expect(noAccount).toMatch(/^[0-9a-f]{64}$/);
		expect(account).toMatch(/^[0-9a-f]{64}$/);
	});

	it("treats an empty account id as no account", async () => {
		expect(await deriveClaudeDeviceId("install-1", "")).toBe(await deriveClaudeDeviceId("install-1", undefined));
	});
});

describe("cc_version fingerprint", () => {
	const salt = "59cf53e54c78";

	function expectedFingerprint(firstUserText: string, version: string): string {
		const sample = [4, 7, 20].map((index) => firstUserText[index] ?? "0").join("");
		return sha256Hex(`${salt}${sample}${version}`).slice(0, 3);
	}

	it("formats the version and three hex characters", async () => {
		const identity = await prepareClaudeCodeRequest("hello world", "session", undefined);

		expect(identity.ccVersion).toMatch(
			new RegExp(`^${getClaudeCodeVersion().replaceAll(".", "\\.")}\\.[0-9a-f]{3}$`),
		);
	});

	it.each(["", "hi", "hello world, how are you today?", "     leading spaces text that is long"])(
		"derives the fingerprint of %j from characters 4, 7 and 20",
		async (text) => {
			const identity = await prepareClaudeCodeRequest(text, "session", undefined);

			expect(identity.ccVersion).toBe(
				`${getClaudeCodeVersion()}.${expectedFingerprint(text, getClaudeCodeVersion())}`,
			);
		},
	);

	it("ignores the other characters and tracks the sampled ones", async () => {
		const base = await prepareClaudeCodeRequest("abcdefghijklmnopqrstuvwxyz", "session", undefined);
		const other = await prepareClaudeCodeRequest("XbcdeYghijklmnopqrstuZwxyz-extra", "session", undefined);
		const sampled = await prepareClaudeCodeRequest("abcdXfghijklmnopqrstuvwxyz", "session", undefined);

		expect(other.ccVersion).toBe(base.ccVersion);
		expect(sampled.ccVersion).not.toBe(base.ccVersion);
	});

	it("tracks the Claude Code version", async () => {
		vi.stubEnv("PI_AI_CLAUDE_CODE_VERSION", "3.4.5");

		const identity = await prepareClaudeCodeRequest("hello world", "session", undefined);

		expect(identity.ccVersion).toBe(`3.4.5.${expectedFingerprint("hello world", "3.4.5")}`);
	});
});

describe("X-Claude-Code-Session-Id", () => {
	const metadataSession = "123e4567-e89b-42d3-a456-426614174000";
	const jsonUserId = JSON.stringify({ session_id: metadataSession, account_uuid: "acct" });
	const cloakingUserId = `user_${"ab".repeat(32)}_account_${metadataSession}_session_${metadataSession}`;

	it("is the raw session id, never reshaped", async () => {
		const identity = await prepareClaudeCodeRequest("hello", "thread-Test_1", undefined);

		expect(identity.sessionId).toBe("thread-Test_1");
	});

	it("falls back to the session of the caller's metadata user id", async () => {
		expect((await prepareClaudeCodeRequest("hello", undefined, undefined, { user_id: jsonUserId })).sessionId).toBe(
			metadataSession,
		);
		expect(
			(await prepareClaudeCodeRequest("hello", undefined, undefined, { user_id: cloakingUserId })).sessionId,
		).toBe(metadataSession);
	});

	it("falls back to the prompt cache key, and is undefined without any of them", async () => {
		expect((await prepareClaudeCodeRequest("hello", undefined, undefined, undefined, "cache-key")).sessionId).toBe(
			"cache-key",
		);
		expect(
			(await prepareClaudeCodeRequest("hello", undefined, undefined, { user_id: "opaque" }, "cache-key")).sessionId,
		).toBe("cache-key");
		expect((await prepareClaudeCodeRequest("hello", undefined, undefined)).sessionId).toBeUndefined();
	});

	it("prefers the request's session over the metadata session and the cache key", async () => {
		const identity = await prepareClaudeCodeRequest("hello", "own", undefined, { user_id: jsonUserId }, "cache-key");

		expect(identity.sessionId).toBe("own");
	});

	it("reads the session out of the two metadata shapes only", () => {
		expect(extractClaudeMetadataSessionId(jsonUserId)).toBe(metadataSession);
		expect(extractClaudeMetadataSessionId(cloakingUserId)).toBe(metadataSession);
		expect(extractClaudeMetadataSessionId(JSON.stringify({ session_id: "" }))).toBeUndefined();
		expect(extractClaudeMetadataSessionId(JSON.stringify({ account_uuid: "acct" }))).toBeUndefined();
		expect(extractClaudeMetadataSessionId("opaque")).toBeUndefined();
		expect(extractClaudeMetadataSessionId(undefined)).toBeUndefined();
		expect(extractClaudeMetadataSessionId({ session_id: "x" })).toBeUndefined();
		// Only lowercase uuids make a cloaking id.
		expect(extractClaudeMetadataSessionId(cloakingUserId.toUpperCase().replace("USER_", "user_"))).toBeUndefined();
	});
});

describe("metadata user_id", () => {
	const account = "11111111-1111-4111-8111-111111111111";
	const otherAccount = "22222222-2222-4222-8222-222222222222";
	const session = "33333333-3333-4333-8333-333333333333";

	async function userIdOf(
		callerUserId: unknown,
		env?: Record<string, string>,
		options: { sessionId?: string | null } = {},
	): Promise<string> {
		const sessionId = options.sessionId === null ? undefined : (options.sessionId ?? "request-session");
		return (await prepareClaudeCodeRequest("hello", sessionId, env, { user_id: callerUserId })).userId;
	}

	it("carries only the session when no account is known", async () => {
		const userId = await userIdOf(undefined);

		expect(JSON.parse(userId)).toEqual({ session_id: "request-session" });
		expect(userId).toBe('{"session_id":"request-session"}');
	});

	it("orders session, account and device, with the device only once the account is known", async () => {
		const userId = await userIdOf(undefined, { [CLAUDE_ACCOUNT_UUID_ENV]: account });

		expect(Object.keys(JSON.parse(userId))).toEqual(["session_id", "account_uuid", "device_id"]);
		expect(JSON.parse(userId)).toEqual({
			session_id: "request-session",
			account_uuid: account,
			device_id: sha256Hex(`omp-claude-device-id-v2\0credne\0${account}`),
		});
	});

	it("uses the stored device id over the derived one", async () => {
		const userId = await userIdOf(undefined, {
			[CLAUDE_ACCOUNT_UUID_ENV]: account,
			[CLAUDE_DEVICE_ID_ENV]: "stored",
		});

		expect(JSON.parse(userId)).toMatchObject({ account_uuid: account, device_id: "stored" });
	});

	it("uses a random uuid when there is no session id", async () => {
		const first = JSON.parse(await userIdOf(undefined, undefined, { sessionId: null })) as { session_id: string };
		const second = JSON.parse(await userIdOf(undefined, undefined, { sessionId: null })) as { session_id: string };

		expect(first.session_id).toMatch(uuidShape);
		expect(second.session_id).not.toBe(first.session_id);
	});

	it("prefers the request env over process.env and falls back to it", async () => {
		vi.stubEnv(CLAUDE_ACCOUNT_UUID_ENV, "process-account");
		vi.stubEnv(CLAUDE_DEVICE_ID_ENV, "process-device");

		expect(JSON.parse(await userIdOf(undefined))).toMatchObject({
			account_uuid: "process-account",
			device_id: "process-device",
		});
		expect(
			JSON.parse(
				await userIdOf(undefined, { [CLAUDE_ACCOUNT_UUID_ENV]: account, [CLAUDE_DEVICE_ID_ENV]: "request-device" }),
			),
		).toMatchObject({ account_uuid: account, device_id: "request-device" });
	});

	it("keeps a caller's id for the serving account verbatim, whatever its key order", async () => {
		const caller = JSON.stringify({ device_id: "d", account_uuid: account, session_id: session });

		expect(await userIdOf(caller, { [CLAUDE_ACCOUNT_UUID_ENV]: account })).toBe(caller);
	});

	it("keeps a caller's Claude Code id verbatim when no serving account is known", async () => {
		const caller = JSON.stringify({ session_id: session, account_uuid: otherAccount, device_id: "d" });

		expect(await userIdOf(caller)).toBe(caller);
	});

	it("keeps a caller's legacy cloaking id verbatim", async () => {
		const caller = `user_${"AB".repeat(32)}_account_${account}_session_${session}`;

		expect(await userIdOf(caller, { [CLAUDE_ACCOUNT_UUID_ENV]: otherAccount })).toBe(caller);
	});

	it("rebuilds a caller's id for the serving account after a rotation: device, session, account", async () => {
		const caller = JSON.stringify({ session_id: session, account_uuid: otherAccount, device_id: "other-device" });

		const userId = await userIdOf(caller, { [CLAUDE_ACCOUNT_UUID_ENV]: account, [CLAUDE_DEVICE_ID_ENV]: "device" });

		expect(Object.keys(JSON.parse(userId))).toEqual(["device_id", "session_id", "account_uuid"]);
		expect(JSON.parse(userId)).toEqual({ device_id: "device", session_id: session, account_uuid: account });
	});

	it("rebuilds a caller's id that names no account once the serving account is known", async () => {
		const caller = JSON.stringify({ session_id: session });

		const userId = await userIdOf(caller, { [CLAUDE_ACCOUNT_UUID_ENV]: account });

		expect(JSON.parse(userId)).toEqual({
			device_id: sha256Hex(`omp-claude-device-id-v2\0credne\0${account}`),
			session_id: session,
			account_uuid: account,
		});
	});

	it.each([
		["an opaque string", "opaque-user"],
		["JSON without a session", JSON.stringify({ account_uuid: "acct" })],
		["JSON with an empty session", JSON.stringify({ session_id: "" })],
		[
			"a cloaking id with an uppercase uuid",
			`user_${"ab".repeat(32)}_account_${account}_session_AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA`,
		],
		["a non-string", { user_id: "x" }],
	])("replaces %s with an id built for the request", async (_name, caller) => {
		const userId = await userIdOf(caller, { [CLAUDE_ACCOUNT_UUID_ENV]: account });

		expect(Object.keys(JSON.parse(userId))).toEqual(["session_id", "account_uuid", "device_id"]);
		expect(JSON.parse(userId).session_id).toBe("request-session");
	});
});

describe("metadata account aliases", () => {
	const account = "11111111-1111-4111-8111-111111111111";
	const otherAccount = "22222222-2222-4222-8222-222222222222";
	const session = "33333333-3333-4333-8333-333333333333";

	async function userIdOf(metadata: Record<string, unknown>, env?: Record<string, string>): Promise<unknown> {
		return JSON.parse((await prepareClaudeCodeRequest("hello", "request-session", env, metadata)).userId);
	}

	it("reads account_uuid, then accountId, then account_id", () => {
		expect(readClaudeMetadataAccountId({ account_uuid: "a", accountId: "b", account_id: "c" })).toBe("a");
		expect(readClaudeMetadataAccountId({ accountId: "b", account_id: "c" })).toBe("b");
		expect(readClaudeMetadataAccountId({ account_id: "c" })).toBe("c");
	});

	it("skips empty and non-string values, and has no account without metadata", () => {
		expect(readClaudeMetadataAccountId({ account_uuid: "", accountId: 7, account_id: "c" })).toBe("c");
		expect(readClaudeMetadataAccountId({ account_uuid: { id: "a" } })).toBeUndefined();
		expect(readClaudeMetadataAccountId({})).toBeUndefined();
		expect(readClaudeMetadataAccountId(undefined)).toBeUndefined();
	});

	it.each(["account_uuid", "accountId", "account_id"])(
		"builds the user id for the account the metadata names as %s",
		async (key) => {
			const userId = await userIdOf({ [key]: account });

			expect(userId).toEqual({
				session_id: "request-session",
				account_uuid: account,
				device_id: sha256Hex(`omp-claude-device-id-v2 credne ${account}`),
			});
		},
	);

	it("prefers the metadata account over the serving one for a user id built for the request", async () => {
		const userId = await userIdOf({ accountId: otherAccount }, { [CLAUDE_ACCOUNT_UUID_ENV]: account });

		expect(userId).toMatchObject({ account_uuid: otherAccount });
	});

	it("derives the device of another account instead of pairing it with the serving account's stored one", async () => {
		const env = { [CLAUDE_ACCOUNT_UUID_ENV]: account, [CLAUDE_DEVICE_ID_ENV]: "stored" };

		expect(await userIdOf({ accountId: otherAccount }, env)).toMatchObject({
			account_uuid: otherAccount,
			device_id: sha256Hex(`omp-claude-device-id-v2 credne ${otherAccount}`),
		});
		expect(await userIdOf({ account_id: account }, env)).toMatchObject({
			account_uuid: account,
			device_id: "stored",
		});
	});

	it("still rebinds a caller's Claude Code id to the serving account, whatever account the metadata names", async () => {
		const caller = JSON.stringify({ session_id: session, account_uuid: otherAccount, device_id: "other-device" });

		const userId = await userIdOf(
			{ user_id: caller, accountId: otherAccount },
			{ [CLAUDE_ACCOUNT_UUID_ENV]: account, [CLAUDE_DEVICE_ID_ENV]: "device" },
		);

		expect(userId).toEqual({ device_id: "device", session_id: session, account_uuid: account });
	});

	it("keeps a caller's Claude Code id verbatim when no serving account is known", async () => {
		const caller = JSON.stringify({ session_id: session, account_uuid: otherAccount, device_id: "d" });

		const identity = await prepareClaudeCodeRequest("hello", "request-session", undefined, {
			user_id: caller,
			accountId: account,
		});

		expect(identity.userId).toBe(caller);
	});
});
