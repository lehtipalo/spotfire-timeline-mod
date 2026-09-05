import { DataView, DataViewRow, DataViewHierarchyNode, DataViewColorInfo, ModProperty } from "spotfire-api";
import { select } from "d3-selection";
import { hierarchy, partition, HierarchyNode, HierarchyRectangularNode } from "d3-hierarchy";
import { scrollBarControl } from "./scrollBarControl";
import { balancedLaneLayout } from "./balancedLaneLayout";
import { contrastColor } from "./color";
import { settingsButtonControl } from "./settingsButtonControl";

// Keep in sync with the "cardDensity" property's defaultValue in mod-manifest.json - that's
// what Spotfire assigns before this code ever runs, so this fallback (only reached once the
// property already exists but holds something other than "spacious") should agree with it.
const defaultCardDensity: "dense" | "spacious" = "dense";

export type Orientation = "horizontal" | "vertical";
export type CardAlignment = "start" | "middle" | "end";
export type CardDensity = "dense" | "spacious";

interface Card {
    timePosition: number;
    verticalPosition: number;
    // Cross-axis lane pitch for this card - see the local-peak search below for how it's
    // derived. Filled in after verticalPosition is assigned.
    cardSpacing: number;
    // Mirrors LayoutResult.offScreen - true when the layout algorithm gave up on finding
    // this card a real lane, i.e. it's guaranteed unreachable regardless of pixel geometry.
    offScreen: boolean;
    description: string;
    color: DataViewColorInfo;
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
    // Flat, theme-independent gray rather than uiChromeColor (the settings button's own
    // "interactive toolbar chrome" tone, derived from the visualization's font color) -
    // Spotfire's native scrollbar thumb doesn't tint itself to the viz's own accent/font
    // color, it's a fixed muted gray that works the same regardless of theme. Semi-
    // transparent so it blends into whatever's underneath rather than reading as a flat
    // opaque shape.
    scrollBarColor = "rgba(150, 150, 150, 0.5)",
    // .card's box-shadow (main.css) paints outside its layout box - up to offset+blur past
    // the far edge (2px + 5px = 7px for the outer shadow layer). Reserved as
    // LayoutContext.outerEdgeMargin so the outermost lane on each side never sits flush
    // against #drawingLayer's overflow:hidden boundary, which would slice the shadow off
    // that one edge while every other card shows it in full.
    cardShadowBleed = 8,
    // Purely cosmetic breathing room between #mod-container's own edge and Spotfire's own
    // axis-selector chrome just outside it, which otherwise sits flush against our content.
    // Must match #mod-container's CSS margin in main.css - see availableSize below for why
    // that pairing matters (an unmatched margin/size would silently clip content again).
    modMargin = 2,
    // A mousedown-to-mouseup drag no bigger than this, in either direction, is treated as a
    // click rather than a deliberate rectangle-marking gesture - see finishDrag. Big enough
    // to absorb incidental mouse jitter between the two events, small enough that no
    // intentional marking rectangle could be mistaken for one.
    clickDragTolerancePx = 3;

/**
 * Set up drawing layers
 */
const modContainer = select("#mod-container");
const timelineScrollBar = scrollBarControl(modContainer);

let selection: Rect = { x1: 0, y1: 0, x2: 0, y2: 0 };

// Remembers which listeners belong to the current in-progress drag,  so if a re-render happens mid-drag,
// the old (now-stale) listeners can be found and removed before they run against disposed data
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

    const settingsButton = settingsButtonControl(modContainer, mod);

    // The Mods API exposes only the (deliberately muted) scale-line color and the full-
    // strength font color - neither matches the lighter tint the native toolbar icons use.
    // Blending font color toward the background approximates that native chrome weight.
    const uiChromeColor = `color-mix(in srgb, ${context.styling.general.font.color} 55%, ${context.styling.general.backgroundColor})`;

