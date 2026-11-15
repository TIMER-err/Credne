// Orders cold prefix writes and retains warm entries for their conservative provider cache lifetime.

/** Reports whether a first sender reached a provider response that made its prefix readable. */
export type ReleaseWarmup = (isWarm: boolean) => void;

interface PrefixEntry {
	state: "pending" | "warm";
	expiresAt: number;
	completed: Promise<boolean>;
	resolve: (isWarm: boolean) => void;
}

const cacheLifetimeMs = 5 * 60 * 1000;

/** Lets one sender populate each cold prefix while its siblings wait for provider readiness. */
export class PrefixWarmup {
	private readonly prefixes = new Map<string, PrefixEntry>();
	private isDisposed = false;

	/** Acquires the shared system prefix before the exact conversation prefix, when both are cold. */
	async enter(key: string, signal: AbortSignal | undefined, sharedKey?: string): Promise<ReleaseWarmup | undefined> {
		const releases: ReleaseWarmup[] = [];
		for (const prefix of new Set([sharedKey, key])) {
			if (prefix === undefined) continue;
			const release = await this.acquire(prefix, signal);
			if (release) releases.push(release);
			if (!signal?.aborted && !this.isDisposed) continue;
			for (const acquired of releases) acquired(false);
			return undefined;
		}
		if (!releases.length) return undefined;
		return (isWarm) => {
			for (const release of releases) release(isWarm);
		};
	}

	/** Unblocks all waiting senders when their owning team closes. */
	dispose(): void {
		this.isDisposed = true;
		for (const entry of this.prefixes.values()) entry.resolve(false);
		this.prefixes.clear();
	}

	private async acquire(key: string, signal: AbortSignal | undefined): Promise<ReleaseWarmup | undefined> {
		const cancelled = Promise.withResolvers<false>();
		const abort = () => cancelled.resolve(false);
		signal?.addEventListener("abort", abort, { once: true });
		try {
			while (!this.isDisposed && !signal?.aborted) {
				const entry = this.prefixes.get(key);
				if (!entry || (entry.state === "warm" && entry.expiresAt <= Date.now())) return this.lead(key);
				if (entry.state === "warm") return undefined;
				await Promise.race([entry.completed, cancelled.promise]);
			}
			return undefined;
		} finally {
			signal?.removeEventListener("abort", abort);
		}
	}

	private lead(key: string): ReleaseWarmup {
		// Expired keys are removed when new work arrives, so distinct checkpoints do not accumulate forever.
		for (const [prefix, entry] of this.prefixes) {
			if (entry.state === "warm" && entry.expiresAt <= Date.now()) this.prefixes.delete(prefix);
		}
		const completed = Promise.withResolvers<boolean>();
		const entry: PrefixEntry = {
			state: "pending",
			expiresAt: Date.now() + cacheLifetimeMs,
			completed: completed.promise,
			resolve: completed.resolve,
		};
		this.prefixes.set(key, entry);
		let isReleased = false;
		return (isWarm) => {
			if (isReleased) return;
			isReleased = true;
			if (this.prefixes.get(key) !== entry) return;
			if (isWarm) entry.state = "warm";
			else this.prefixes.delete(key);
			entry.resolve(isWarm);
		};
	}
}
