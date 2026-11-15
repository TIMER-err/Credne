import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from "node:fs";
import { delimiter, join } from "node:path";

/** Discovery record the broker writes to `<home>/broker.json` once it serves requests. */
export interface BrokerConnection {
	url: string;
	token: string;
	pid: number;
}

/**
 * How an account authenticates. They are not interchangeable: `oauth` uses a subscription through
 * CLIProxyAPI's client emulation, `api-credits` uses a Claude Console organization (for example the
 * monthly API credits of Max, Ultra and Team plans) through `ant`, and `api-key` uses a provider API key.
 */
export type BrokerAccountKind = "oauth" | "api-key" | "api-credits";

/** One account as the broker reports it. Never contains credentials. */
export interface BrokerAccount {
	id: string;
	/** base64url account id used in broker URLs. */
	key: string;
	/** CLIProxyAPI provider key: "claude", "claude-api", "codex", ... */
	provider: string;
	kind: BrokerAccountKind;
	source: string;
	label?: string;
	email?: string;
	plan?: string;
	status: string;
	statusMessage?: string;
	disabled: boolean;
	unavailable: boolean;
	quotaExceeded: boolean;
	quotaReason?: string;
	retryAfter?: string;
	lastError?: { code?: string; message: string; httpStatus?: number };
	modelCount: number;
}

/** A model an account or pool can serve, as reported by CLIProxyAPI's registry. */
export interface BrokerModel {
	id: string;
	displayName?: string;
	contextLength?: number;
	maxCompletionTokens?: number;
	thinking: boolean;
	thinkingLevels?: string[];
	inputModalities?: string[];
}

export interface BrokerLogin {
	state: string;
	url: string;
	flow?: string;
	userCode?: string;
}

export interface BrokerLoginStatus {
	status: "wait" | "ok" | "error";
	error?: string;
	account?: BrokerAccount;
}

/** A pinned account or a provider pool. */
export type BrokerTarget = { type: "account"; key: string } | { type: "pool"; name: string };

export class BrokerError extends Error {
	readonly status: number | undefined;

	constructor(message: string, status?: number) {
		super(message);
		this.name = "BrokerError";
		this.status = status;
	}
}

export interface BrokerClientOptions {
	/** Broker home: credentials, config and the discovery file. */
	home: string;
	/** Locates the broker executable; undefined when it is not installed. */
	locateBinary: () => string | undefined;
	/** Extra broker arguments, for example an idle timeout. */
	args?: readonly string[];
}

/** How long a successful health check is trusted before the next request checks again. */
const HEALTH_TTL_MS = 15_000;
const HEALTH_TIMEOUT_MS = 2_000;
const START_TIMEOUT_MS = 20_000;
const MAX_LOG_BYTES = 5 * 1024 * 1024;

/**
 * Client for the shared account broker. Every harness process uses the same broker; the first
 * request that finds none running starts it detached, so it outlives the process that started it.
 */
export class BrokerClient {
	readonly home: string;
	private readonly locateBinary: () => string | undefined;
	private readonly args: readonly string[];
	private connection: BrokerConnection | undefined;
	private checkedAt = 0;
	private connecting: Promise<BrokerConnection> | undefined;

	constructor(options: BrokerClientOptions) {
		this.home = options.home;
		this.locateBinary = options.locateBinary;
		this.args = options.args ?? [];
	}

	/** Connection to the running broker, starting one when none answers. */
	connect(signal?: AbortSignal): Promise<BrokerConnection> {
		if (this.connection && Date.now() - this.checkedAt < HEALTH_TTL_MS) return Promise.resolve(this.connection);
		this.connecting ??= this.establish(signal).finally(() => {
			this.connecting = undefined;
		});
		return this.connecting;
	}

	/** Connection to an already running broker; never starts one. */
	async connectExisting(signal?: AbortSignal): Promise<BrokerConnection | undefined> {
		if (this.connection && Date.now() - this.checkedAt < HEALTH_TTL_MS) return this.connection;
		const discovered = this.readDiscovery();
		if (!discovered || !(await this.healthy(discovered, signal))) return undefined;
		this.remember(discovered);
		return discovered;
	}

	/**
	 * Base URL of a target. It serves every protocol: Pi's adapters append `/v1/messages`, `/responses`
	 * or `/chat/completions`, so one pool can mix Claude and GPT models.
	 */
	routeBaseUrl(connection: BrokerConnection, target: BrokerTarget): string {
		const segment = target.type === "account" ? `a.${target.key}` : `p.${encodeURIComponent(target.name)}`;
		return `${connection.url}/credne/v1/route/${segment}`;
	}

	async listAccounts(signal?: AbortSignal): Promise<BrokerAccount[]> {
		const data = await this.request("GET", "/accounts", undefined, signal);
		return parseAccounts(field(data, "accounts"));
	}

	async accountModels(key: string, signal?: AbortSignal): Promise<BrokerModel[]> {
		return parseModels(field(await this.request("GET", `/accounts/${key}/models`, undefined, signal), "models"));
	}

	async setDisabled(key: string, disabled: boolean): Promise<void> {
		await this.request("POST", `/accounts/${key}/${disabled ? "disable" : "enable"}`);
	}

