// Persist editor submissions independently of session transcripts, scoped to the project directory.
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import lockfile from "proper-lockfile";
import { getAgentDir } from "../config.ts";
import { canonicalizePath, getPathComparisonKey, resolvePath } from "../utils/paths.ts";

const MAX_PROMPTS = 100;

/** Per-project editor history, ordered oldest to newest. Storage failures do not interrupt the editor. */
export class PromptHistory {
	private readonly file: string;

	constructor(cwd: string, agentDir: string = getAgentDir()) {
		const key = getPathComparisonKey(canonicalizePath(resolvePath(cwd)));
		this.file = path.join(agentDir, "prompt-history", `${createHash("sha256").update(key).digest("hex")}.json`);
	}

	/** Return at most the latest 100 prompts in submission order. */
	load(): string[] {
		try {
			const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
			if (!Array.isArray(parsed) || !parsed.every((entry) => typeof entry === "string")) return [];
			return parsed.slice(-MAX_PROMPTS);
		} catch {
			return [];
		}
	}

	/** Append a submitted prompt without overwriting prompts written by another process. */
	record(text: string): void {
		const trimmed = text.trim();
		if (!trimmed) return;
		const directory = path.dirname(this.file);
		let release: (() => void) | undefined;
		try {
			fs.mkdirSync(directory, { recursive: true });
			for (let attempt = 0; attempt < 8; attempt++) {
				try {
					release = lockfile.lockSync(directory, { realpath: false, lockfilePath: `${this.file}.lock` });
					break;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || attempt === 7) throw error;
					Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
				}
			}
			const history = this.load();
			if (history.at(-1) === trimmed) return;
			history.push(trimmed);
			const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
			try {
				fs.writeFileSync(temporary, JSON.stringify(history.slice(-MAX_PROMPTS)), { mode: 0o600 });
				fs.renameSync(temporary, this.file);
			} finally {
				fs.rmSync(temporary, { force: true });
			}
		} catch {
		} finally {
			try {
				release?.();
			} catch {}
		}
	}
}
