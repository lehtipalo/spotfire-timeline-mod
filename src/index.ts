import { DataView, DataViewRow, DataViewHierarchyNode, DataViewColorInfo, ModProperty } from "spotfire-api";
import { select } from "d3-selection";
import { hierarchy, partition, HierarchyNode, HierarchyRectangularNode } from "d3-hierarchy";
import { scrollBarControl } from "./scrollBarControl";

export type Orientation = "horizontal" | "vertical";

interface Card {
    timePosition: number;
    verticalPosition: number;
    // Cross-axis lane pitch for this card - see cardSpacingForPeak below for how it's
    // derived. Filled in after verticalPosition is assigned.
    cardSpacing: number;
    description: string;
    color: DataViewColorInfo;
    row: DataViewRow;
    // Set by the capping pass on entries it already resolved a spacing for, so the
    // per-card spacing pass below doesn't recompute (and potentially override) it.
    fixedSpacing?: number;
}

// A same-timePosition run too dense to show individually even at the readability floor
// (see the capping pass below) keeps a real card in the frontmost lane and folds the rest
// into one of these - plain text anchored past that card's far edge, not a synthetic card
// needing its own lane. verticalPosition/cardSpacing are borrowed from that frontmost card
// so its position can be reused as-is (see calculateOverflowLabelCrossPos).
interface OverflowLabel {
    timePosition: number;
    verticalPosition: number;
    cardSpacing: number;
    count: number;
    // Borrowed from one of the folded-in cards, used only to read the shared timePosition's
    // formatted time label for this label's tooltip.
    row: DataViewRow;
}

interface Rect {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
}

/**
 * Constants
 */
const timeAxisName = "Time",
    eventAxisName = "Event",
    verticalSpaceBetweenCards = 12.5,
    horizontalSpaceBetweenCards = 12.5,
    scrollBarHeight = 16;

// stroke="currentColor" picks up #settingsButton's own `color` style via inheritance.
const settingsIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path stroke="none" d="M0 0h24v24H0z" fill="none" />
    <path d="M12 8a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
    <path d="M4 8l8 0" />
    <path d="M16 8l4 0" />
    <path d="M6 16a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
    <path d="M4 16l2 0" />
    <path d="M10 16l10 0" />