	async resetCooldown(key: string): Promise<void> {
		await this.request("POST", `/accounts/${key}/reset`);
	}

	async removeAccount(key: string): Promise<void> {
		await this.request("DELETE", `/accounts/${key}`);
	}

	/** Add an API key on its official provider route after validating its model access. */
	async addApiKey(
		name: string,
		key: string,
		provider: "claude" | "openai" = "claude",
	): Promise<BrokerAccount | undefined> {
		const account = field(await this.request("POST", "/api-keys", { provider, name, key }), "account");
		return account === undefined ? undefined : parseAccounts([account])[0];
	}

	/** Start a browser login. `name` names API-credit accounts, whose provider is `claude-api-credits`. */
	async startLogin(provider: string, name?: string, signal?: AbortSignal): Promise<BrokerLogin> {
		const data = await this.request("POST", "/logins", { provider, name }, signal);
		const state = field(data, "state");
		const url = field(data, "url");
		if (typeof state !== "string" || typeof url !== "string") throw new BrokerError("Broker returned no login URL");
		return { state, url, flow: optionalString(data, "flow"), userCode: optionalString(data, "userCode") };
	}

	async loginStatus(state: string, signal?: AbortSignal): Promise<BrokerLoginStatus> {
		const data = await this.request("GET", `/logins/${encodeURIComponent(state)}`, undefined, signal);
		const status = field(data, "status");
		const account = field(data, "account");
		return {
			status: status === "ok" || status === "error" ? status : "wait",
			error: optionalString(data, "error"),
			account: account === undefined ? undefined : parseAccounts([account])[0],
		};
	}

	async submitLoginCallback(state: string, redirectUrl: string): Promise<void> {
		await this.request("POST", `/logins/${encodeURIComponent(state)}/callback`, { redirectUrl });
	}

	async cancelLogin(state: string): Promise<void> {
		await this.request("DELETE", `/logins/${encodeURIComponent(state)}`);
	}

	/** Stop the broker for every harness process. The next request starts a new one. */
	async shutdown(): Promise<void> {
		const connection = await this.connectExisting();
		if (!connection) return;
		await fetch(`${connection.url}/credne/v1/shutdown`, {
			method: "POST",
			headers: { authorization: `Bearer ${connection.token}` },
			signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
		});
		this.connection = undefined;
	}

	private async request(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
		const connection = await this.connect(signal);
		let response: Response;
		try {
			response = await fetch(`${connection.url}/credne/v1${path}`, {
				method,
				headers: { authorization: `Bearer ${connection.token}`, "content-type": "application/json" },
				body: body === undefined ? undefined : JSON.stringify(body),
				signal,
			});
		} catch (error) {
			// The broker may have stopped (idle timeout, crash); the next call re-discovers or restarts it.
			this.connection = undefined;
			throw new BrokerError(`Account broker unreachable: ${error instanceof Error ? error.message : String(error)}`);
		}
		const text = await response.text();
		let data: unknown;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			throw new BrokerError(`Account broker returned invalid JSON (HTTP ${response.status})`, response.status);
		}
		if (!response.ok) {
			const message = optionalString(data, "error") ?? `HTTP ${response.status}`;
			throw new BrokerError(`Account broker: ${message}`, response.status);
		}
		return data;
	}

	private async establish(signal?: AbortSignal): Promise<BrokerConnection> {
		const existing = await this.connectExisting(signal);
		if (existing) return existing;
		const binary = this.locateBinary();
		if (!binary) {
			throw new BrokerError(
				"Account broker not installed. Build broker/ with Go and place credne-broker on PATH, in the pi bin directory, or set PI_ACCOUNTS_BROKER.",
			);
		}
		const stale = this.readDiscovery();
		const exited = this.spawnBroker(binary);
		const deadline = Date.now() + START_TIMEOUT_MS;
		while (Date.now() < deadline) {
			signal?.throwIfAborted();
			const exit = exited.value;
			const discovered = this.readDiscovery();
			// Exit code 0 means another broker holds the lock: its record, new or not, is the one to use.
			const current = discovered && (discovered.token !== stale?.token || exit === 0);
			if (current && (await this.healthy(discovered, signal))) {
				this.remember(discovered);
				return discovered;
			}
			if (exit !== undefined && exit !== 0) {
				throw new BrokerError(
					`Account broker failed to start (exit ${exit}). See ${join(this.home, "broker.log")}`,
				);
			}
			await sleep(100, signal);
		}
		throw new BrokerError(`Account broker did not start within ${START_TIMEOUT_MS / 1000}s`);
	}

	private spawnBroker(binary: string): { value: number | undefined } {
		mkdirSync(this.home, { recursive: true, mode: 0o700 });
		const logPath = join(this.home, "broker.log");
		// Append: a concurrent start must not truncate the log of the broker that wins the lock.
		if ((statSync(logPath, { throwIfNoEntry: false })?.size ?? 0) > MAX_LOG_BYTES) {
			renameSync(logPath, `${logPath}.1`);
		}
		const log = openSync(logPath, "a", 0o600);
		const exited: { value: number | undefined } = { value: undefined };
		try {
			const child = spawn(binary, ["--home", this.home, ...this.args], {
				detached: true,
				stdio: ["ignore", log, log],
				windowsHide: true,
			});
			child.on("error", () => {
				exited.value = -1;
			});
			child.on("exit", (code) => {
				exited.value = code ?? -1;
			});
			child.unref();
		} finally {
			closeSync(log);
		}
		return exited;
	}

	private readDiscovery(): BrokerConnection | undefined {
		let data: unknown;
		try {
			data = JSON.parse(readFileSync(join(this.home, "broker.json"), "utf8"));
		} catch {
			return undefined;
		}
		const url = field(data, "url");
		const token = field(data, "token");
		const pid = field(data, "pid");
		// Only a loopback URL may receive the broker token.
		if (typeof url !== "string" || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) return undefined;
		if (typeof token !== "string" || typeof pid !== "number") return undefined;
		return { url, token, pid };
	}

	private async healthy(connection: BrokerConnection, signal?: AbortSignal): Promise<boolean> {
		try {
			const response = await fetch(`${connection.url}/credne/v1/health`, {
				headers: { authorization: `Bearer ${connection.token}` },
				signal: signal
					? AbortSignal.any([signal, AbortSignal.timeout(HEALTH_TIMEOUT_MS)])
					: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
			});
			await response.body?.cancel();
			return response.ok;
		} catch {
			return false;
		}
	}

	private remember(connection: BrokerConnection): void {
		this.connection = connection;
		this.checkedAt = Date.now();
	}
}

