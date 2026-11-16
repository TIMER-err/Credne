import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test, vi } from "vitest";
import { VERSION } from "../src/config.ts";
import { InMemorySettingsStorage, SettingsManager } from "../src/core/settings-manager.ts";
import { InteractiveMode } from "../src/modes/interactive/interactive-mode.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import type { LatestPiRelease } from "../src/utils/version-check.ts";

const prototype = InteractiveMode.prototype as unknown as {
	getChangelogForDisplay(this: {
		session: { state: { messages: unknown[] } };
		version: string;
		settingsManager: SettingsManager;
		reportInstallTelemetry(version: string): void;
	}): string | undefined;
	showNewVersionNotificationIfNeeded(
		this: {
			isInitialized: boolean;
			settingsManager: SettingsManager;
			showNewVersionNotification(release: LatestPiRelease): void;
		},
		release: LatestPiRelease | undefined,
	): void;
};

describe("interactive update notices", () => {
	test("shows release notes once, limited to the installed version", () => {
		const settingsManager = SettingsManager.fromStorage(new InMemorySettingsStorage());
		settingsManager.setLastChangelogVersion("1.5.1");
		const reportInstallTelemetry = vi.fn();
		const context = {
			session: { state: { messages: [] } },
			version: VERSION,
			settingsManager,
			reportInstallTelemetry,
		};

		const first = prototype.getChangelogForDisplay.call(context);
		expect(first).toContain("## [1.5.2]");
		expect(first).not.toContain("## [Unreleased]");
		expect(settingsManager.getLastChangelogVersion()).toBe(VERSION);
		expect(prototype.getChangelogForDisplay.call(context)).toBeUndefined();
		expect(reportInstallTelemetry).toHaveBeenCalledOnce();
	});

	test("does not show future release notes ahead of the installed version", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "credne-changelog-"));
		writeFileSync(
			join(packageDir, "CHANGELOG.md"),
			"# Changelog\n\n## [1.5.3]\n\nFuture\n\n## [1.5.2]\n\nInstalled\n\n## [1.5.1]\n\nOld\n",
		);
		vi.stubEnv("PI_PACKAGE_DIR", packageDir);
		try {
			const settingsManager = SettingsManager.fromStorage(new InMemorySettingsStorage());
			settingsManager.setLastChangelogVersion("1.5.1");
			const context = {
				session: { state: { messages: [] } },
				version: VERSION,
				settingsManager,
				reportInstallTelemetry: vi.fn(),
			};
			const notes = prototype.getChangelogForDisplay.call(context);
			expect(notes).toContain("Installed");
			expect(notes).not.toContain("Future");
			expect(notes).not.toContain("Old");
			expect(prototype.getChangelogForDisplay.call(context)).toBeUndefined();
		} finally {
			vi.unstubAllEnvs();
			rmSync(packageDir, { recursive: true, force: true });
		}
	});

	test("Credne 0.1.0 does not repeatedly show a copied upstream 1.5.2 changelog", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "credne-changelog-"));
		writeFileSync(
			join(packageDir, "CHANGELOG.md"),
			"# Changelog\n\n## [Unreleased]\n\nFuture\n\n## [1.5.2]\n\nUpstream release\n",
		);
		vi.stubEnv("PI_PACKAGE_DIR", packageDir);
		try {
			const settingsManager = SettingsManager.fromStorage(new InMemorySettingsStorage());
			settingsManager.setLastChangelogVersion("0.0.9");
			const reportInstallTelemetry = vi.fn();
			const context = {
				session: { state: { messages: [] } },
				version: "0.1.0",
				settingsManager,
				reportInstallTelemetry,
			};
			expect(prototype.getChangelogForDisplay.call(context)).toBeUndefined();
			expect(settingsManager.getLastChangelogVersion()).toBe("0.1.0");
			expect(prototype.getChangelogForDisplay.call(context)).toBeUndefined();
			expect(reportInstallTelemetry).not.toHaveBeenCalled();
		} finally {
			vi.unstubAllEnvs();
			rmSync(packageDir, { recursive: true, force: true });
		}
	});

	test("acknowledges the installed version when there are no matching notes", () => {
		const settingsManager = SettingsManager.fromStorage(new InMemorySettingsStorage());
		settingsManager.setLastChangelogVersion(`${VERSION}-rc.1`);
		const context = {
			session: { state: { messages: [] } },
			version: VERSION,
			settingsManager,
			reportInstallTelemetry: vi.fn(),
		};

		expect(prototype.getChangelogForDisplay.call(context)).toBeUndefined();
		expect(settingsManager.getLastChangelogVersion()).toBe(VERSION);
		expect(prototype.getChangelogForDisplay.call(context)).toBeUndefined();
	});

	test("does not acknowledge an update when rendering fails", () => {
		const settingsManager = SettingsManager.fromStorage(new InMemorySettingsStorage());
		const context = {
			isInitialized: true,
			settingsManager,
			showNewVersionNotification: () => {
				throw new Error("render failed");
			},
		};
		expect(() => prototype.showNewVersionNotificationIfNeeded.call(context, { version: "1.5.3" })).toThrow(
			"render failed",
		);
		expect(settingsManager.getLastUpdateNotificationVersion()).toBeUndefined();
	});

	test("persists the notification only after a rendered notice", () => {
		const storage = new InMemorySettingsStorage();
		const settingsManager = SettingsManager.fromStorage(storage);
		initTheme("dark");
		const ui = { requestRender: vi.fn() };
		const chatContainer = new Container();
		const renderNotice = Reflect.get(InteractiveMode.prototype, "showNewVersionNotification") as (
			this: { chatContainer: Container; ui: typeof ui },
			release: LatestPiRelease,
		) => void;
		const showNewVersionNotification = (release: LatestPiRelease) =>
			renderNotice.call({ chatContainer, ui }, release);
		const context = { isInitialized: false, settingsManager, showNewVersionNotification };
		const release = { version: "1.5.3" };

		prototype.showNewVersionNotificationIfNeeded.call(context, release);
		expect(settingsManager.getLastUpdateNotificationVersion()).toBeUndefined();
		context.isInitialized = true;
		prototype.showNewVersionNotificationIfNeeded.call(context, release);
		expect(ui.requestRender).toHaveBeenCalledOnce();
		expect(chatContainer.children.length).toBeGreaterThan(0);
		expect(settingsManager.getLastUpdateNotificationVersion()).toBe(release.version);
		const childCount = chatContainer.children.length;
		prototype.showNewVersionNotificationIfNeeded.call(context, release);
		expect(chatContainer.children).toHaveLength(childCount);
	});
});
