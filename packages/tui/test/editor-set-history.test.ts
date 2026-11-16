// Tests replacing editor prompt history without leaking entries or discarding a draft.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Editor } from "../src/components/editor.ts";
import { TuiMainScreen } from "../src/tui-main-screen.ts";
import { defaultEditorTheme } from "./test-themes.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

describe("Editor.setHistory", () => {
	it("replaces previous project's entries and restores the unsent draft on Down", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.setHistory(["project A"]);
		editor.setHistory(["  first  ", "first", "second", "  "]);
		editor.setText("draft");
		editor.handleInput("\x1b[A");
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "second");
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "first");
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "first");
		editor.handleInput("\x1b[B");
		editor.handleInput("\x1b[B");
		assert.equal(editor.getText(), "draft");
	});

	it("resets active navigation while retaining a draft and caps entries at 100", () => {
		const editor = new Editor(new TuiMainScreen(new VirtualTerminal()), defaultEditorTheme);
		editor.setHistory(["old"]);
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "old");
		editor.setHistory(Array.from({ length: 105 }, (_, index) => `new ${index}`));
		assert.equal(editor.getText(), "");
		editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "new 104");
		for (let index = 0; index < 110; index++) editor.handleInput("\x1b[A");
		assert.equal(editor.getText(), "new 5");
	});
});
