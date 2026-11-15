// Fake worker that exercises cache admission over real child IPC without contacting a provider.
import fs from "node:fs";
import readline from "node:readline";

const pending = new Map();
let sequence = 0;
let isAborted = false;
let scenario;

const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const record = (step, extra = {}) =>
	fs.appendFileSync(scenario.log, `${JSON.stringify({ worker: process.env.PI_SUBAGENT_WORKER_ID, step, ...extra })}\n`);

function request(body) {
	const id = String(++sequence);
	return new Promise((resolve, reject) => {
		pending.set(id, { resolve, reject });
		process.send({ type: "pi_worker_request", id, request: body });
	});
}

process.on("message", (message) => {
	if (message.type !== "pi_worker_response") return;
	if (message.success && !("data" in message)) throw new Error("Successful worker response requires data");
	const waiting = pending.get(message.id);
	pending.delete(message.id);
	if (message.success) waiting?.resolve(message.data);
	else waiting?.reject(new Error(message.error));
});

function assistant(stopReason = "stop", usage = { input: 0, cacheRead: 0, cacheWrite: 0 }) {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "fixture",
		model: "fixture-model",
		usage: {
			...usage,
			output: 1,
			totalTokens: usage.input + usage.cacheRead + usage.cacheWrite + 1,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		...(stopReason === "error" ? { errorMessage: "fixture failure" } : {}),
		timestamp: 0,
	};
}

function emitWarmUsage(tokens) {
	const usage = assistant("stop", tokens).usage;
	usage.output = tokens.output;
	usage.totalTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
	usage.cost.total = tokens.cost;
	emit({
		type: "entry_appended",
		entry: { type: "usage", id: "warm", parentId: null, timestamp: "", kind: "cache_warm", provider: "fixture", model: "fixture-model", usage },
	});
}

async function run(message) {
	scenario = JSON.parse(message);
	record("waiting", { argv: process.argv.slice(2), agentType: process.env.PI_SUBAGENT_AGENT_NAME });
	let key = scenario.key ?? "conversation";
	await request({ type: "cache_wait", key });
	if (isAborted) return;
	record("request", { key });
	// Every provider may emit this normalized start before it has sent a request or completed prefill.
	emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "start" } });
	if (scenario.retryKey) {
		const previous = key;
		key = scenario.retryKey;
		await request({ type: "cache_wait", key });
		record("retry", { key });
		await request({ type: "cache_ready", key: previous });
	}
	while (scenario.releaseFile && !fs.existsSync(scenario.releaseFile) && !isAborted)
		await new Promise((resolve) => setTimeout(resolve, 5));
	if (isAborted) return;
	if (!scenario.fail) {
		record("ready", { key });
		await request({ type: "cache_ready", key });
		emit({ type: "message_update", usage: {}, assistantMessageEvent: { type: "text_delta", delta: "d", contentIndex: 0 } });
	}
	for (const usage of scenario.warmBefore ?? []) emitWarmUsage(usage);
	for (const usage of scenario.usage ?? [undefined])
		emit({ type: "message_end", message: assistant(scenario.fail ? "error" : "stop", usage) });
	for (const usage of scenario.warmAfter ?? []) emitWarmUsage(usage);
	emit({ type: "agent_settled", aborted: false });
}

readline.createInterface({ input: process.stdin }).on("line", (line) => {
	const command = JSON.parse(line);
	const respond = (data) => emit({ type: "response", id: command.id, command: command.type, success: true, data });
	if (command.type === "prompt") {
		respond({ disposition: "started" });
		void run(command.message).catch(() => {});
		return;
	}
	if (command.type === "abort") isAborted = true;
	respond(command.type === "clear_queue" ? { steering: [], followUp: [] } : {});
});
