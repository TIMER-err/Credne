import { type Component, HStack, ScrollView, type ScrollViewScrollbar, VStack } from "@earendil-works/pi-tui";

export interface ChatViewportOptions {
	readonly document: Component;
	readonly pendingMessages: Component;
	readonly status: Component;
	readonly editor: Component;
	readonly footer: Component;
	readonly widgetsAbove?: Component;
	readonly widgetsBelow?: Component;
	readonly scrollbar?: ScrollViewScrollbar;
	readonly scrollbarTrackStyle?: (text: string) => string;
	readonly scrollbarThumbStyle?: (text: string) => string;
}

export interface ChatViewport {
	readonly root: Component;
	readonly transcript: ScrollView;
	/**
	 * Put `spacer` beside the transcript, taking its width, or remove it with undefined. The input dock below keeps
	 * the full width. Without a spacer the transcript is the first entry of the root itself, with no wrapper.
	 */
	setTranscriptSpacer(spacer: Component | undefined): void;
}

const fillEntry = { basis: 0, grow: 1, shrink: 1, minSize: 1 } as const;

/** Shared fullscreen transcript and fixed input-dock layout. */
export function createChatViewport(options: ChatViewportOptions): ChatViewport {
	const transcript = new ScrollView(options.document, {
		follow: "end",
		primary: true,
		overscroll: "chain",
		scrollbar: options.scrollbar ?? "auto",
		...(options.scrollbarTrackStyle === undefined ? {} : { scrollbarTrackStyle: options.scrollbarTrackStyle }),
		...(options.scrollbarThumbStyle === undefined ? {} : { scrollbarThumbStyle: options.scrollbarThumbStyle }),
	});
	const dock = new VStack([
		{ component: options.pendingMessages, shrink: 1, minSize: 0 },
		{ component: options.status, shrink: 1, minSize: 0 },
		...(options.widgetsAbove === undefined ? [] : [{ component: options.widgetsAbove, shrink: 1, minSize: 0 }]),
		{ component: options.editor, shrink: 1, minSize: 3 },
		...(options.widgetsBelow === undefined ? [] : [{ component: options.widgetsBelow, shrink: 1, minSize: 0 }]),
		{ component: options.footer, shrink: 1, minSize: 0 },
	]);
	const root = new VStack();
	const arrange = (transcriptRow: Component) => {
		root.clear();
		root.addChild(transcriptRow, fillEntry);
		root.addChild(dock, { basis: "auto", grow: 0, shrink: 1, minSize: 1 });
	};
	arrange(transcript);
	return {
		transcript,
		root,
		setTranscriptSpacer: (spacer) =>
			arrange(
				spacer === undefined
					? transcript
					: new HStack(
							[
								{ component: transcript, ...fillEntry },
								{ component: spacer, basis: "auto", grow: 0, shrink: 0 },
							],
							{
								align: "stretch",
							},
						),
			),
	};
}