    let fontSize = parseInt(context.styling.general.font.fontSize.toString()); // workaround bug in Spotfire 11.4 where fontSize returns string

    let timelineLevelHeight = fontSize * 2;
    // cardWidth/cardHeight/edgeMargin are computed per-render (see render()) - though they
    // only depend on fontSize and card spacing, not on the viewport or time axis, they live
    // next to the timeSegmentSize math they feed into rather than being hoisted out on their own.
    let autoScroll = false;
    let autoScrollSpeed = 5;
    // The setTimeout id of any in-flight auto-scroll loop, so a new render can cancel it -
    // mirrors detachDragHandlers() for drag state, since the running scroll() closure captures
    // timeSegmentSize/maxScrollValue/scrollContent/isHorizontal from whichever render started it,
    // and those go stale the moment a new render lays things out differently (see #26).
    let activeScrollTimeoutId: ReturnType<typeof setTimeout> | null = null;

    function cancelAutoScroll() {
        autoScroll = false;
        if (activeScrollTimeoutId !== null) {
            clearTimeout(activeScrollTimeoutId);
            activeScrollTimeoutId = null;
        }
    }
    // Leftmost visible time segment index, persisted across renders so scroll position
    // survives marking/window updates instead of resetting on every re-render.
    let scrollValue = 0;
    // Where scrollValue currently points, expressed so it can be relocated after a Time
    // axis expression edit rebuilds the hierarchy with a different leaf count/depth -
    // scrollValue itself is never actually reset by that, it's only ever clamped, but the
    // same raw index silently starts pointing at an unrelated point in time once the
    // hierarchy reshapes.
    //
    // `path` is, for each ancestor level (top down, excluding the invisible true root) of
    // the leaf at the *center* of the viewport, that node's key plus its position among its
    // own siblings - e.g. [{key: "1946", ...}, {key: "Jun", ...}] for a Year > Month leaf.
    // Resolving walks the new hierarchy from the root matching path entries level by level
    // - each level's own key against itself, which stays valid regardless of how many
    // levels exist above or below it. `key` (rather than formattedValue()) is used because
    // it's guaranteed unique among siblings, whereas two distinct sibling values can format
    // to the same display string. When a level's exact key is no longer present (e.g. that
    // bucket was filtered/marked out), the walk falls back to the child at the closest
    // relative sibling position instead of giving up - so a single missing bucket doesn't
    // widen the eventual match all the way out to some broad ancestor's entire leaf range.
    // `fraction` (0-1) is the remaining sub-position within the deepest matched node's own
    // leaf range.
    //
    // Two simpler approaches were tried first and both broke on real data:
    //  - Anchoring to a leaf's own DataViewHierarchyNode.value() directly: only reflects
    //    that leaf's own level (e.g. just a month number, not the year it's in), so it
    //    isn't comparable across hierarchies with a different number of levels.
    //  - Anchoring to a fraction of the total leaf count: assumes every bucket is the same
    //    size, which breaks by a roughly constant offset the moment any bucket (almost
    //    always the first or last) is partial.
    // An earlier attempt at this same path-match approach broke round-tripping outright,
    // traced to wrongly assuming (from a misread of "undefined for root level nodes" in
    // the docs) that a top-level node's own .parent is undefined - confirmed via live
    // console logging that it isn't: it points to a real root node (formattedValue() "",
    // value() null), whose *own* .parent is what's actually undefined. The capture walk
    // below stops there correctly now.
    type ScrollAnchorPathEntry = { key: string; siblingIndex: number; siblingCount: number };
    let scrollAnchor: { path: ScrollAnchorPathEntry[]; fraction: number } | null = null;
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
        settingsButton.setVisible(isHovering);
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
        mod.property<string>("cardAlignment"),
        mod.property<string>("cardDensity")
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
        cardAlignmentProperty: ModProperty<string>,
        cardDensityProperty: ModProperty<string>
    ) {
        // Cancel any drag selection still in progress from a previous render - its listeners
        // close over rows/DataView from that render, which may now be disposed.
        detachDragHandlers();
        // Same idea for an in-flight auto-scroll loop - see cancelAutoScroll().
        cancelAutoScroll();
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
        const cardDensityValue = cardDensityProperty.value<string>();
        const cardDensity: "dense" | "spacious" = cardDensityValue === "spacious" ? "spacious" : defaultCardDensity;
        // #mod-container is given a matching CSS margin (see main.css) so its content sits
        // a few pixels clear of Spotfire's own axis-selector chrome just outside our
        // rendering area, instead of butting flush against it. windowSize itself is always
        // the *full* area Spotfire allotted us - #mod-container's own JS-set size must be
        // shrunk by the same margin on both sides, or it would overflow past its own margin
        // and get sliced off by body's overflow:hidden, the same way an unreset default body
        // margin once did (see the box-sizing fix history in balancedLaneLayout/main.css).
        const availableSize = {
            width: windowSize.width - 2 * modMargin,
            height: windowSize.height - 2 * modMargin
        };
        // The axis along which the timeline runs/scrolls, and the axis across which cards
        // stack away from it - horizontal maps along->x/cross->y, vertical is the mirror.
        const mainSize = isHorizontal ? availableSize.width : availableSize.height;
        const crossSize = isHorizontal ? availableSize.height : availableSize.width;
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

        // Turns a previously captured scrollAnchor back into a scrollValue (the viewport's
        // left edge) for this render's (possibly reshaped) hierarchy: walks from the root
        // matching anchor.path level by level - each level's own key against itself, so it
        // stays valid regardless of how many levels exist above or below it. A level whose
        // exact key is gone still gets approximated via its stored sibling position rather
        // than aborting the walk, so a single filtered/marked-out bucket only nudges the
        // result off by roughly one sibling at that level instead of widening it out to
        // whatever ancestor's entire leaf range. Once the walk ends (at an exact leaf, if
        // every level matched or was approximated, or earlier if some level had no children
        // at all), the stored sub-fraction is applied across that node's real leaf range.
        function resolveScrollValueFromAnchor(anchor: { path: ScrollAnchorPathEntry[]; fraction: number }): number {
            let node: DataViewHierarchyNode = timeHierarchyRoot!;
            for (const entry of anchor.path) {
                if (!node.children || node.children.length === 0) break;
                const exact = node.children.find((c) => (c.key ?? c.formattedValue()) === entry.key);
                if (exact) {
                    node = exact;
                    continue;
                }
                // The exact sibling is gone (e.g. filtered/marked out) - fall back to the
                // child at the closest relative sibling position, so the walk still lands
                // near where it was instead of stopping here and taking this whole node's
                // (possibly much larger) leaf range as the match.
                const ratio = entry.siblingIndex / Math.max(1, entry.siblingCount - 1);
                const approxIndex = Math.round(ratio * (node.children.length - 1));
                node = node.children[Math.min(node.children.length - 1, Math.max(0, approxIndex))];
            }
            const leaves = node.leaves();
            if (leaves.length === 0) return 0;
            const startIndex = leaves[0].leafIndex ?? 0;
            const centerIndex = startIndex + anchor.fraction * leaves.length;
            return centerIndex - visibleTimeSegments / 2;
        }

        // Captures the current scroll position as a scrollAnchor (see its declaration for
        // why a path match rather than a value or a fraction), so a later render (with a
        // possibly-reshaped hierarchy, e.g. from a Time axis expression edit that changes
        // the granularity) can relocate roughly the same relative position instead of
        // reinterpreting the same raw index against a hierarchy it no longer describes.
        //
        // Anchored to the *center* of the viewport, not its left edge (scrollValue itself):
        // a granularity change also changes how many leaves fit on screen at once (e.g.
        // ~18 years fit before hitting the minimum card-width floor, but only ~18 months
        // do after drilling in), so preserving just the left edge's position leaves the
        // *center* of what's visible dragged backwards by roughly half of however much the
        // viewport's real-time span just shrank - which reads as a jarring jump even though
        // the edge itself never moved. Anchoring the point the user is actually looking at
        // avoids that.
        function captureScrollAnchor(value: number) {
            if (timeLeaves.length === 0) {
                scrollAnchor = null;
                return;
            }
            const centerValue = value + visibleTimeSegments / 2;
            const leafIndex = Math.min(timeLeaves.length - 1, Math.max(0, Math.floor(centerValue)));
            const path: ScrollAnchorPathEntry[] = [];
            // Stops once a node's own .parent is undefined - the true root - rather than
            // once the node itself is falsy, since a top-level node's .parent is a real
            // (root) object, not undefined; see the comment on scrollAnchor's declaration.
            let node: DataViewHierarchyNode | undefined = timeLeaves[leafIndex];
            while (node && node.parent !== undefined) {
                const siblings = node.parent.children ?? [node];
                const siblingIndex = Math.max(0, siblings.indexOf(node));
                path.unshift({
                    key: node.key ?? node.formattedValue(),
                    siblingIndex,
                    siblingCount: siblings.length
                });
                node = node.parent;
            }
            scrollAnchor = { path, fraction: centerValue - Math.floor(centerValue) };
        }

        let timeHierarchyDepth = timeHierarchy?.levels.length || 0;

        /**
         * Calculate Layout
         */
        const crossSpaceBetweenCards = isHorizontal ? verticalSpaceBetweenCards : horizontalSpaceBetweenCards;
        // The along-axis counterpart to crossSpaceBetweenCards: without it, timeSegmentsPerCard
        // below would only guarantee cards don't overlap along the timeline, not that they keep
        // any breathing room - unlike the cross axis, which always adds this gap on top of the
        // card's own footprint.
        const alongSpaceBetweenCards = isHorizontal ? horizontalSpaceBetweenCards : verticalSpaceBetweenCards;

        // cardWidth, cardHeight and minimumTimeSegmentWidth are independent of each other -
        // each can change on its own (e.g. once these become mod properties) without the
        // others needing to move in lockstep. defaultCardBaseSize is just a shared building
        // block behind today's fontSize-derived defaults, not a dependency between them.
        const defaultCardBaseSize = 3.2 * (fontSize * 4);
        // Card size is pinned to a fixed value rather than to the live timeSegmentSize
        // computed below, which can grow arbitrarily large: a short timeline with only a
        // handful of segments would otherwise stretch freeTimeSegmentSize - and with it the
        // cards - well past a readable size. Segments themselves are still free to grow past
        // the card's own size for breathing room; only the card box stays fixed.
        const cardWidth = defaultCardBaseSize;
        const cardHeight = (defaultCardBaseSize + horizontalSpaceBetweenCards) / 2 - verticalSpaceBetweenCards;
        // The floor timeSegmentSize is never allowed to shrink past - see freeTimeSegmentSize
        // below.
        const minimumTimeSegmentWidth = (defaultCardBaseSize + horizontalSpaceBetweenCards) / 2;

        // The card's fixed rendered box (cardWidth x cardHeight) never rotates - text must
        // stay upright in both modes - but which of its two dimensions plays the "along the
        // timeline" role (spacing/collision) vs the "across/stacking" role swaps by orientation.
        const alongCardExtent = isHorizontal ? cardWidth : cardHeight;
        const crossCardExtent = isHorizontal ? cardHeight : cardWidth;
        // The actual reserved space at each edge of the content for a card centered on the
        // first/last segment to spill into - exactly half the along-axis card size.
        const edgeMargin = alongCardExtent / 2;

        // However much of mainSize, after reserving edgeMargin on both ends, each of the N
        // segments gets. Still floored at minimumTimeSegmentWidth so a crowded timeline never
        // squeezes segment spacing tighter than that, falling back to scrolling instead (see
        // needsScroll below).
        const freeTimeSegmentSize =
            timeLeaves.length > 0 ? (mainSize - 2 * edgeMargin) / timeLeaves.length : minimumTimeSegmentWidth;
        let timeSegmentSize = Math.max(minimumTimeSegmentWidth, freeTimeSegmentSize);

        // The minimum along-axis distance balancedLaneLayout enforces between two cards
        // sharing a lane, in the same units its timePosition uses (1.0 = one leaf) - the
        // card's own footprint (derived from its real pixel size and the segment size
        // actually in effect this render, rather than assumed to be a fixed round number)
        // plus alongSpaceBetweenCards, so cards on the same lane keep the same breathing
        // room the cross axis already guarantees instead of merely touching edge-to-edge.
        // Now that cardWidth/cardHeight no longer have to track timeSegmentSize, a card can
        // genuinely span more than its immediate neighbor's worth of segments (a wide card
        // in horizontal mode, or - once cardHeight varies independently - a tall one in
        // vertical mode); this ratio is what lets the lane-assignment loop in
        // balancedLaneLayout.ts pick that up without any change to that algorithm itself.
        const timeSegmentsPerCard = (alongCardExtent + alongSpaceBetweenCards) / timeSegmentSize;
        // No longer trimmed for the scrollbar - like Spotfire's own native visualizations,
        // the scrollbar (see #scrollBar's z-index in main.css) floats on top of the drawing
        // area on hover rather than claiming permanent dead space beside it. It's already
        // positioned against the true crossSize edge (see the timelineScrollBar.update call
        // below), so content can now use that space right up to the same edge.
        const drawingAreaCrossSize = crossSize;
        const timelineCrossExtent = timelineLevelHeight * timeHierarchyDepth;
        // Centered within the drawing area, not the raw window - the two now coincide since
        // the scrollbar floats rather than being trimmed out of crossSize (see above).
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
        if (scrollAnchor != null) {
            scrollValue = resolveScrollValueFromAnchor(scrollAnchor);
        }
        // Lower-bounded, not just clamped to maxScrollValue: resolveScrollValueFromAnchor
        // can return a negative value (centerIndex - half the viewport, when the matched
        // node's own range starts close to - or, on a total match failure, right at - leaf
        // 0). An unclamped negative scrollValue produces a positive CSS translate (content
        // pushed right, away from the left edge) while the scrollbar's handle position
        // clips to its own track start - two different-looking but equally wrong visuals
        // driven by the same out-of-range number, only resolved once the user's own
        // interaction feeds a properly bounded value through onScrollValueChanged.
        scrollValue = Math.max(0, Math.min(scrollValue, maxScrollValue));
        captureScrollAnchor(scrollValue);

        let cards: Card[] = [];

        timeLeaves.forEach((node: DataViewHierarchyNode) => {
            node.rows().forEach((row: DataViewRow) => {
                if (hasEventAxis && row.categorical(eventAxisName).formattedValue() != "") {
                    cards.push({
                        description: hasEventAxis ? row.categorical(eventAxisName).formattedValue() : "",
                        verticalPosition: 0,
                        cardSpacing: 0,
                        offScreen: false,
                        timePosition: row.categorical(timeAxisName).leafIndex,
                        color: row.color(),
                        row: row
                    });
                }
            });
        });

        // Shuffle cards on top of each other to fit across the stacking axis, within
        // drawingAreaCrossSize - currently just crossSize (see its declaration above: the
        // scrollbar floats on top rather than reserving a permanent strip), but named
        // separately so lane-fitting keeps working unchanged if that ever stops being true.
        // "middle" alignment splits lanes across 2 groups (see laneInfo); "start"/"end" put
        // every lane in a single group.
        const numAlignmentGroups = cardAlignment === "middle" ? 2 : 1;
        // "Dense" lets cards overlap down to roughly one line of card text - .card has no
        // explicit line-height (browser default, ~1.15-1.2x font size), so this is a
        // deliberately approximate floor, not a measurement of actual rendered text. See
        // LayoutContext.minVisibleCrossExtent. "Spacious" passes a value balancedLaneLayout
        // clamps down to its own natural (non-overlapping) pitch - Infinity rather than
        // duplicating that pitch formula here.
        const minVisibleCrossExtent = cardDensity === "spacious" ? Infinity : fontSize * 1.4;
        const cardLayout = balancedLaneLayout(cards, drawingAreaAlongSize, drawingAreaCrossSize, timeLineCrossPos, {
            timeSegmentsPerCard,
            crossCardExtent,
            crossSpaceBetweenCards,
            numAlignmentGroups,
            timelineCrossExtent,
            minVisibleCrossExtent,
            outerEdgeMargin: cardShadowBleed
        });
        cards.forEach((card, i) => {
            card.verticalPosition = cardLayout[i].verticalPosition;
            card.cardSpacing = cardLayout[i].cardSpacing;
            card.offScreen = cardLayout[i].offScreen;
        });

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
        settingsButton.update({
            uiChromeColor,
            backgroundColor: context.styling.general.backgroundColor,
            windowSize,
            modMargin,
            orientation,
            cardAlignment,
            cardDensity
        });
        updateSettingsButtonVisibility();

        // #mod-container has no CSS height of its own - it auto-sizes to its normal-flow
        // content, which is just drawingLayer (shorter than availableSize.height). The
        // scrollbar, positioned near the true bottom of the mod, would then render outside
        // mod-container's own box, so hovering it would count as a mouseleave on the
        // container it's meant to be part of. Size it explicitly to the full available area -
        // availableSize, not the raw windowSize, since #mod-container's CSS margin (main.css)
        // already claims modMargin on each side; sizing it to the full windowSize on top of
        // that margin would push it past body's own (unmargined) edges and get sliced off by
        // body's overflow:hidden - the same failure mode the body-margin fix earlier caught.
        modContainer.style("width", `${availableSize.width}px`).style("height", `${availableSize.height}px`);

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
            length: mainSize,
            crossSize,
            orientation,
            // Total content extent in the same timeSegmentSize-normalized units as scrollValue
            // (drawingAreaAlongSize / timeSegmentSize) - used only for the handle's proportional
            // extent (extent / totalItems), not for its position, so it's independent of
            // whatever that extent ends up clamped to.
            totalItems: maxScrollValue + visibleTimeSegments,
            value: scrollValue,
            maxValue: maxScrollValue,
            extent: visibleTimeSegments,
            // Unlike the settings button, the scrollbar aims for Spotfire's own native,
            // theme-independent muted look rather than "interactive toolbar chrome" -
            // see scrollBarColor's declaration for why. Spotfire's native toolbars/scrollbar
            // are opaque (with their own thin light-gray border, set directly in main.css),
            // not see-through - it just reads as subtle because the border/thumb tones are
            // both so light, not because anything is transparent.
            color: scrollBarColor,
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
         * screen on each side), not for the whole dataset. This is what makes it safe to
         * drop the old row/time-segment caps - the DOM node count stays bounded by the
         * viewport size regardless of how much data is behind it. cards and
         * displayHierarchy themselves are still built from the full dataset every render
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

            // Connectors

            connectorContainer
                .selectAll<HTMLDivElement, Card>(".connector")
                .data(visibleCards, (d: Card) => d.row.elementId(true))
                .join("div")
                .attr("class", "connector")
                .style(alongProp, (d) => `${edgeMargin + d.timePosition * timeSegmentSize + timeSegmentSize / 2}px`)
                .style(alongSizeProp, "2px")
                .style(crossProp, (d) => `${calcConnectorCrossPos(d)}px`)
                .style(crossSizeProp, (d) => `${calcConnectorCrossExtent(d)}px`);

            // Cards
            //
            // Filtered further than visibleCards (which only bounds the along axis): a
            // dense cluster can pack far more events into a time window than lanes fit in
            // the cross axis, and those excess events are all still inside the along-axis
            // window - without this, a cluster like the "Cluster stress test" datasets
            // would join thousands of full cards (flexbox layout, text, hover listeners)
            // into the DOM only for all but a handful to render nothing, clipped by
            // #drawingLayer's overflow:hidden. card.offScreen (from LayoutResult) is the
            // layout algorithm's own record of which events it gave up finding a real lane
            // for, so this filter doesn't need to re-derive unreachability from cardSpacing
            // and pixel geometry itself - it's a performance pre-filter, not the source of
            // correctness, which is still CSS overflow:hidden.
            // Connectors stay on the unfiltered visibleCards - they're cheap (no text, no
            // listeners) and, per calcConnectorCrossPos, a connector for an off-screen card
            // always shows a real sliver reaching in from the timeline regardless of lane
            // depth, which is the point: it's the signal that something exists there even
            // once its card is out of reach.
            //
            // Sorted by lane (verticalPosition) so higher lanes - which sit further from
            // the timeline, per calculateCardCrossPos - join the DOM later and so paint on
            // top of the lower lanes they overlap in dense mode: a consistent stacking order
            // (further-out cards always on top) rather than whatever order the data happens
            // to produce.
            let visibleCardsInCrossAxis = visibleCards
                .filter((c: Card) => !c.offScreen)
                .sort((a, b) => a.verticalPosition - b.verticalPosition);

            cardContainer
                .selectAll<HTMLDivElement, Card>(".card")
                .data(visibleCardsInCrossAxis, (d: Card) => d.row.elementId(true))
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
                })
                .on("mouseleave", () => {
                    mod.controls.tooltip.hide();
                })
                .text((d) => `${d.description}`)
                .style(alongProp, (d: Card) => `${calculateCardAlongPos(d)}px`)
                .style(crossProp, (d: Card) => `${calculateCardCrossPos(d)}px`)
                .style("height", `${cardHeight}px`)
                .style("width", `${cardWidth}px`)
                .style("background-color", (d) => `${d.color.hexCode}`)
                .style("color", (d: Card) => `${contrastColor(d.color.hexCode)}`);

            // marked cards on top
            cardContainer
                .selectAll<HTMLDivElement, Card>(".card")
                .filter((d: Card) => d.row.isMarked())
                .raise();

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
                .classed(
                    isHorizontal ? "timeMarker-left" : "timeMarker-top",
                    (d: HierarchyRectangularNode<DataViewHierarchyNode>) => d.x0 == 0
                )
                .classed(
                    isHorizontal ? "timeMarker-top" : "timeMarker-left",
                    (d: HierarchyRectangularNode<DataViewHierarchyNode>) => displayLevel(d) == 0
                )
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
            captureScrollAnchor(scrollValue);
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
                    cancelAutoScroll();
                }
            }
        }

        function scroll() {
            if (autoScroll && scrollValue < maxScrollValue) {
                // Advance by roughly one pixel per tick, matching the previous native-scroll speed.
                scrollValue = Math.min(maxScrollValue, scrollValue + 1 / timeSegmentSize);
                captureScrollAnchor(scrollValue);
                timelineScrollBar.setValue(scrollValue);
                applyScrollTransform();
                renderVisibleWindow();
                activeScrollTimeoutId = setTimeout(scroll, autoScrollSpeed);
            } else {
                cancelAutoScroll();
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
                .style("left", `${selection.x2 > selection.x1 ? selection.x1 : selection.x2}px`)
                .style("top", `${selection.y2 > selection.y1 ? selection.y1 : selection.y2}px`)
                .style("width", `${Math.abs(selection.x2 - selection.x1)}px`)
                .style("height", `${Math.abs(selection.y2 - selection.y1)}px`);
        }

        function resetMarkingOverlay() {
            markingOverlay
                .style("left", "0px")
                .style("top", "0px")
                .style("width", "0px")
                .style("height", "0px")
                .attr("class", "inactiveMarking");
        }

        function mouseUpHandler(event: MouseEvent) {
            finishDrag(event);
        }

        function finishDrag(event: MouseEvent) {
            resetMarkingOverlay();

            // Below clickDragTolerancePx, treat this as a click rather than a rectangle-
            // marking gesture. A real rectangle drag should mark every card whose (invisible)
            // bounding box the rectangle touches, even ones fully hidden under another card in
            // dense mode - that's the point of dragging a rectangle. A click landing on a
            // stack of overlapping cards should only mark the one actually visible on top,
            // matching what the user sees and clicked on, rather than every card stacked
            // underneath it too.
            if (
                Math.abs(selection.x2 - selection.x1) <= clickDragTolerancePx &&
                Math.abs(selection.y2 - selection.y1) <= clickDragTolerancePx
            ) {
                let topCardNode = (event.target as HTMLElement)?.closest<HTMLElement>(".card");
                if (topCardNode) {
                    (select<HTMLElement, Card>(topCardNode).datum() as Card).row.mark(
                        event.ctrlKey || event.metaKey ? "ToggleOrAdd" : "Replace"
                    );
                    event.stopPropagation();
                } else if (!(event.ctrlKey || event.metaKey)) {
                    dataView.clearMarking();
                }
                detachDragHandlers();
                return;
            }

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

        function calculateCardAlongPos(d: Card) {
            return edgeMargin + d.timePosition * timeSegmentSize - alongCardExtent / 2 + timeSegmentSize / 2;
        }

        // In "middle" alignment cards alternate between two groups - before the timeline (0)
        // and after it (1) along the cross axis - stacking outward from the timeline in lanes
        // within their group. In "start"/"end" alignment all cards share a single group (the
        // one on the side opposite the edge-anchored timeline - see timeLineCrossPos above),
        // each taking its own lane rather than halving them across two groups.
        function laneInfo(verticalPosition: number) {
            if (cardAlignment === "start") return { group: 1, lane: verticalPosition };
            if (cardAlignment === "end") return { group: 0, lane: verticalPosition };
            return { group: verticalPosition % 2, lane: Math.floor(verticalPosition / 2) };
        }

        function calcConnectorCrossExtent(d: Card) {
            let { group, lane } = laneInfo(d.verticalPosition);
            let cardSpacing = d.cardSpacing;

            switch (group) {
                case 0:
                    return lane * cardSpacing + crossSpaceBetweenCards;
                case 1:
                default:
                    return crossSpaceBetweenCards + lane * cardSpacing - 3;
            }
        }

        function calcConnectorCrossPos(d: Card) {
            let { group, lane } = laneInfo(d.verticalPosition);
            let cardSpacing = d.cardSpacing;

            switch (group) {
                case 0:
                    return timeLineCrossPos - crossSpaceBetweenCards - lane * cardSpacing;
                case 1:
                default:
                    return timeLineCrossPos + timelineLevelHeight * timeHierarchyDepth + 3;
            }
        }

        function calculateCardCrossPos(d: Card) {
            let { group, lane } = laneInfo(d.verticalPosition);
            let cardSpacing = d.cardSpacing;

            switch (group) {
                case 0:
                    return timeLineCrossPos - crossSpaceBetweenCards - lane * cardSpacing - crossCardExtent;
                case 1:
                default:
                    return (
                        timeLineCrossPos +
                        timelineLevelHeight * timeHierarchyDepth +
                        lane * cardSpacing +
                        crossSpaceBetweenCards
                    );
            }
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