</svg>`;

/**
 * Set up drawing layers
 */
const modContainer = select("#mod-container");
const timelineScrollBar = scrollBarControl(modContainer);

let selection: Rect = { x1: 0, y1: 0, x2: 0, y2: 0 };

// Tracks the mousemove/mouseup/blur listeners of an in-progress drag selection so a
// stale drag from a previous render (with rows belonging to an already disposed
// DataView) can be cancelled when a new render arrives before the user releases the
// mouse.
let activeMouseMoveHandler: ((event: MouseEvent) => void) | null = null;
let activeMouseUpHandler: ((event: MouseEvent) => void) | null = null;
let activeBlurHandler: (() => void) | null = null;

function detachDragHandlers() {
    if (activeMouseMoveHandler) {
        document.removeEventListener("mousemove", activeMouseMoveHandler);
        activeMouseMoveHandler = null;
    }
    if (activeMouseUpHandler) {
        document.removeEventListener("mouseup", activeMouseUpHandler);
        activeMouseUpHandler = null;
    }
    if (activeBlurHandler) {
        window.removeEventListener("blur", activeBlurHandler);
        activeBlurHandler = null;
    }
}

window.Spotfire.initialize(async (mod) => {
    /**
     * Initialize render context - should show 'busy' cursor.
     * A necessary step for printing (another step is calling render complete)
     */
    const context = mod.getRenderContext();

    // The Mods API exposes only the (deliberately muted) scale-line color and the full-
    // strength font color - neither matches the lighter tint the native toolbar icons use.
    // Blending font color toward the background approximates that native chrome weight.
    const uiChromeColor = `color-mix(in srgb, ${context.styling.general.font.color} 55%, ${context.styling.general.backgroundColor})`;

    let fontSize = parseInt(context.styling.general.font.fontSize.toString()); // workaround bug in Spotfire 11.4 where fontSize returns string

    let timelineLevelHeight = fontSize * 2;
    // cardWidth/cardHeight/edgeMargin are computed per-render (see render()) - they're
    // sized in relation to timeSegmentSize, which depends on the current viewport and time
    // axis, neither of which are known this early.
    let autoScroll = false;
    let autoScrollSpeed = 5;
    // Leftmost visible time segment index, persisted across renders so scroll position
    // survives marking/window updates instead of resetting on every re-render.
    let scrollValue = 0;
    // Whether the timeline currently overflows the viewport at all, and whether the mouse
    // is over the visualization - the scrollbar only shows when both are true. Persisted
    // (rather than render-local) since hover can change independently of any render pass.
    let needsScroll = false;
    let isHovering = false;

    function updateScrollBarVisibility() {
        if (needsScroll && isHovering) {
            timelineScrollBar.show();
        } else {
            timelineScrollBar.hide();
        }
    }

    // Unlike the scrollbar, the settings button shows on any hover, regardless of overflow.
    function updateSettingsButtonVisibility() {
        modContainer
            .select("#settingsButton")
            .style("opacity", isHovering ? "1" : "0")
            .style("pointer-events", isHovering ? "auto" : "none");
    }

    modContainer.on("mouseenter", () => {
        isHovering = true;
        updateScrollBarVisibility();
        updateSettingsButtonVisibility();
    });
    modContainer.on("mouseleave", () => {
        isHovering = false;
        // Don't fade out mid-drag if the cursor slips past the mod's edge while the user
        // is still holding the handle.
        if (!timelineScrollBar.isHandleBeingDragged()) {
            updateScrollBarVisibility();
        }
        updateSettingsButtonVisibility();
    });

    // configfure styling
    document.querySelector("#extra_styling")!.innerHTML = `
    .body { fill: ${context.styling.general.font.color}; font-size: ${context.styling.general.font.fontSize}px; font-weight: ${context.styling.general.font.fontWeight}; font-style: ${context.styling.general.font.fontStyle};}
    .timeMarker {border-color: ${context.styling.scales.line.stroke}}
    .timeline {border-color: ${context.styling.scales.line.stroke}}
    .connector {background-color: ${context.styling.scales.line.stroke}}
    /* Outline ring on hover, matching the highlight native Spotfire visualizations (e.g.
       scatter plot markers, bar chart bars) show on their marks. Layered on top of the
       card's own elevation shadow (from .card in main.css) rather than replacing it. */
    .card:hover { box-shadow: 0 0 0 2px ${uiChromeColor}, 0px 2px 5px 0px rgba(0,0,0,0.12), 0px 1px 2px 0px rgba(0,0,0,0.24); }
    `;

    const reader = mod.createReader(
        mod.visualization.data(),
        mod.windowSize(),
        mod.property<string>("orientation"),
        mod.property<string>("cardAlignment")
    );

    reader.subscribe(render);

    /**
     * Clears the DOM. Leaves the scrollbar's and settings button's own DOM in place - they're
     * each created once (see scrollBarControl(modContainer) above and the settingsButton join
     * in render()) and their event handlers are bound to those specific nodes, so removing them
     * here would leave them permanently broken.
     */
    function clear() {
        modContainer
            .selectAll<HTMLElement, unknown>(":scope > *")
            .filter(function () {
                return this.id !== "scrollBar" && this.id !== "settingsButton";
            })
            .remove();
        needsScroll = false;
        timelineScrollBar.hide();
        updateSettingsButtonVisibility();
    }

    /**
     * Function used in bailout clauses in main rendering function. Optionally shows message(s)
     * to the user.
     */
    function bailout(messages?: string) {
        clear();

        if (messages) {
            mod.controls.errorOverlay.show(messages);
        } else {
            mod.controls.errorOverlay.hide();
        }
    }

    async function render(
        dataView: DataView,
        windowSize: Spotfire.Size,
        orientationProperty: ModProperty<string>,
        cardAlignmentProperty: ModProperty<string>
    ) {
        // Cancel any drag selection still in progress from a previous render - its listeners
        // close over rows/DataView from that render, which may now be disposed.
        detachDragHandlers();
        // A hovered card's mouseleave won't fire if its element is removed from the DOM
        // (a re-render can drop it if the underlying data changed) while the mouse never
        // actually left it, which would otherwise leave a stale tooltip on screen.
        mod.controls.tooltip.hide();

        const orientation: Orientation = orientationProperty.value<string>() === "vertical" ? "vertical" : "horizontal";
        const isHorizontal = orientation === "horizontal";
        // "start"/"end" refer to the cross axis's low/high edge (top/bottom in horizontal
        // mode, left/right in vertical) - orientation-agnostic, mirroring along/cross below.
        const cardAlignmentValue = cardAlignmentProperty.value<string>();
        const cardAlignment: "start" | "middle" | "end" =
            cardAlignmentValue === "start" || cardAlignmentValue === "end" ? cardAlignmentValue : "middle";
        // The axis along which the timeline runs/scrolls, and the axis across which cards
        // stack away from it - horizontal maps along->x/cross->y, vertical is the mirror.
        const mainSize = isHorizontal ? windowSize.width : windowSize.height;
        const crossSize = isHorizontal ? windowSize.height : windowSize.width;
        const alongProp: "left" | "top" = isHorizontal ? "left" : "top";
        const crossProp: "left" | "top" = isHorizontal ? "top" : "left";
        const alongSizeProp: "width" | "height" = isHorizontal ? "width" : "height";
        const crossSizeProp: "width" | "height" = isHorizontal ? "height" : "width";

        /**
         * Check the data view for errors
         */
        let errors = await dataView.getErrors();
        if (errors.length > 0) {
            // Showing an error overlay will hide the mod iframe.
            // Clear the mod content here to avoid flickering effect of
            // an old configuration when next valid data view is received.
            mod.controls.errorOverlay.show(errors);
            return;
        }
        mod.controls.errorOverlay.hide();

        const rowCount = (await dataView.rowCount()) || 0;

        // Bailout for empty visualization
        if (rowCount === 0) {
            bailout();
            return;
        }

        let hasTimeAxis = !!(await dataView.categoricalAxis(timeAxisName));

        if (!hasTimeAxis) {
            bailout(`Select a time axis`);
            return;
        }

        let hasEventAxis = !!(await dataView.categoricalAxis(eventAxisName));

        /**
         * Get Data
         */

        let timeHierarchy = await dataView.hierarchy(timeAxisName);
        let timeHierarchyRoot = await timeHierarchy?.root();

        if (timeHierarchyRoot == null) {
            // User interaction caused the data view to expire.
            // Don't clear the mod content here to avoid flickering.
            return;
        }

        let timeLeaves = timeHierarchyRoot.leaves();

        let timeHierarchyDepth = timeHierarchy?.levels.length || 0;

        /**
         * Calculate Layout
         */
        const alongSpaceBetweenCards = isHorizontal ? horizontalSpaceBetweenCards : verticalSpaceBetweenCards;
        const crossSpaceBetweenCards = isHorizontal ? verticalSpaceBetweenCards : horizontalSpaceBetweenCards;

        // How many time segments a card's along-axis footprint spans, by construction (see
        // timeSegmentSize below): 1 in vertical mode, so a lane conflict only ever happens
        // between cards in the exact same time segment, not merely nearby ones; 2 in
        // horizontal mode, so consecutive conflicting cards always land in alternating
        // lanes - and, under "middle" alignment, alternating sides of the timeline, since
        // lane parity picks the side. See the lane-assignment loop below.
        const alongSegmentsPerCard = isHorizontal ? 2 : 1;
        const alongGap = alongSpaceBetweenCards;

        // A card's along-axis size is exactly alongSegmentsPerCard * timeSegmentSize -
        // alongGap (defined below), so its footprint fills its segment(s) with no
        // spillover. That makes timeSegmentSize and edgeMargin mutually dependent
        // (edgeMargin reserves room for a card centered on the first/last segment, and is
        // half that same card size) - solved in closed form below rather than iterated to
        // a fixed point: timeSegmentSize = (mainSize - 2*edgeMargin) / N and
        // edgeMargin = (alongSegmentsPerCard*timeSegmentSize - alongGap) / 2 combine to
        // timeSegmentSize = (mainSize + alongGap) / (N + alongSegmentsPerCard).
        //
        // cardWidthAtFloor pins the smallest a time segment can shrink to
        // (minimumTimeSegmentWidth) to this mod's pre-segment-sizing card width, so a fully
        // crowded timeline stays exactly as readable as it always was.
        const cardWidthAtFloor = 3.2 * (fontSize * 4);
        const minimumTimeSegmentWidth = (cardWidthAtFloor + horizontalSpaceBetweenCards) / 2;
        const freeTimeSegmentSize = (mainSize + alongGap) / (timeLeaves.length + alongSegmentsPerCard);
        let timeSegmentSize = Math.max(minimumTimeSegmentWidth, freeTimeSegmentSize);

        const cardHeight = timeSegmentSize - verticalSpaceBetweenCards;
        const cardWidth = 2 * timeSegmentSize - horizontalSpaceBetweenCards;
        // The card's fixed rendered box (cardWidth x cardHeight) never rotates - text must
        // stay upright in both modes - but which of its two dimensions plays the "along the
        // timeline" role (spacing/collision) vs the "across/stacking" role swaps by orientation.
        const alongCardExtent = isHorizontal ? cardWidth : cardHeight;
        const crossCardExtent = isHorizontal ? cardHeight : cardWidth;
        // The actual reserved space at each edge of the content for a card centered on the
        // first/last segment to spill into - exactly half the along-axis card size, per the
        // derivation above.
        const edgeMargin = alongCardExtent / 2;
        const timeSegmentsPerCard = alongSegmentsPerCard;
        const drawingAreaCrossSize = crossSize - 35;
        const timelineCrossExtent = timelineLevelHeight * timeHierarchyDepth;
        // Centered within the actual visible (scrollbar-trimmed) drawing area, not the raw
        // window - centering on crossSize would push the timeline (and everything stacked
        // off it) 35px lower/righter than the clipped viewport actually has room for.
        // In "start"/"end" alignment, all cards render on one side, so the timeline instead
        // anchors near the opposite edge to free up the rest of the cross axis for stacking.
        const timeLineCrossPos =
            cardAlignment === "start"
                ? crossSpaceBetweenCards
                : cardAlignment === "end"
                ? drawingAreaCrossSize - crossSpaceBetweenCards - timelineCrossExtent
                : drawingAreaCrossSize / 2 - timelineCrossExtent / 2;
        const drawingAreaAlongSize = timeLeaves.length * timeSegmentSize + edgeMargin * 2;
        const timelineWidth = timeLeaves.length * timeSegmentSize;
        const timelineHeight = (timeHierarchyDepth + 1) * timelineLevelHeight;

        // Scrolling along the timeline axis: how many time segments fit in the viewport at
        // once, and how far scrollValue (index of the first visible segment) may go. This is
        // bounded by the full content extent (drawingAreaAlongSize), not just the timeline's
        // own extent - cards are much bigger than a single time segment along this axis and
        // spill into the edgeMargin reserved on each side, so scrolling only far enough to
        // reveal the last *segment* would still leave the last *card* clipped at the edge.
        const visibleTimeSegments = mainSize / timeSegmentSize;
        const maxScrollValue = Math.max(0, (drawingAreaAlongSize - mainSize) / timeSegmentSize);
        needsScroll = drawingAreaAlongSize > mainSize;
        scrollValue = Math.min(scrollValue, maxScrollValue);

        // Whether cards split across 2 independent lane pools at all. "middle" alignment
        // always does - it has 2 physical sides to use. "start"/"end" only has one side, so
        // its 2 pools (see bandOffset) exist purely to stop different dates' clusters from
        // fighting over the same lanes and reading as tangled together - but that can only
        // happen in horizontal orientation, where a card is 2 time segments wide
        // (timeSegmentsPerCard) so near-but-different dates can still visually collide. In
        // vertical orientation timeSegmentsPerCard is 1, so only cards sharing the *exact*
        // same date ever compete for a lane - different dates already get their own,
        // entirely separate row - making the second band pure unused space with nothing to
        // protect against.
        const numAlignmentGroups = cardAlignment === "middle" || isHorizontal ? 2 : 1;
        let cards: Card[] = [];
        // Populated by the capping pass below, for same-timePosition runs too dense to show
        // individually even at the readability floor.
        let overflowLabels: OverflowLabel[] = [];
        // One independent lane pool per group - see numAlignmentGroups above for why they're
        // split, and usesPlusDirection/bandOffset further down for how "middle" vs
        // "start"/"end" place the groups differently. Each map tracks, per lane, the time
        // index of the last card placed there in that group - a lane is free again once a
        // new card is far enough past it (>= timeSegmentsPerCard) to guarantee no overlap.
        let lastPositionByGroup: Map<number, number>[] = [new Map(), new Map()];
        // Concurrent-lane count within its own group at the moment each card was placed
        // (the batch's own highest lane + 1 - see below), in card order. This is what
        // cardSpacingForPeak sizes each card's own spacing from below - see the spacing
        // pass's own comment for why it's exact, not an estimate.
        let rawPeakAtInsertion: number[] = [];

        // Which of the 2 lane pools a timePosition lands on. Each leaf node is inherently
        // one distinct timePosition (that's what leafIndex means), so toggling once per
        // leaf that actually has cards - rather than once per card - is enough to keep a
        // date's events together instead of splitting across both pools.
        let currentGroup = 0;

        timeLeaves.forEach((node: DataViewHierarchyNode) => {
            let eventRows = node
                .rows()
                .filter((row) => hasEventAxis && row.categorical(eventAxisName).formattedValue() != "");
            if (eventRows.length === 0) return;
            let index = eventRows[0].categorical(timeAxisName).leafIndex;

            let group = currentGroup;
            if (numAlignmentGroups === 2) currentGroup = 1 - currentGroup;

            // All of this timePosition's cards mutually overlap (same instant), so they're
            // placed as one contiguous block of lanes rather than each finding its own free
            // lane independently - one card at a time could land a date's later cards past a
            // gap still held by some other, merely-nearby date, splitting one date's own
            // cards apart from each other for no reason. Lowest starting lane such that the
            // whole block [laneStart, laneStart + count) is free:
            let lastPosition = lastPositionByGroup[group];
            let count = eventRows.length;
            let laneStart = 0;
            let blockFree: boolean;
            do {
                blockFree = true;
                for (let k = 0; k < count; k++) {
                    let occupiedUntil = lastPosition.get(laneStart + k);
                    if (occupiedUntil != undefined && index - occupiedUntil < timeSegmentsPerCard) {
                        laneStart = laneStart + k + 1;
                        blockFree = false;
                        break;
                    }
                }
            } while (!blockFree);

            eventRows.forEach((row, k) => {
                lastPosition.set(laneStart + k, index);
                // Every card in this block reflects the block's own full height, not its
                // individual position within it - they're all equally, mutually concurrent.
                rawPeakAtInsertion.push(laneStart + count);

                cards.push({
                    description: hasEventAxis ? row.categorical(eventAxisName).formattedValue() : "",
                    verticalPosition: vpFor(group, laneStart + k),
                    cardSpacing: 0,
                    timePosition: index,
                    color: row.color(),
                    row: row
                });
            });
        });

        // Shuffle cards on top of each other to fit across the stacking axis, within the
        // actual visible drawing area (drawingAreaCrossSize), not the raw window - fitting
        // against crossSize would let the bottom/trailing-most row overflow into (and get
        // clipped by) the 35px strip reserved for the scrollbar.
        const naturalCardSpacing = crossCardExtent + 4 + crossSpaceBetweenCards;
        // Below this, a card's own text no longer reliably fits in whatever sliver of it
        // stays uncovered by its neighbors - see cardSpacingForPeak's floor and the capping
        // pass below. Mirrors timelineLevelHeight's own fontSize*2 sizing for a single line.
        const minReadableCardSpacing = fontSize * 2 + 4;
        // The overflow label (see the capping pass and calculateOverflowLabelCrossPos
        // below) is plain text, not a card - it only needs room for its own short "+N more"
        // line, not a full card's worth of readable space.
        const overflowLabelCrossSize = fontSize + 4;
        const overflowLabelGap = 4;
        function cardSpacingForPeak(peakLanes: number): number {
            // peakLanes already reflects one group's own local crowding - each group has
            // its own independent lane pool (see the per-group lane scheduler above
            // cards.push), so this is never a combined figure that needs splitting across
            // numAlignmentGroups. Space is still reserved as if the *other* group could
            // need just as many lanes too, so both groups always share one consistent, safe
            // spacing value without having to know the other group's actual peak.
            const lanesPerGroup = peakLanes;
            const totalSpaceRequired =
                naturalCardSpacing * (numAlignmentGroups * lanesPerGroup) + timelineLevelHeight * timeHierarchyDepth;
            return totalSpaceRequired < drawingAreaCrossSize
                ? naturalCardSpacing
                : Math.max(
                      minReadableCardSpacing,
                      (drawingAreaCrossSize -
                          timelineLevelHeight * timeHierarchyDepth -
                          (crossCardExtent + 4) * numAlignmentGroups) /
                          (numAlignmentGroups * lanesPerGroup)
                  );
        }
        // Inverse of cardSpacingForPeak: how many lanes (per group) fit in the available
        // cross-axis space without going below the given spacing.
        function maxLanesPerGroupAtSpacing(spacing: number): number {
            return Math.max(
                1,
                Math.floor(
                    (drawingAreaCrossSize -
                        timelineLevelHeight * timeHierarchyDepth -
                        (crossCardExtent + 4) * numAlignmentGroups) /
                        (numAlignmentGroups * spacing)
                )
            );
        }
        // verticalPosition -> group/lane and back (see laneInfo below, defined later in
        // this closure but hoisted).
        function vpFor(group: number, lane: number): number {
            return lane * 2 + group;
        }
        // "start"/"end" alignment only has one physical side to put cards on, so both of
        // its groups extend the same direction from the timeline - "start" always outward
        // like "middle"'s group 1, "end" always outward like "middle"'s group 0 - rather
        // than one direction per group the way "middle" uses to put its two groups on
        // opposite sides. This is what the z-index/front-lane and position math below key
        // off, instead of the raw group number, now that group 0 vs 1 no longer reliably
        // means "which side" once "start"/"end" also use both groups.
        function usesPlusDirection(group: number): boolean {
            return cardAlignment === "start" || (cardAlignment === "middle" && group === 1);
        }
        // "start"/"end" alignment's two groups render as two stacked bands on their one
        // shared side rather than one shared lane pool, so a date's own cluster never has
        // to compete for lanes with whichever date happens to land in the other group. Each
        // band gets a fixed, even half of the space beyond the timeline (matching the
        // symmetric per-group allocation cardSpacingForPeak already assumes) - group 1's
        // band starts right where group 0's reserved half ends. Unused in "middle"
        // alignment, whose two groups already sit on physically opposite sides of the
        // timeline and need no extra offset.
        const startEndBandHeight = (drawingAreaCrossSize - timelineLevelHeight * timeHierarchyDepth) / 2;
        function bandOffset(group: number): number {
            return cardAlignment !== "middle" && group === 1 ? startEndBandHeight : 0;
        }
        // Extreme same-timePosition clustering (e.g. thousands of events on one date) is the
        // only way lane counts grow unbounded - see the lane-scheduler comment above
        // cards.push. Once a run needs less than the readability floor per lane, stop
        // growing lanes for it: keep the frontmost `budget` cards per group individually
        // visible (see OverflowLabel above for what happens to the rest). `cards` is already
        // in non-decreasing timePosition order, so equal-timePosition cards are contiguous
        // and cheap to find as maximal runs.
        //
        // Frontmost lane differs by direction (see usesPlusDirection): a "plus direction"
        // group's cross-axis coordinate increases with lane, so its frontmost, least-
        // occluded lane is the outermost one, budget-1; a "minus direction" group's
        // decreases with lane, so its frontmost lane is 0 instead.
        //
        // budget is hoisted out of the run-scan loop below since it depends only on
        // constants fixed for this whole render pass (drawingAreaCrossSize,
        // numAlignmentGroups, minReadableCardSpacing), not on anything per-run.
        const capBudget = maxLanesPerGroupAtSpacing(minReadableCardSpacing);
        {
            let runStart = 0;
            while (runStart < cards.length) {
                let runEnd = runStart + 1;
                while (runEnd < cards.length && cards[runEnd].timePosition === cards[runStart].timePosition) {
                    runEnd++;
                }
                const runLength = runEnd - runStart;
                if (runLength > 1 && cardSpacingForPeak(runLength) <= minReadableCardSpacing) {
                    const budget = capBudget;
                    const groupCards: Card[][] = [[], []];
                    for (let i = runStart; i < runEnd; i++) {
                        groupCards[laneInfo(cards[i].verticalPosition).group].push(cards[i]);
                    }
                    const replacement: Card[] = [];
                    // groupCards always has exactly 2 slots (see its declaration above), but
                    // only numAlignmentGroups of them are ever populated - see the
                    // currentGroup toggle gated on numAlignmentGroups === 2, above cards.push.
                    for (let group = 0; group < numAlignmentGroups; group++) {
                        const inGroup = groupCards[group];
                        if (inGroup.length === 0) continue;
                        if (inGroup.length <= budget) {
                            inGroup.forEach((c) => (c.fixedSpacing = minReadableCardSpacing));
                            replacement.push(...inGroup);
                            continue;
                        }
                        const survivors = inGroup.slice(0, budget);
                        const hidden = inGroup.slice(budget);
                        survivors.forEach((c, lane) => {
                            c.verticalPosition = vpFor(group, lane);
                            c.fixedSpacing = minReadableCardSpacing;
                        });
                        replacement.push(...survivors);
                        const frontCard = survivors[usesPlusDirection(group) ? budget - 1 : 0];
                        overflowLabels.push({
                            timePosition: frontCard.timePosition,
                            verticalPosition: frontCard.verticalPosition,
                            // frontCard.cardSpacing isn't resolved yet at this point in the
                            // pipeline (only fixedSpacing, set just above) - minReadableCardSpacing
                            // is exactly what it'll end up being.
                            cardSpacing: minReadableCardSpacing,
                            count: hidden.length,
                            row: hidden[0].row
                        });
                    }
                    cards.splice(runStart, runLength, ...replacement);
                    rawPeakAtInsertion.splice(runStart, runLength, ...replacement.map(() => runLength));
                    runEnd = runStart + replacement.length;
                }
                runStart = runEnd;
            }
        }
        // Each card's spacing comes straight from its own leaf's block height
        // (rawPeakAtInsertion, set above cards.push) - no neighbor search needed. The
        // per-group split there means currentGroup alternates on every populated leaf, so
        // any other same-group leaf is always >= timeSegmentsPerCard raw positions away,
        // the same distance beyond which two cards can never visually overlap. So this
        // card's own block already *is* the worst-case concurrency nearby, exactly.
        cards.forEach((card, i) => {
            if (card.fixedSpacing != undefined) {
                // Already resolved by the capping pass above.
                card.cardSpacing = card.fixedSpacing;
                return;
            }
            card.cardSpacing = cardSpacingForPeak(rawPeakAtInsertion[i]);
        });

        // Deterministic front-to-back stacking: within a shingled/overlapping run, "drawn
        // later/in front" has to point the same way as "farther from the timeline" for a
        // card's own leading edge (its top line of text, or left edge in vertical
        // orientation - see the .card style callbacks below) to stay exposed. That's
        // lane-increasing for a "plus direction" group (see usesPlusDirection), but the
        // reverse for a "minus direction" one, whose coordinate decreases with lane - hence
        // the sign flip. A marked card gets boosted above every unmarked one regardless of
        // lane.
        const markedZBoost = 1e6;
        const hoverZIndex = 1e9;
        function cardZIndex(d: Card): number {
            const { group, lane } = laneInfo(d.verticalPosition);
            const base = usesPlusDirection(group) ? lane : -lane;
            return d.row.isMarked() ? base + markedZBoost : base;
        }

        /**
         * Update DOM
         */

        let drawingLayer = modContainer.selectAll("#drawingLayer").data([null]).join("div").attr("id", "drawingLayer");
        let scrollContent = drawingLayer
            .selectAll("#scrollContent")
            .data([null])
            .join("div")
            .attr("id", "scrollContent");
        let connectorContainer = scrollContent
            .selectAll("#connectors")
            .data([null])
            .join("div")
            .attr("id", "connectors");
        let cardContainer = scrollContent.selectAll("#cards").data([null]).join("div").attr("id", "cards");
        let overflowLabelContainer = scrollContent
            .selectAll("#overflowLabels")
            .data([null])
            .join("div")
            .attr("id", "overflowLabels");
        let timeline = scrollContent
            .selectAll("#timeline")
            .data([null])
            .join("div")
            .attr("id", "timeline")
            .attr("class", "timeline");
        let markingOverlay = modContainer
            .selectAll("#markingOverlay")
            .data([null])
            .join("div")
            .attr("id", "markingOverlay")
            .attr("class", "inactiveMarking");
        const settingsButtonSize = 24;
        // A plain top-align collides with Spotfire's floating action button (FAB), which
        // always renders in the top-right corner regardless of the mod's own orientation -
        // SIP mods reserve clearance there instead. The FAB sits at top:16px with the
        // standard 32px action-button size (~48px bottom edge), so 56px clears it with a
        // small margin.
        const settingsButtonTop = 56;
        // Same right inset regardless of orientation - keeps the button aligned under the FAB
        // (which uses this same inset) instead of shifting sideways when orientation changes,
        // and vertical mode still needs it clear of the scrollbar running down that edge.
        const settingsButtonRight = scrollBarHeight + 8;

        let settingsButton = modContainer
            .selectAll("#settingsButton")
            .data([null])
            .join("div")
            .attr("id", "settingsButton")
            .style("top", `${settingsButtonTop}px`)
            .style("right", `${settingsButtonRight}px`)
            // Interactive UI chrome (unlike the muted scale-line color used for the
            // timeline/connectors) should read like native Spotfire toolbar icons, so it
            // uses the theme's primary foreground color rather than the gridline color.
            .style("color", uiChromeColor)
            .style("border-color", uiChromeColor)
            // Without a fill, the timeline underneath shows through the button wherever
            // it overlaps - give it the mod's own background so it reads as opaque chrome.
            .style("background-color", context.styling.general.backgroundColor)
            .on("click", () => {
                mod.controls.popout.show(
                    {
                        x: windowSize.width - settingsButtonRight - settingsButtonSize,
                        y: settingsButtonTop + settingsButtonSize / 2,
                        alignment: "Right",
                        autoClose: true,
                        onChange: (event) => {
                            if (event.name === "orientationAlignment") {
                                const [newOrientation, newCardAlignment] = (event.value as string).split("-");
                                mod.property<string>("orientation").set(newOrientation);
                                mod.property<string>("cardAlignment").set(newCardAlignment);
                            }
                        }
                    },
                    () => [
                        mod.controls.popout.section({
                            heading: "Horizontal",
                            children: [
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Top",
                                    checked: orientation === "horizontal" && cardAlignment === "start",
                                    value: "horizontal-start"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Middle",
                                    checked: orientation === "horizontal" && cardAlignment === "middle",
                                    value: "horizontal-middle"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Bottom",
                                    checked: orientation === "horizontal" && cardAlignment === "end",
                                    value: "horizontal-end"
                                })
                            ]
                        }),
                        mod.controls.popout.section({
                            heading: "Vertical",
                            children: [
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Left",
                                    checked: orientation === "vertical" && cardAlignment === "start",
                                    value: "vertical-start"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Middle",
                                    checked: orientation === "vertical" && cardAlignment === "middle",
                                    value: "vertical-middle"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Right",
                                    checked: orientation === "vertical" && cardAlignment === "end",
                                    value: "vertical-end"
                                })
                            ]
                        })
                    ]
                );
            });
        settingsButton.html(settingsIconSvg);
        updateSettingsButtonVisibility();

        // #mod-container has no CSS height of its own - it auto-sizes to its normal-flow
        // content, which is just drawingLayer (shorter than windowSize.height). The
        // scrollbar, positioned near the true bottom of the mod, would then render outside
        // mod-container's own box, so hovering it would count as a mouseleave on the
        // container it's meant to be part of. Size it explicitly to the full viewport.
        modContainer.style("width", `${windowSize.width}px`).style("height", `${windowSize.height}px`);

        // Drawing Layer - fixed to the viewport. scrollContent is the full (possibly larger)
        // content that gets panned along the timeline axis via a CSS transform.
        drawingLayer
            .style("left", `${0}px`)
            .style("top", `${0}px`)
            .style(crossSizeProp, `${drawingAreaCrossSize}px`)
            .style(alongSizeProp, `${mainSize}px`)
            .on("mousedown", mouseDownHandler)
            .on("dblclick", doubleclickHandler)
            .on("wheel", (event: WheelEvent) => timelineScrollBar.handleWheel(event));

        scrollContent
            .style(crossSizeProp, `${drawingAreaCrossSize}px`)
            .style(alongSizeProp, `${drawingAreaAlongSize}px`);

        // Timeline

        timeline
            .style(alongProp, (d) => `${edgeMargin}px`)
            .style(crossProp, (d) => `${timeLineCrossPos}px`)
            .style(alongSizeProp, (d) => `${timeLeaves.length * timeSegmentSize + 2}px`)
            .style(crossSizeProp, (d) => `${timelineLevelHeight * timeHierarchyDepth + 2}px`);

        // create a d3 hierarchy with the width of each timesegment proportional to the number of descendants
        let hierarchyRootNode: HierarchyNode<DataViewHierarchyNode> = hierarchy(timeHierarchyRoot);
        hierarchyRootNode.sum((d: DataViewHierarchyNode) => (!d?.children && 1) || 0);

        let timelinePartition = partition<DataViewHierarchyNode>()
            .size([timelineWidth, timelineHeight])
            .padding(0)
            .round(false);
        let partitionedHierarchy: HierarchyRectangularNode<DataViewHierarchyNode> = timelinePartition(
            hierarchyRootNode
        ) as HierarchyRectangularNode<DataViewHierarchyNode>;

        // remove the root node from the displayed hierarchy
        let displayHierarchy = partitionedHierarchy
            .descendants()
            .filter((d: HierarchyRectangularNode<DataViewHierarchyNode>) => d.parent);

        // Scrollbar - a bottom strip in horizontal mode, a right strip in vertical mode
        timelineScrollBar.update({
            width: isHorizontal ? mainSize : scrollBarHeight,
            height: isHorizontal ? scrollBarHeight : mainSize,
            left: isHorizontal ? 0 : crossSize - scrollBarHeight,
            top: isHorizontal ? crossSize - scrollBarHeight : 0,
            orientation,
            // Total content extent in the same timeSegmentSize-normalized units as scrollValue
            // (drawingAreaAlongSize / timeSegmentSize) - used only for the handle's proportional
            // extent (extent / totalItems), not for its position, so it's independent of
            // whatever that extent ends up clamped to.
            totalItems: maxScrollValue + visibleTimeSegments,
            value: scrollValue,
            maxValue: maxScrollValue,
            extent: visibleTimeSegments,
            // Same reasoning as the settings button above - interactive chrome uses the
            // primary foreground color, not the muted scale-line color.
            color: uiChromeColor,
            background: context.styling.general.backgroundColor,
            scrollDistance: timeSegmentSize,
            valueChanged: onScrollValueChanged
        });
        updateScrollBarVisibility();
        timelineScrollBar.render();
        applyScrollTransform();

        /**
         * Virtual scrolling: cards, connectors and time markers are only joined into the DOM
         * for the currently rendered window (viewport + an overscan buffer of one extra
         * screen on each side), not for the whole dataset. So the DOM node count stays
         * bounded by the viewport size regardless of how much data is behind it, without
         * needing any cap on row or time-segment count. cards and displayHierarchy
         * themselves are still built from the full dataset every render
         * (needed for correct global card-stacking and proportional time-segment sizes),
         * but that's cheap plain-object work, not DOM.
         */
        let renderedRangeStart = Infinity;
        let renderedRangeEnd = -Infinity;

        function renderVisibleWindow() {
            let viewportStartPx = scrollValue * timeSegmentSize;
            let viewportEndPx = viewportStartPx + mainSize;

            // Already-rendered window (with its overscan buffer) still covers the viewport -
            // nothing new would come into view, so skip the rejoin entirely.
            if (viewportStartPx >= renderedRangeStart && viewportEndPx <= renderedRangeEnd) {
                return;
            }

            let overscanPx = mainSize;
            renderedRangeStart = Math.max(0, viewportStartPx - overscanPx);
            renderedRangeEnd = Math.min(drawingAreaAlongSize, viewportEndPx + overscanPx);

            let visibleCards = cards.filter((c: Card) => {
                let alongPos = calculateCardAlongPos(c);
                return alongPos + alongCardExtent >= renderedRangeStart && alongPos <= renderedRangeEnd;
            });
            let visibleOverflowLabels = overflowLabels.filter((l: OverflowLabel) => {
                let alongPos = calculateCardAlongPos(l);
                return alongPos + alongCardExtent >= renderedRangeStart && alongPos <= renderedRangeEnd;
            });

            // Connectors

            connectorContainer
                .selectAll<HTMLDivElement, Card>(".connector")
                .data(visibleCards, (d: Card) => d.row.elementId(true))
                .join("div")
                .attr("class", "connector")
                .style(alongProp, (d) => `${edgeMargin + d.timePosition * timeSegmentSize + timeSegmentSize / 2}px`)
                .style(alongSizeProp, "2px")
                .style(crossProp, (d) => `${calcConnectorCrossPos(d)}px`)
                .style(crossSizeProp, (d) => `${calcConnectorCrossExtent(d)}px`)
                // Cards carry an explicit z-index (see cardZIndex) that can go negative for a
                // "minus direction" group's lanes. Without a z-index of their own, connectors
                // sit at the default "auto" tier, *above* any negative card - pin them below
                // every possible card z-index instead.
                .style("z-index", "-10000000");

            // Cards

            cardContainer
                .selectAll<HTMLDivElement, Card>(".card")
                .data(visibleCards, (d: Card) => d.row.elementId(true))
                .join("div")
                .attr("class", "card")
                .attr("draggable", "false")
                .classed("card-marked", (d) => d.row.isMarked())
                // Marking is handled entirely by finishDrag()'s rectangle hit-test - a plain
                // click is just a zero-size drag, so it's already covered there. A separate
                // click handler here would double-mark the row (once from the mousedown-
                // triggered drag, once from the click that follows it), which cancels out
                // Ctrl/Cmd's toggle-or-add instead of applying it.
                .on("mouseenter", (e, d: Card) => {
                    mod.controls.tooltip.show(`${d.row.categorical(timeAxisName).formattedValue()}\n${d.description}`);
                    // Bring the hovered card fully in front, regardless of its own stacking
                    // z-index - restored to that resting z-index on mouseleave below.
                    select(e.currentTarget as HTMLDivElement).style("z-index", `${hoverZIndex}`);
                })
                .on("mouseleave", (e, d: Card) => {
                    mod.controls.tooltip.hide();
                    select(e.currentTarget as HTMLDivElement).style("z-index", `${cardZIndex(d)}`);
                })
                .text((d) => d.description)
                .style(alongProp, (d: Card) => `${calculateCardAlongPos(d)}px`)
                .style(crossProp, (d: Card) => `${calculateCardCrossPos(d)}px`)
                .style("height", `${cardHeight}px`)
                .style("width", `${cardWidth}px`)
                .style("z-index", (d: Card) => `${cardZIndex(d)}`)
                // A card that isn't actually overlapping any neighbor keeps the plain
                // centered look; an overlapping one anchors its text to whichever edge the
                // shingled stacking order (see cardZIndex) keeps uncovered - its own top in
                // horizontal orientation (any number of wrapped lines), its own left edge in
                // vertical orientation (forced to a single ellipsized line, since a narrow
                // vertical sliver can't shingle wrapped lines the way a horizontal one can).
                .style("align-items", (d: Card) =>
                    d.cardSpacing >= crossCardExtent ? "center" : isHorizontal ? "flex-start" : "center"
                )
                .style("justify-content", (d: Card) =>
                    d.cardSpacing >= crossCardExtent ? "center" : isHorizontal ? "center" : "flex-start"
                )
                .style("text-align", (d: Card) => (d.cardSpacing < crossCardExtent && !isHorizontal ? "left" : "center"))
                .style("white-space", (d: Card) => (d.cardSpacing < crossCardExtent && !isHorizontal ? "nowrap" : "normal"))
                .style("background-color", (d) => `${d.color.hexCode}`)
                .style("color", (d: Card) => `${contrastColor(d.color.hexCode)}`);

            // Overflow labels - see the OverflowLabel interface above for what these are.
            // Plain text, no card chrome, unlike the cards joined above.

            overflowLabelContainer
                .selectAll<HTMLDivElement, OverflowLabel>(".overflow-label")
                .data(
                    visibleOverflowLabels,
                    (l: OverflowLabel) => `overflow-${l.timePosition}-${laneInfo(l.verticalPosition).group}`
                )
                .join("div")
                .attr("class", "overflow-label")
                .on("mouseenter", (e, l: OverflowLabel) => {
                    mod.controls.tooltip.show(
                        `${l.row.categorical(timeAxisName).formattedValue()}\n${l.count} more events`
                    );
                })
                .on("mouseleave", () => {
                    mod.controls.tooltip.hide();
                })
                .text((l) => `+${l.count} more`)
                .style(alongProp, (l: OverflowLabel) => `${calculateCardAlongPos(l)}px`)
                .style(crossProp, (l: OverflowLabel) => `${calculateOverflowLabelCrossPos(l)}px`)
                .style(alongSizeProp, `${alongCardExtent}px`)
                .style(crossSizeProp, `${overflowLabelCrossSize}px`)
                .style("color", uiChromeColor)
                // Sits just past its anchor card's own far edge, so it shouldn't normally
                // be covered by anything - but pin it above the normal card z-index range
                // anyway, the same reasoning as the connectors' z-index fix above.
                .style("z-index", `${hoverZIndex}`);

            // Time markers

            // d.x0/d.x1 are timeline-local (relative to #timeline's own box, which sits at
            // edgeMargin within scrollContent - see the timeline .style(alongProp, ...) call
            // above). renderedRangeStart/End are in scrollContent-space, so edgeMargin has to
            // be added here to compare like with like, matching calculateCardAlongPos.
            let visibleMarkers = displayHierarchy.filter(
                (d: HierarchyRectangularNode<DataViewHierarchyNode>) =>
                    d.x1 + edgeMargin >= renderedRangeStart && d.x0 + edgeMargin <= renderedRangeEnd
            );

            // Level 0 (coarsest) normally renders at the timeline block's near edge and the
            // deepest level at its far edge. In "end" alignment the block itself sits with
            // its near edge against the cards (the opposite of "start"), so without a flip
            // the coarsest level would land next to the cards and the finest level next to
            // the empty margin - backwards relative to "start". Mirroring the level order
            // for "end" keeps the finest level adjacent to the cards in both cases.
            function displayLevel(d: HierarchyRectangularNode<DataViewHierarchyNode>) {
                return cardAlignment === "end" ? timeHierarchyDepth - 1 - d.data.level : d.data.level;
            }

            timeline
                .selectAll<HTMLDivElement, HierarchyRectangularNode<DataViewHierarchyNode>>(".timeMarker")
                .data(visibleMarkers, (d) => d.data.formattedPath())
                .join("div")
                .attr("class", "timeMarker")
                .classed(isHorizontal ? "timeMarker-left" : "timeMarker-top", (d: HierarchyRectangularNode<DataViewHierarchyNode>) => d.x0 == 0)
                .classed(isHorizontal ? "timeMarker-top" : "timeMarker-left", (d: HierarchyRectangularNode<DataViewHierarchyNode>) => displayLevel(d) == 0)
                // The cross-axis band is only ~timelineLevelHeight thick - fine for one
                // horizontal line of text under a wide segment, but far too narrow for
                // horizontal text under a tall vertical-mode segment. Flip the label to run
                // along the (much roomier) along-axis instead.
                .classed("timeMarker-vertical", !isHorizontal)
                .on("click", (e, d: HierarchyRectangularNode<DataViewHierarchyNode>) => {
                    d.data.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace");
                    e.stopPropagation();
                })
                .text((d: HierarchyRectangularNode<DataViewHierarchyNode>) => d.data.formattedValue())
                .style(alongProp, (d) => d.x0)
                .style(alongSizeProp, (d) => d.x1 - d.x0 - 5)
                .style(crossProp, (d) => displayLevel(d) * timelineLevelHeight)
                .style(crossSizeProp, (d) => d.y1 - d.y0);
        }

        renderVisibleWindow();

        function onScrollValueChanged(newValue: number) {
            scrollValue = newValue;
            applyScrollTransform();
            renderVisibleWindow();
        }

        function applyScrollTransform() {
            let offsetPx = scrollValue * timeSegmentSize;
            scrollContent.style("transform", `translate${isHorizontal ? "X" : "Y"}(${-offsetPx}px)`);
        }

        // Start/Stop automatic timeline scrolling with ctrl-key or metakey + doubleclick

        function doubleclickHandler(event: MouseEvent) {
            if (event.ctrlKey || event.metaKey) {
                if (!autoScroll) {
                    autoScroll = true;
                    scroll();
                } else {
                    autoScroll = false;
                }
            }
        }

        function scroll() {
            if (autoScroll && scrollValue < maxScrollValue) {
                // Advance by roughly one pixel per tick, matching the previous native-scroll speed.
                scrollValue = Math.min(maxScrollValue, scrollValue + 1 / timeSegmentSize);
                timelineScrollBar.setValue(scrollValue);
                applyScrollTransform();
                renderVisibleWindow();
                setTimeout(scroll, autoScrollSpeed);
            } else {
                autoScroll = false;
            }
        }

        context.signalRenderComplete();

        /**
         * Inline helper functions
         */

        function mouseDownHandler(event: MouseEvent) {
            // Time markers own their marking via their own click handler (which respects
            // ctrl/meta for add-to-marking). Starting the rectangle-selection tracking here
            // too would make mouseUpHandler's own marking logic run first on mouseup - since
            // a click point never intersects a card rect when it's over the timeline, that
            // unconditionally clears all marking (regardless of ctrl/meta) before the time
            // marker's click handler gets a chance to add to it.
            if ((event.target as HTMLElement).closest(".timeMarker")) {
                return;
            }

            // markingOverlay isn't inside the scrolled content, so selection is tracked in
            // plain viewport coordinates (clientX/clientY) rather than content-space pixels.
            selection = {
                x1: event.clientX,
                y1: event.clientY,
                x2: event.clientX,
                y2: event.clientY
            };
            activeMouseMoveHandler = mouseMoveHandler;
            activeMouseUpHandler = mouseUpHandler;
            // Mods run in an iframe, so a mouseup that happens over another Spotfire panel
            // (or outside the browser) never reaches this document - mouseMoveHandler's own
            // event.buttons check below covers the case where the cursor comes back over the
            // mod, but if it never does, losing focus is usually the only signal we get that
            // the drag ended. Cancel (without committing a marking, since we can't tell if the
            // button was actually released) rather than leaving the overlay/listeners stuck.
            activeBlurHandler = cancelDrag;
            document.addEventListener("mousemove", activeMouseMoveHandler);
            document.addEventListener("mouseup", activeMouseUpHandler);
            window.addEventListener("blur", activeBlurHandler);
        }

        function mouseMoveHandler(event: MouseEvent) {
            selection.x2 = event.clientX;
            selection.y2 = event.clientY;

            // The primary button is no longer pressed, so it must have been released while
            // the cursor was outside the iframe (see the blur-handler comment in
            // mouseDownHandler) - finish the drag now instead of leaving it stuck.
            if (event.buttons === 0) {
                finishDrag(event);
                return;
            }

            markingOverlay
                .attr("class", "activeMarking")
                .style("left", `${selection.x2 > selection.x1 ? selection.x1 : selection.x2}`)
                .style("top", `${selection.y2 > selection.y1 ? selection.y1 : selection.y2}`)
                .style("width", `${Math.abs(selection.x2 - selection.x1)}`)
                .style("height", `${Math.abs(selection.y2 - selection.y1)}`);
        }

        function resetMarkingOverlay() {
            markingOverlay
                .style("left", `${0}`)
                .style("top", `${0}`)
                .style("width", `${0}`)
                .style("height", `${0}`)
                .attr("class", "inactiveMarking");
        }

        function mouseUpHandler(event: MouseEvent) {
            finishDrag(event);
        }

        function finishDrag(event: MouseEvent) {
            resetMarkingOverlay();

            // Cards are positioned in scrollContent's content-space; shift by the current
            // scroll offset (which only ever applies to the along-timeline axis) to compare
            // against the viewport-space selection rect.
            let scrollOffsetPx = scrollValue * timeSegmentSize;

            if (selection.x1 > selection.x2) {
                [selection.x1, selection.x2] = [selection.x2, selection.x1];
            }
            if (selection.y1 > selection.y2) {
                [selection.y1, selection.y2] = [selection.y2, selection.y1];
            }

            let selectedCards = cardContainer.selectAll<HTMLDivElement, Card>(".card").filter((c: Card) => {
                let alongPos = calculateCardAlongPos(c) - scrollOffsetPx;
                let crossPos = calculateCardCrossPos(c);
                let x1 = isHorizontal ? alongPos : crossPos;
                let y1 = isHorizontal ? crossPos : alongPos;
                let cardRect: Rect = {
                    x1: x1,
                    y1: y1,
                    x2: x1 + cardWidth,
                    y2: y1 + cardHeight
                };

                return intersect(cardRect, selection);
            });

            if (selectedCards.size() > 0) {
                selectedCards.each((c: Card) => {
                    c.row.mark(event.ctrlKey || event.metaKey ? "ToggleOrAdd" : "Replace");
                });
                event.stopPropagation();
            } else if (!(event.ctrlKey || event.metaKey)) {
                dataView.clearMarking();
            }

            detachDragHandlers();
        }

        // Only reachable via the blur listener - the button state is unknown at that point
        // (blur can also fire without a mouse release, e.g. alt-tabbing), so just reset the
        // overlay/listeners without touching marking.
        function cancelDrag() {
            resetMarkingOverlay();
            detachDragHandlers();
        }

        // Widened to { timePosition } (rather than Card) so an OverflowLabel - which has no
        // description/color of its own - can reuse this too.
        function calculateCardAlongPos(d: { timePosition: number }) {
            return edgeMargin + d.timePosition * timeSegmentSize - alongCardExtent / 2 + timeSegmentSize / 2;
        }

        // Cards always alternate between 2 groups, stacking outward in lanes within their
        // own group - see usesPlusDirection/bandOffset above for how "middle" (opposite
        // sides of the timeline) vs "start"/"end" (two stacked bands on their one shared
        // side) place them differently.
        function laneInfo(verticalPosition: number) {
            return { group: verticalPosition % 2, lane: Math.floor(verticalPosition / 2) };
        }

        // A "plus direction" group's connector always starts flush against the timeline
        // (a constant, lane-independent position) and reaches out to the card via its
        // extent; a "minus direction" group's connector instead sits at the card's own near
        // edge and reaches back to the timeline via its extent - see the derivation in
        // usesPlusDirection's comment for why the two are shaped so differently. Either way
        // the connector's box always spans exactly from the card's near edge to
        // timeLineCrossPos itself.
        function calcConnectorCrossExtent(d: Card) {
            let { group, lane } = laneInfo(d.verticalPosition);
            let cardSpacing = d.cardSpacing;
            let offset = bandOffset(group);

            return usesPlusDirection(group)
                ? crossSpaceBetweenCards + lane * cardSpacing - 3 + offset
                : lane * cardSpacing + crossSpaceBetweenCards + offset;
        }

        function calcConnectorCrossPos(d: Card) {
            let { group, lane } = laneInfo(d.verticalPosition);
            let cardSpacing = d.cardSpacing;

            return usesPlusDirection(group)
                ? timeLineCrossPos + timelineLevelHeight * timeHierarchyDepth + 3
                : timeLineCrossPos - crossSpaceBetweenCards - lane * cardSpacing - bandOffset(group);
        }

        // Widened to { verticalPosition, cardSpacing } (rather than Card) so an
        // OverflowLabel - anchored to the frontmost real card's own lane/spacing, see the
        // capping pass above - can reuse this to find that card's position too.
        function calculateCardCrossPos(d: { verticalPosition: number; cardSpacing: number }) {
            let { group, lane } = laneInfo(d.verticalPosition);
            let cardSpacing = d.cardSpacing;
            let offset = bandOffset(group);

            return usesPlusDirection(group)
                ? timeLineCrossPos +
                      timelineLevelHeight * timeHierarchyDepth +
                      lane * cardSpacing +
                      crossSpaceBetweenCards +
                      offset
                : timeLineCrossPos - crossSpaceBetweenCards - lane * cardSpacing - crossCardExtent - offset;
        }

        // An overflow label sits just past its anchor card's far edge (the edge away from
        // the timeline) - for a "plus direction" group that's crossCardExtent past the
        // anchor's own (near-timeline) position; for "minus direction" the anchor's own
        // position *is* the far edge already (see calculateCardCrossPos), so the label
        // continues outward from there instead. Either way it's sized to just fit its own
        // short text (overflowLabelCrossSize), not a full card's worth of room.
        function calculateOverflowLabelCrossPos(label: OverflowLabel): number {
            let anchorPos = calculateCardCrossPos(label);
            let { group } = laneInfo(label.verticalPosition);

            return usesPlusDirection(group)
                ? anchorPos + crossCardExtent + overflowLabelGap
                : anchorPos - overflowLabelGap - overflowLabelCrossSize;
        }
    }
});

function intersect(first: Rect, second: Rect) {
    if (first.x1 > second.x2 || second.x1 > first.x2) {
        return false;
    }
    if (first.y1 > second.y2 || second.y1 > first.y2) {
        return false;
    }
    return true;
}

/**
 * Relative luminance of a #RRGGBB (or #RGB) color, per the WCAG 2.0 definition.
 */
function getLuminance(hexCode: string): number {
    let hex = hexCode.replace("#", "");
    if (hex.length == 3) {
        hex = hex
            .split("")
            .map((c) => c + c)
            .join("");
    }

    let channels = [0, 2, 4].map((offset) => {
        let channel = parseInt(hex.substring(offset, offset + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });

    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastColor(hexCode: string): string {
    let L = getLuminance(hexCode);

    if ((L + 0.05) / (0.0 + 0.05) > (1.0 + 0.05) / (L + 0.05)) {
        return "#000000";
    } else {
        return "#ffffff";
    }
}
