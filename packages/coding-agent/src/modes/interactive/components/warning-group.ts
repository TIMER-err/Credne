// A compact, clickable transcript group for warnings that can be expanded for details.
import { Container, MouseRegion, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { keyText } from "./keybinding-hints.ts";
import { ThemedText } from "./themed-text.ts";

/** Collapses warning details behind a count; clicking the header toggles expansion. */
export class WarningGroupComponent extends Container {
	private readonly warnings: string[] = [];
	private readonly onChange: () => void;
	private expanded = false;
	private readonly header: ThemedText;
	private readonly details: ThemedText;

	constructor(onChange: () => void, warnings: readonly string[] = []) {
		super();
		this.onChange = onChange;
		this.header = new ThemedText(
			() => {
				const action = this.expanded ? "collapse" : "expand";
				const key = keyText("app.tools.expand");
				return (
					theme.fg("warning", `Warnings (${this.warnings.length})`) +
					theme.fg("dim", ` (click${key ? ` or ${key}` : ""} to ${action})`)
				);
			},
			1,
			0,
		);
		this.details = new ThemedText(
			() => this.warnings.map((warning) => theme.fg("warning", `  ${warning}`)).join("\n"),
			1,
			0,
		);
		this.addChild(
			new MouseRegion(this.header, (event): TuiMouseEventResult | undefined => {
				if (event.type !== "click" || event.button !== "left") return undefined;
				this.setExpanded(!this.expanded);
				return { handled: true };
			}),
		);
		this.warnings.push(...warnings);
	}

	/** Add a warning while preserving the group's current expansion state. */
	addWarning(warning: string): void {
		this.warnings.push(warning);
		this.header.invalidate();
		this.details.invalidate();
		if (this.expanded) this.addDetails();
		this.onChange();
	}

	/** Show or hide the warning details, including when the shared expansion key is used. */
	setExpanded(expanded: boolean): void {
		if (this.expanded === expanded) return;
		this.expanded = expanded;
		this.header.invalidate();
		if (expanded) this.addDetails();
		else this.removeChild(this.details);
		this.onChange();
	}

	private addDetails(): void {
		if (!this.children.includes(this.details)) this.addChild(this.details);
	}
}
