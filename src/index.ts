import { DataView, DataViewRow, DataViewHierarchyNode, DataViewColorInfo } from "spotfire-api";
import { select } from "d3-selection";
import { hierarchy, partition, HierarchyNode, HierarchyRectangularNode } from "d3-hierarchy";
import { scrollBarControl } from "./scrollBarControl";

interface Card {
    timePosition: number;
    verticalPosition: number;
    title: string;
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
    rowsPerCard = 2,
    scrollBarHeight = 16;

/**
 * Set up drawing layers
 */
const modContainer = select("#mod-container");
const timelineScrollBar = scrollBarControl(modContainer);

let selection: Rect = { x1: 0, y1: 0, x2: 0, y2: 0 };

// Tracks the mousemove/mouseup listeners of an in-progress drag selection so a stale
// drag from a previous render (with rows belonging to an already disposed DataView)
// can be cancelled when a new render arrives before the user releases the mouse.
let activeMouseMoveHandler: ((event: MouseEvent) => void) | null = null;
let activeMouseUpHandler: ((event: MouseEvent) => void) | null = null;

function detachDragHandlers() {
    if (activeMouseMoveHandler) {
        document.removeEventListener("mousemove", activeMouseMoveHandler);
        activeMouseMoveHandler = null;
    }
    if (activeMouseUpHandler) {
        document.removeEventListener("mouseup", activeMouseUpHandler);
        activeMouseUpHandler = null;
    }
}

window.Spotfire.initialize(async (mod) => {
    /**
     * Initialize render context - should show 'busy' cursor.
     * A necessary step for printing (another step is calling render complete)
     */
    const context = mod.getRenderContext();

    let fontSize = parseInt(context.styling.general.font.fontSize.toString()); // workaround bug in Spotfire 11.4 where fontSize returns string

    let cardHeight = fontSize * rowsPerCard * 1.5;
    let timelineLevelHeight = fontSize * 2;
    let minimumTimeSegmentWidth = fontSize * 4;
    let cardWidth = 3.2 * minimumTimeSegmentWidth;
    let timeSegmentMargin = cardWidth / 2;
    // The actual reserved space at each edge of the content for a card centered on the
    // first/last segment to spill into. Trimmed by 10px from timeSegmentMargin so the left
    // and right edges end up visually equal - drawingAreaWidth used to only apply this trim
    // on the right (a "- 10" fudge with no corresponding left-side adjustment), leaving the
    // left margin 10px wider than the right.
    let edgeMargin = timeSegmentMargin - 10;
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

    modContainer.on("mouseenter", () => {
        isHovering = true;
        updateScrollBarVisibility();
    });
    modContainer.on("mouseleave", () => {
        isHovering = false;
        // Don't fade out mid-drag if the cursor slips past the mod's edge while the user
        // is still holding the handle.
        if (!timelineScrollBar.isHandleBeingDragged()) {
            updateScrollBarVisibility();
        }
    });

    // configfure styling
    document.querySelector("#extra_styling")!.innerHTML = `
    .body { fill: ${context.styling.general.font.color}; font-size: ${context.styling.general.font.fontSize}px; font-weight: ${context.styling.general.font.fontWeight}; font-style: ${context.styling.general.font.fontStyle};}
    .timeMarker {border-color: ${context.styling.scales.line.stroke}} 
    .timeline {border-color: ${context.styling.scales.line.stroke}} 
    .connector {background-color: ${context.styling.scales.line.stroke}}
    `;

    const reader = mod.createReader(mod.visualization.data(), mod.windowSize());

    reader.subscribe(render);

    /**
     * Clears the DOM. Leaves the scrollbar's own DOM in place - it's created once
     * (see scrollBarControl(modContainer) above) and its event handlers are bound to
     * those specific nodes, so removing them here would leave it permanently broken.
     */
    function clear() {
        modContainer
            .selectAll<HTMLElement, unknown>(":scope > *")
            .filter(function () {
                return this.id !== "scrollBar";
            })
            .remove();
        timelineScrollBar.hide();
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

    async function render(dataView: DataView, windowSize: Spotfire.Size) {
        // Cancel any drag selection still in progress from a previous render - its listeners
        // close over rows/DataView from that render, which may now be disposed.
        detachDragHandlers();

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

        let hasTimeAxisa = !!(await dataView.categoricalAxis(timeAxisName));

        if (!hasTimeAxisa) {
            bailout(`Select a time axis`);
            return;
        }

        let hasEventAxis = !!(await dataView.categoricalAxis(eventAxisName));

        /**
         * Get Data
         */

        let timeHierarchy = await dataView.hierarchy(timeAxisName);
        let timeHiearchyRoot = await timeHierarchy?.root();

        if (timeHiearchyRoot == null) {
            // User interaction caused the data view to expire.
            // Don't clear the mod content here to avoid flickering.
            return;
        }

        let timeLeaves = timeHiearchyRoot.leaves();

        let timeHierarchyDepth = timeHierarchy?.levels.length || 0;
        let hierarchyRoot = await timeHierarchy?.root();
        if (!hierarchyRoot) return;

        /**
         * Calculate Layout
         */
        let timeMarkerWidth = (windowSize.width - edgeMargin * 2) / timeLeaves.length;
        timeMarkerWidth = timeMarkerWidth >= minimumTimeSegmentWidth ? timeMarkerWidth : minimumTimeSegmentWidth;
        const timeSegmentsPerCard = Math.ceil((cardWidth + horizontalSpaceBetweenCards) / timeMarkerWidth);
        const timeLineTop = windowSize.height / 2 - (timelineLevelHeight * timeHierarchyDepth) / 2;
        const drawingAreaHeight = windowSize.height - 35;
        const drawingAreaWidth = timeLeaves.length * timeMarkerWidth + edgeMargin * 2;
        const timelineWidth = timeLeaves.length * timeMarkerWidth;
        const timelineHeight = (timeHierarchyDepth + 1) * timelineLevelHeight;

        // Horizontal scrolling: how many time segments fit in the viewport at once, and how
        // far scrollValue (index of the leftmost visible segment) may go. This is bounded by
        // the full content width (drawingAreaWidth), not just the timeline's own width - cards
        // are much wider than a single time segment and spill into the edgeMargin reserved
        // on each side, so scrolling only far enough to reveal the last *segment*
        // would still leave the last *card* clipped at the viewport edge.
        const visibleTimeSegments = windowSize.width / timeMarkerWidth;
        const maxScrollValue = Math.max(0, (drawingAreaWidth - windowSize.width) / timeMarkerWidth);
        needsScroll = drawingAreaWidth > windowSize.width;
        scrollValue = Math.min(scrollValue, maxScrollValue);

        let cards: Card[] = [];
        let lastPosition = new Map();
        let maxStackedCards = 0;

        timeLeaves.forEach((node: DataViewHierarchyNode) => {
            node.rows().forEach((row: DataViewRow) => {
                if (hasEventAxis && row.categorical(eventAxisName).formattedValue() != "") {
                    let index = row.categorical(timeAxisName).leafIndex;
                    let vp = 0;

                    while (lastPosition.get(vp) != undefined && index - lastPosition.get(vp) < timeSegmentsPerCard) {
                        vp++;
                    }
                    lastPosition.set(vp, index);
                    maxStackedCards = vp + 1 > maxStackedCards ? vp + 1 : maxStackedCards;

                    cards.push({
                        title: "",
                        description: hasEventAxis ? row.categorical(eventAxisName).formattedValue() : "",
                        verticalPosition: vp,
                        timePosition: row.categorical(timeAxisName).leafIndex,
                        color: row.color(),
                        row: row
                    });
                }
            });
        });

        let displayCards = cards.filter((card: Card) => card.description != "");

        // Shuffle cards on top of each other to fit vertically
        let cardSpacing = cardHeight + 4 + verticalSpaceBetweenCards;
        let totalSpaceRequired =
            cardSpacing * (2 * Math.ceil(maxStackedCards / 2)) + timelineLevelHeight * timeHierarchyDepth;
        cardSpacing =
            totalSpaceRequired < windowSize.height
                ? cardSpacing
                : (windowSize.height - timelineLevelHeight * timeHierarchyDepth - (cardHeight + 4) * 2) /
                  (2 * Math.ceil(maxStackedCards / 2));

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
            .select("#markingOverlay")
            .data([null])
            .join("div")
            .attr("id", "markingOverlay")
            .attr("class", "inactiveMarking");

        // #mod-container has no CSS height of its own - it auto-sizes to its normal-flow
        // content, which is just drawingLayer (shorter than windowSize.height). The
        // scrollbar, positioned near the true bottom of the mod, would then render outside
        // mod-container's own box, so hovering it would count as a mouseleave on the
        // container it's meant to be part of. Size it explicitly to the full viewport.
        modContainer.style("width", `${windowSize.width}px`).style("height", `${windowSize.height}px`);

        // Drawing Layer - fixed to the viewport width. scrollContent is the full (possibly
        // wider) content that gets panned horizontally via a CSS transform.
        drawingLayer
            .style("left", `${0}`)
            .style("top", `${0}`)
            .style("height", `${drawingAreaHeight}`)
            .style("width", `${windowSize.width}`)
            .on("mousedown", mouseDownHandler)
            .on("dblclick", doubleclickHandler);

        scrollContent.style("height", `${drawingAreaHeight}`).style("width", `${drawingAreaWidth}`);

        // Timeline

        timeline
            .style("left", (d) => edgeMargin)
            .style("top", (d) => timeLineTop)
            .style("width", (d) => timeLeaves.length * timeMarkerWidth + 2)
            .style("height", (d) => timelineLevelHeight * timeHierarchyDepth + 2);

        // create a d3 hierarchy with the width of each timesegment proportional to the number of descendants
        let hierarchyRootNode: HierarchyNode<DataViewHierarchyNode> = hierarchy(hierarchyRoot);
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

        // Horizontal scrollbar
        timelineScrollBar.update(
            windowSize.width,
            0,
            windowSize.height - scrollBarHeight,
            scrollBarHeight,
            // Total content width in the same timeMarkerWidth-normalized units as scrollValue
            // (drawingAreaWidth / timeMarkerWidth) - used only for the handle's proportional
            // width (extent / totalItems), not for its position, so it's independent of
            // whatever that width ends up clamped to.
            maxScrollValue + visibleTimeSegments,
            scrollValue,
            maxScrollValue,
            visibleTimeSegments,
            context.styling.scales.line.stroke,
            context.styling.general.backgroundColor,
            timeMarkerWidth,
            onScrollValueChanged
        );
        updateScrollBarVisibility();
        timelineScrollBar.render();
        applyScrollTransform();

        /**
         * Virtual scrolling: cards, connectors and time markers are only joined into the DOM
         * for the currently rendered window (viewport + an overscan buffer of one extra
         * screen on each side), not for the whole dataset. This is what makes it safe to
         * drop the old row/time-segment caps - the DOM node count stays bounded by the
         * viewport width regardless of how much data is behind it. cards/displayCards and
         * displayHierarchy themselves are still built from the full dataset every render
         * (needed for correct global card-stacking and proportional time-segment widths),
         * but that's cheap plain-object work, not DOM.
         */
        let renderedRangeStart = Infinity;
        let renderedRangeEnd = -Infinity;

        function renderVisibleWindow() {
            let viewportLeftPx = scrollValue * timeMarkerWidth;
            let viewportRightPx = viewportLeftPx + windowSize.width;

            // Already-rendered window (with its overscan buffer) still covers the viewport -
            // nothing new would come into view, so skip the rejoin entirely.
            if (viewportLeftPx >= renderedRangeStart && viewportRightPx <= renderedRangeEnd) {
                return;
            }

            let overscanPx = windowSize.width;
            renderedRangeStart = Math.max(0, viewportLeftPx - overscanPx);
            renderedRangeEnd = Math.min(drawingAreaWidth, viewportRightPx + overscanPx);

            let visibleCards = displayCards.filter((c: Card) => {
                let x1 = calculateCardLeft(c);
                return x1 + cardWidth >= renderedRangeStart && x1 <= renderedRangeEnd;
            });

            // Connectors

            connectorContainer
                .selectAll<HTMLDivElement, Card>(".connector")
                .data(visibleCards, (d: Card) => d.row.elementId(true))
                .join("div")
                .attr("class", "connector")
                .style(
                    "left",
                    (d) => `${edgeMargin + d.timePosition * timeMarkerWidth + timeMarkerWidth / 2}px`
                )
                .style("top", (d) => `${calcConnectorTop(d.verticalPosition)}px`)
                .style("height", (d) => `${calcConnectorHeight(d)}px`);

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
                .text((d) => `${d.description}`)
                .style("left", (d: Card) => `${calculateCardLeft(d)}px`)
                .style("top", (d: Card) => `${calculateCardTop(d.verticalPosition)}px`)
                .style("height", (d: Card) => `${cardHeight}px`)
                .style("width", (d: Card) => `${cardWidth}px`)
                .style("background-color", (d) => `${d.color.hexCode}`)
                .style("color", (d: Card) => `${contrastColor(d.color.hexCode)}`);

            // marked cards on top
            cardContainer
                .selectAll<HTMLDivElement, Card>(".card")
                .filter((d: Card) => d.row.isMarked())
                .raise();

            // Time markers

            let visibleMarkers = displayHierarchy.filter(
                (d: HierarchyRectangularNode<DataViewHierarchyNode>) =>
                    d.x1 >= renderedRangeStart && d.x0 <= renderedRangeEnd
            );

            timeline
                .selectAll<HTMLDivElement, HierarchyRectangularNode<DataViewHierarchyNode>>(".timeMarker")
                .data(visibleMarkers, (d) => d.data.formattedPath())
                .join("div")
                .attr("class", "timeMarker")
                .classed("timeMarker-left", (d: HierarchyRectangularNode<DataViewHierarchyNode>) => d.x0 == 0)
                .classed("timeMarker-top", (d: HierarchyRectangularNode<DataViewHierarchyNode>) => d.data.level == 0)
                .on("click", (e, d: HierarchyRectangularNode<DataViewHierarchyNode>) => {
                    d.data.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace");
                    e.stopPropagation();
                })
                .text((d: HierarchyRectangularNode<DataViewHierarchyNode>) => d.data.formattedValue())
                .style("left", (d) => d.x0)
                .style("width", (d) => d.x1 - d.x0 - 5)
                .style("top", (d) => d.y0 - timelineLevelHeight)
                .style("height", (d) => d.y1 - d.y0);
        }

        renderVisibleWindow();

        function onScrollValueChanged(newValue: number) {
            scrollValue = newValue;
            applyScrollTransform();
            renderVisibleWindow();
        }

        function applyScrollTransform() {
            let offsetPx = scrollValue * timeMarkerWidth;
            scrollContent.style("transform", `translateX(${-offsetPx}px)`);
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
                scrollValue = Math.min(maxScrollValue, scrollValue + 1 / timeMarkerWidth);
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
            document.addEventListener("mousemove", activeMouseMoveHandler);
            document.addEventListener("mouseup", activeMouseUpHandler);
        }

        function mouseMoveHandler(event: MouseEvent) {
            selection.x2 = event.clientX;
            selection.y2 = event.clientY;

            markingOverlay
                .attr("class", "activeMarking")
                .style("left", `${selection.x2 > selection.x1 ? selection.x1 : selection.x2}`)
                .style("top", `${selection.y2 > selection.y1 ? selection.y1 : selection.y2}`)
                .style("width", `${Math.abs(selection.x2 - selection.x1)}`)
                .style("height", `${Math.abs(selection.y2 - selection.y1)}`);
        }

        function mouseUpHandler(event: MouseEvent) {
            markingOverlay
                .style("left", `${0}`)
                .style("top", `${0}`)
                .style("width", `${0}`)
                .style("height", `${0}`)
                .attr("class", "inactiveMarking");

            // Cards are positioned in scrollContent's content-space; shift by the current
            // scroll offset to compare against the viewport-space selection rect.
            let scrollOffsetPx = scrollValue * timeMarkerWidth;

            let selectedCards = cardContainer.selectAll<HTMLDivElement, Card>(".card").filter((c: Card) => {
                let x1 = calculateCardLeft(c) - scrollOffsetPx;
                let y1 = calculateCardTop(c.verticalPosition);
                let cardRect: Rect = {
                    x1: x1,
                    y1: y1,
                    x2: x1 + cardWidth,
                    y2: y1 + cardHeight
                };

                if (selection.x1 > selection.x2) {
                    [selection.x1, selection.x2] = [selection.x2, selection.x1];
                }
                if (selection.y1 > selection.y2) {
                    [selection.y1, selection.y2] = [selection.y2, selection.y1];
                }

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

        function calculateCardLeft(d: Card) {
            return edgeMargin + d.timePosition * timeMarkerWidth - cardWidth / 2 + timeMarkerWidth / 2;
        }

        function calcConnectorHeight(d: Card) {
            let height = 0;

            let group = d.verticalPosition % 2;
            let lane = Math.floor(d.verticalPosition / 2);

            switch (group) {
                case 0:
                    height = lane * cardSpacing + verticalSpaceBetweenCards;
                    break;
                case 1:
                    height = verticalSpaceBetweenCards + lane * cardSpacing - 3;
                    break;
            }
            return height;
        }

        function calcConnectorTop(verticalPosition: number) {
            let top = timeLineTop;
            let group = verticalPosition % 2;
            let lane = Math.floor(verticalPosition / 2);

            switch (group) {
                case 0:
                    top = top - verticalSpaceBetweenCards - lane * cardSpacing;
                    break;
                case 1:
                    top = top + timelineLevelHeight * timeHierarchyDepth + 3;
                    break;
            }
            return top;
        }

        function calculateCardTop(verticalPosition: number) {
            let top = timeLineTop;
            let group = verticalPosition % 2;
            let lane = Math.floor(verticalPosition / 2);

            switch (group) {
                case 0:
                    top = top - verticalSpaceBetweenCards - lane * cardSpacing - cardHeight;
                    break;
                case 1:
                    top =
                        top + timelineLevelHeight * timeHierarchyDepth + lane * cardSpacing + verticalSpaceBetweenCards;
                    break;
            }
            return top;
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
