import { describe, expect, test } from "vitest";
import { type ChangelogEntry, getNewEntries, normalizeChangelogLinks } from "../src/utils/changelog.ts";

const entry: ChangelogEntry = {
	major: 0,
	minor: 79,
	patch: 0,
	content: "",
};

describe("normalizeChangelogLinks", () => {
	test("rewrites package-relative changelog links to tag-pinned GitHub source links", () => {
		const markdown = [
			"[Project Trust](README.md#project-trust)",
			"[Extensions](docs/extensions.md#project_trust)",
			"[Examples](examples/extensions/)",
			"[Root README](../../README.md#supply-chain-hardening)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, entry)).toBe(
			[
				"[Project Trust](https://github.com/neilhuang007/Credne/blob/v0.79.0/packages/coding-agent/README.md#project-trust)",
				"[Extensions](https://github.com/neilhuang007/Credne/blob/v0.79.0/packages/coding-agent/docs/extensions.md#project_trust)",
				"[Examples](https://github.com/neilhuang007/Credne/tree/v0.79.0/packages/coding-agent/examples/extensions/)",
				"[Root README](https://github.com/neilhuang007/Credne/blob/v0.79.0/README.md#supply-chain-hardening)",
			].join("\n"),
		);
	});

	test("pins upstream source links without changing issue and pull attribution", () => {
		const markdown = [
			"[#5167](https://github.com/earendil-works/pi-mono/pull/5167)",
			"[#4163](https://github.com/badlogic/pi-mono/issues/4163)",
			"[Upstream issue](https://github.com/earendil-works/pi/issues/123)",
			"[Upstream pull](https://github.com/earendil-works/pi/pull/456)",
			"[Agent README](https://github.com/badlogic/pi-mono/blob/main/packages/agent/README.md)",
			"[Upstream source](https://github.com/earendil-works/pi/tree/master/packages/coding-agent/examples/)",
			"[Upstream release](https://github.com/earendil-works/pi/releases/latest)",
			"[External](https://example.com/docs)",
			"[Local anchor](#settings)",
		].join("\n");

		expect(normalizeChangelogLinks(markdown, "0.79.0")).toBe(
			[
				"[#5167](https://github.com/earendil-works/pi/pull/5167)",
				"[#4163](https://github.com/earendil-works/pi/issues/4163)",
				"[Upstream issue](https://github.com/earendil-works/pi/issues/123)",
				"[Upstream pull](https://github.com/earendil-works/pi/pull/456)",
				"[Agent README](https://github.com/neilhuang007/Credne/blob/v0.79.0/packages/agent/README.md)",
				"[Upstream source](https://github.com/neilhuang007/Credne/tree/v0.79.0/packages/coding-agent/examples/)",
				"[Upstream release](https://github.com/earendil-works/pi/releases/latest)",
				"[External](https://example.com/docs)",
				"[Local anchor](#settings)",
			].join("\n"),
		);
	});
});

describe("getNewEntries", () => {
	const entries: ChangelogEntry[] = [
		{ major: 0, minor: 1, patch: 5, content: "0.1.5" },
		{ major: 0, minor: 1, patch: 4, content: "0.1.4" },
	];
	const newContent = (lastVersion: string) => getNewEntries(entries, lastVersion)?.map((e) => e.content);

	// #11703
	test("ignores prerelease and build suffixes of the last seen version", () => {
		expect(newContent("0.1.5-20261020.7")).toEqual([]);
		expect(newContent("0.1.5+build.3")).toEqual([]);
		expect(newContent("0.1.4-beta.1")).toEqual(["0.1.5"]);
	});

	test("compares release versions numerically", () => {
		expect(newContent("0.1.5")).toEqual([]);
		expect(newContent("0.1.3")).toEqual(["0.1.5", "0.1.4"]);
		expect(getNewEntries([{ major: 0, minor: 10, patch: 0, content: "0.10.0" }], "0.9.0")?.length).toBe(1);
	});

	test("bounds entries to the installed runtime release", () => {
		const entries: ChangelogEntry[] = [
			{ major: 1, minor: 5, patch: 4, content: "1.5.4" },
			{ major: 1, minor: 5, patch: 3, content: "1.5.3" },
			{ major: 1, minor: 5, patch: 2, content: "1.5.2" },
		];
		expect(getNewEntries(entries, "1.5.1", "1.5.2")?.map((entry) => entry.content)).toEqual(["1.5.2"]);
		expect(getNewEntries(entries, "1.5.2", "1.5.2")).toEqual([]);
		expect(getNewEntries(entries, "0.0.9", "0.1.0")).toEqual([]);
		expect(getNewEntries(entries, "0.1.0", "0.1.0")).toEqual([]);
	});

	test("returns undefined for a last seen version without major.minor.patch", () => {
		expect(newContent("latest")).toBeUndefined();
		expect(newContent("0.1")).toBeUndefined();
		expect(newContent("")).toBeUndefined();
	});
});