/**
 * Broker executable lookup: `PI_ACCOUNTS_BROKER`, then `dirs` in order (the app's own `bin/`, then the
 * agent bin directory), then PATH.
 */
export function locateBrokerBinary(dirs: readonly string[]): string | undefined {
	const configured = process.env.PI_ACCOUNTS_BROKER;
	if (configured) return existsSync(configured) ? configured : undefined;
	const name = process.platform === "win32" ? "credne-broker.exe" : "credne-broker";
	for (const dir of [...dirs, ...(process.env.PATH ?? "").split(delimiter)]) {
		if (!dir) continue;
		const candidate = join(dir, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(signal.reason);
			},
			{ once: true },
		);
	});
}

// Broker responses are wire input: parse them field by field instead of trusting their shape.

function field(data: unknown, name: string): unknown {
	return typeof data === "object" && data !== null ? (data as Record<string, unknown>)[name] : undefined;
}

function optionalString(data: unknown, name: string): string | undefined {
	const value = field(data, name);
	return typeof value === "string" && value !== "" ? value : undefined;
}

function optionalNumber(data: unknown, name: string): number | undefined {
	const value = field(data, name);
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function optionalStrings(data: unknown, name: string): string[] | undefined {
	const value = field(data, name);
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

function parseAccounts(data: unknown): BrokerAccount[] {
	if (!Array.isArray(data)) throw new BrokerError("Broker returned an invalid account list");
	return data.flatMap((entry): BrokerAccount[] => {
		const id = optionalString(entry, "id");
		const key = optionalString(entry, "key");
		const provider = optionalString(entry, "provider");
		if (!id || !key || !provider) return [];
		const lastError = field(entry, "lastError");
		const lastErrorMessage = optionalString(lastError, "message");
		return [
			{
				id,
				key,
				provider,
				kind: parseKind(field(entry, "kind")),
				source: optionalString(entry, "source") ?? "file",
				label: optionalString(entry, "label"),
				email: optionalString(entry, "email"),
				plan: optionalString(entry, "plan"),
				status: optionalString(entry, "status") ?? "unknown",
				statusMessage: optionalString(entry, "statusMessage"),
				disabled: field(entry, "disabled") === true,
				unavailable: field(entry, "unavailable") === true,
				quotaExceeded: field(entry, "quotaExceeded") === true,
				quotaReason: optionalString(entry, "quotaReason"),
				retryAfter: optionalString(entry, "retryAfter"),
				lastError: lastErrorMessage
					? {
							code: optionalString(lastError, "code"),
							message: lastErrorMessage,
							httpStatus: optionalNumber(lastError, "httpStatus"),
						}
					: undefined,
				modelCount: optionalNumber(entry, "modelCount") ?? 0,
			},
		];
	});
}

function parseKind(value: unknown): BrokerAccountKind {
	return value === "api-key" || value === "api-credits" ? value : "oauth";
}

function parseModels(data: unknown): BrokerModel[] {
	if (!Array.isArray(data)) throw new BrokerError("Broker returned an invalid model list");
	return data.flatMap((entry): BrokerModel[] => {
		const id = optionalString(entry, "id");
		if (!id) return [];
		return [
			{
				id,
				displayName: optionalString(entry, "displayName"),
				contextLength: optionalNumber(entry, "contextLength"),
				maxCompletionTokens: optionalNumber(entry, "maxCompletionTokens"),
				thinking: field(entry, "thinking") === true,
				thinkingLevels: optionalStrings(entry, "thinkingLevels"),
				inputModalities: optionalStrings(entry, "inputModalities"),
			},
		];
	});
}
