import { Container } from "@earendil-works/pi-tui";
import { describe, expect, test } from "vitest";
import { createChatViewport } from "../src/modes/interactive/chat-viewport.ts";

function createViewport() {
	return createChatViewport({
		document: new Container(),
		pendingMessages: new Container(),
		status: new Container(),
		editor: new Container(),
		footer: new Container(),
	});
}

describe("chat viewport", () => {
	test("defaults the transcript scrollbar to auto and accepts overrides", () => {
		const automatic = createViewport();
		const hidden = createChatViewport({
			document: new Container(),
			pendingMessages: new Container(),
			status: new Container(),
			editor: new Container(),
			footer: new Container(),
			scrollbar: "hidden",
		});

		expect(automatic.transcript.scrollbar).toBe("auto");
		expect(hidden.transcript.scrollbar).toBe("hidden");
	});

	test("has the transcript itself as the first root entry, with no wrapper, until a spacer is set", () => {
		const viewport = createViewport();
		const root = viewport.root as Container;

		expect(root.children).toHaveLength(2);
		expect(root.children[0]).toBe(viewport.transcript);
	});

	test("puts a spacer beside the transcript only, keeps the dock, and restores the bare transcript", () => {
		const viewport = createViewport();
		const root = viewport.root as Container;
		const dock = root.children[1];
		const spacer = new Container();

		viewport.setTranscriptSpacer(spacer);
		const row = root.children[0] as Container;

		expect(root.children).toHaveLength(2);
		expect(row).not.toBe(viewport.transcript);
		expect(row.children).toEqual([viewport.transcript, spacer]);
		expect(root.children[1]).toBe(dock);

		viewport.setTranscriptSpacer(undefined);

		expect(root.children).toEqual([viewport.transcript, dock]);
	});
});
