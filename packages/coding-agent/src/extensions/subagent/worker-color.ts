// Gives each worker of a team a stable color so it reads the same wherever it is listed.
import type { Theme } from "../../modes/interactive/theme/theme.ts";
import type { ThemeColor } from "../../modes/interactive/theme/theme-tokens.ts";
import type { WorkerView } from "./team.ts";

/**
 * Foreground tokens with distinct hues in the dark and light themes (blue, orange, green, violet,
 * cyan, yellow), ordered so neighbors differ most. None carries a status meaning (success, error,
 * warning), so a worker's color never reads as its state.
 */
export const workerPalette = [
	"syntaxKeyword",
	"syntaxString",
	"syntaxNumber",
	"syntaxType",
	"syntaxVariable",
	"syntaxFunction",
] as const satisfies readonly ThemeColor[];

/** The color of the worker spawned at `spawnIndex` (0-based), cycling when workers outnumber colors. */
export function workerColorAt(spawnIndex: number): ThemeColor {
	return workerPalette[spawnIndex % workerPalette.length];
}

/** A worker's name in bold and in its color. */
export function renderWorkerName(worker: Pick<WorkerView, "name" | "color">, theme: Theme): string {
	return theme.fg(worker.color, theme.bold(worker.name));
}
