import { DataView, DataViewRow, DataViewHierarchyNode, DataViewColorInfo, ModProperty } from "spotfire-api";
import { select } from "d3-selection";
import { hierarchy, partition, HierarchyNode, HierarchyRectangularNode } from "d3-hierarchy";
import { scrollBarControl } from "./scrollBarControl";

export type Orientation = "horizontal" | "vertical";

interface Card {
    timePosition: number;
    verticalPosition: number;
    // Cross-axis lane pitch for this card - see the local-peak search below for how it's
    // derived. Filled in after verticalPosition is assigned.
    cardSpacing: number;
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

        // The card's along-axis dimension is defined below as exactly
        // alongSegmentsPerCard * timeSegmentSize - alongGap, so a card's footprint fills
        // its segment(s) with no spillover into a neighboring one. That makes
        // timeSegmentSize and the card's along-axis size mutually dependent: timeSegmentSize
        // reserves edgeMargin for the card centered on the first/last segment to spill into,
        // and edgeMargin is half that same card size. Solved in closed form rather than
        // iterating to a fixed point:
        //   timeSegmentSize = (mainSize - 2*edgeMargin) / N
        //   edgeMargin = (alongSegmentsPerCard*timeSegmentSize - alongGap) / 2
        //   => timeSegmentSize = (mainSize + alongGap) / (N + alongSegmentsPerCard)
        //
        // cardWidthAtFloor anchors the smallest a time segment is ever allowed to get
        // (minimumTimeSegmentWidth) to the same card width this mod used before card size
        // was tied to segment size, so a fully crowded timeline stays exactly as readable.
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

        let cards: Card[] = [];
        // Tracks, per lane, the time index of the last card placed there - a lane is free
        // again once a new card is far enough past it (>= timeSegmentsPerCard) to guarantee
        // no overlap.
        let lastPosition = new Map();
        // Concurrent-lane count at the moment each card was placed (its own lane index + 1),
        // in card order. Seeds the local-peak search below rather than one peak shared by
        // every card that ever transitively chained together.
        let rawPeakAtInsertion: number[] = [];

        timeLeaves.forEach((node: DataViewHierarchyNode) => {
            node.rows().forEach((row: DataViewRow) => {
                if (hasEventAxis && row.categorical(eventAxisName).formattedValue() != "") {
                    let index = row.categorical(timeAxisName).leafIndex;

                    let vp = 0;
                    while (lastPosition.get(vp) != undefined && index - lastPosition.get(vp) < timeSegmentsPerCard) {
                        vp++;
                    }
                    lastPosition.set(vp, index);
                    rawPeakAtInsertion.push(vp + 1);

                    cards.push({
                        description: hasEventAxis ? row.categorical(eventAxisName).formattedValue() : "",
                        verticalPosition: vp,
                        cardSpacing: 0,
                        timePosition: index,
                        color: row.color(),
                        row: row
                    });
                }
            });
        });

        // Shuffle cards on top of each other to fit across the stacking axis, within the
        // actual visible drawing area (drawingAreaCrossSize), not the raw window - fitting
        // against crossSize would let the bottom/trailing-most row overflow into (and get
        // clipped by) the 35px strip reserved for the scrollbar.
        // "middle" alignment splits lanes across 2 groups (see laneInfo); "start"/"end" put
        // every lane in a single group.
        const numAlignmentGroups = cardAlignment === "middle" ? 2 : 1;
        const naturalCardSpacing = crossCardExtent + 4 + crossSpaceBetweenCards;
        function cardSpacingForPeak(peakLanes: number): number {
            const lanesPerGroup = Math.ceil(peakLanes / numAlignmentGroups);
            const totalSpaceRequired =
                naturalCardSpacing * (numAlignmentGroups * lanesPerGroup) + timelineLevelHeight * timeHierarchyDepth;
            return totalSpaceRequired < drawingAreaCrossSize
                ? naturalCardSpacing
                : (drawingAreaCrossSize -
                      timelineLevelHeight * timeHierarchyDepth -
                      (crossCardExtent + 4) * numAlignmentGroups) /
                      (numAlignmentGroups * lanesPerGroup);
        }
        // Cards only ever need to be told apart from others close enough to actually risk
        // landing near them along the timeline - a crowded pocket elsewhere shouldn't force
        // every other card on the timeline to squeeze together too. So rather than one
        // spacing value shared by an entire transitively-chained run of overlapping cards
        // (which lets one distant pileup compress even the sparse stretches of that run),
        // each card gets its own spacing sized to the worst concurrency found within
        // timeSegmentsPerCard of it in either direction - the same distance already used to
        // test whether two cards can conflict at all. Cards further apart than that can
        // never land close enough to visually collide, so they have no need to agree on a
        // spacing value.
        //
        // Known limit: this is a local approximation, not a global guarantee, in horizontal
        // mode (timeSegmentsPerCard=2) - each card's window only looks 2 segments in either
        // direction from itself, so two cards that directly overlap each other right at the
        // edge of a dense pocket can still end up with slightly different spacing (one
        // card's window reaches deeper into the pocket than the other's does). A true fix
        // would require propagating peaks between directly-overlapping cards to a fixpoint,
        // which degenerates back to whole-run sharing. In practice this shows up rarely,
        // only right at a pocket's boundary, and is far smaller in both frequency and
        // magnitude than the blanket over-compression it replaces. In vertical mode
        // (timeSegmentsPerCard=1) this limit doesn't apply at all: two cards only ever
        // directly overlap when they share the exact same timePosition, in which case both
        // see the identical neighbor set (each other), so this collapses to an exact
        // group-by-timePosition peak with no approximation.
        cards.forEach((card, i) => {
            let peak = rawPeakAtInsertion[i];
            for (let j = i - 1; j >= 0 && card.timePosition - cards[j].timePosition < timeSegmentsPerCard; j--) {
                peak = Math.max(peak, rawPeakAtInsertion[j]);
            }
            for (
                let j = i + 1;
                j < cards.length && cards[j].timePosition - card.timePosition < timeSegmentsPerCard;
                j++
            ) {
                peak = Math.max(peak, rawPeakAtInsertion[j]);
            }
            card.cardSpacing = cardSpacingForPeak(peak);
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
        const settingsButtonSize = 24;
        // A plain top-align collides with Spotfire's floating action button (FAB), which
        // renders in the visualization's top-right corner regardless of the mod's own
        // horizontal/vertical layout orientation - SIP mods deliberately reserve clearance
        // there instead of top-aligning their own config button. The FAB's own container sits
        // at top:16px in this same coordinate space (confirmed via devtools); its buttons are
        // the standard 32px Spotfire action-button size, so this clears its bottom edge
        // (~48px) with a small margin.
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

            cardContainer
                .selectAll<HTMLDivElement, Card>(".card")
                .data(visibleCards, (d: Card) => d.row.elementId(true))
                .join("div")
                .attr("class", "card")
                .attr("draggable", "false")
                .classed("card-marked", (d) => d.row.isMarked())
                .on("click", (e, d) => {
                    d.row.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace");
                    e.stopPropagation();
                })
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
            } else {
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
