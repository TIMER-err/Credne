// Runs one git command and collects a bounded amount of its output.
import { spawn } from "node:child_process";

export type GitOutput =
	/** `isTruncated` means git was stopped after `maxBytes`, so `stdout` ends mid-line. */
	| { status: "ok"; stdout: string; isTruncated: boolean }
	| { status: "failed"; reason: "missing" | "error"; message: string }
	| { status: "aborted" };

/** Runs git with `args` in `cwd`, stopping after `maxBytes` of output or when `signal` aborts. */
export type GitRunner = (
	args: readonly string[],
	cwd: string,
	signal: AbortSignal,
	maxBytes: number,
) => Promise<GitOutput>;

export const runGit: GitRunner = (args, cwd, signal, maxBytes) =>
	new Promise((resolve) => {
		if (signal.aborted) {
			resolve({ status: "aborted" });
			return;
		}
		// The index lock is skipped so the panel never blocks the agent's own git commands.
		const child = spawn("git", ["--no-optional-locks", ...args], {
			cwd,
			windowsHide: true,
			stdio: ["ignore", "pipe", "ignore"],
		});
		const chunks: Buffer[] = [];
		let size = 0;
		let isTruncated = false;
		const stop = () => child.kill();
		signal.addEventListener("abort", stop, { once: true });

		child.stdout.on("data", (chunk: Buffer) => {
			if (isTruncated) return;
			const room = maxBytes - size;
			chunks.push(chunk.length > room ? chunk.subarray(0, room) : chunk);
			size += Math.min(chunk.length, room);
			if (chunk.length > room) {
				isTruncated = true;
				child.kill();
			}
		});
		child.once("error", (error: NodeJS.ErrnoException) => {
			signal.removeEventListener("abort", stop);
			resolve({ status: "failed", reason: error.code === "ENOENT" ? "missing" : "error", message: error.message });
		});
		child.once("close", (code) => {
			signal.removeEventListener("abort", stop);
			if (signal.aborted) resolve({ status: "aborted" });
			else if (isTruncated || code === 0) {
				resolve({ status: "ok", stdout: Buffer.concat(chunks).toString("utf8"), isTruncated });
			} else resolve({ status: "failed", reason: "error", message: `git exited with code ${code}` });
		});
	});

/** The output of a run, cut back to its last complete record when the byte cap stopped git mid-record. */
export function completeRecords(output: Extract<GitOutput, { status: "ok" }>, separator: "\0" | "\n"): string {
	if (!output.isTruncated) return output.stdout;
	return output.stdout.slice(0, output.stdout.lastIndexOf(separator) + 1);
}
