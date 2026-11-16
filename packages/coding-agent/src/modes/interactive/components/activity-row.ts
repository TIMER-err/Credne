import { Loader, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

/** Keeps a readable label on the left and metadata flush with the right edge. */
export function renderActivityRow(width: number, left: string, right: string): string {
	if (width <= 0) return "";
	left = left.replace(/[\r\n\t]/g, " ");
	right = right.replace(/[\r\n\t]/g, " ");
	if (!right || width < 24) return truncateToWidth(left, width);
	const labelWidth = Math.min(visibleWidth(left), Math.max(20, Math.floor(width / 3)));
	const metadata = truncateToWidth(right, Math.max(0, width - labelWidth - 2));
	const label = truncateToWidth(left, Math.max(0, width - visibleWidth(metadata) - 2));
	return label + " ".repeat(Math.max(2, width - visibleWidth(label) - visibleWidth(metadata))) + metadata;
}

/** Uses the standard working animation without the loader's message, padding, or blank row. */
export class ActivitySpinner extends Loader {
	override render(width: number): string[] {
		return [truncateToWidth(this.getRenderedIndicator(), width)];
	}
}
