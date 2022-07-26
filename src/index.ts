import { DataView, DataViewRow, DataViewHierarchyNode, DataViewColorInfo } from "spotfire-api";
import { getLuminance } from "polished";
import * as d3 from "d3";

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
    maxTimeSegments = 2000,
    maxRowCount = 2000;

/**
 * Set up drawing layers
 */
const modContainer = d3.select("#mod-container");

let selection: Rect = { x1: 0, y1: 0, x2: 0, y2: 0 };

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
    let autoScroll = false;
    let autoScrollSpeed = 5;

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
     * Clears the DOM.
     */
    function clear() {
        modContainer.selectAll("*").remove();
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

        // Bailout if there is more data than we can gracefully render.
        if (rowCount > maxRowCount) {
            bailout(`Sorry. There is currently too much data. This visualization cannot handle more than ${maxRowCount} rows,
            and there are currently ${rowCount} of them. Try filtering or change the configuration.`);
            return;
        }

        let hasTimeAxisa = !!(await dataView.categoricalAxis(timeAxisName));

        if (!hasTimeAxisa) {
            bailout(`Select a time axis`);
            return;
        }

        let hasEventAxis = !!(await dataView.categoricalAxis(eventAxisName));

        if (!hasEventAxis) {
            bailout(`Select an event axis`);
            return;
        }

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

        if (timeLeaves.length > maxTimeSegments) {
            bailout(`Sorry. There is currently too many time segments. This visualization cannot handle more than ${maxTimeSegments} time segments,
            and there are currently ${timeLeaves.length} of them. Try filtering or change the configuration.`);
            return;
        }

        let timeHierarchyDepth = timeHierarchy?.levels.length || 0;
        let hierarchyRoot = await timeHierarchy?.root();
        if (!hierarchyRoot) return;

        /**
         * Calculate Layout
         */
        let timeMarkerWidth = (windowSize.width - timeSegmentMargin * 2) / timeLeaves.length;
        timeMarkerWidth = timeMarkerWidth >= minimumTimeSegmentWidth ? timeMarkerWidth : minimumTimeSegmentWidth;
        const timeSegmentsPerCard = Math.ceil((cardWidth + horizontalSpaceBetweenCards) / timeMarkerWidth);
        const timeLineTop = windowSize.height / 2 - (timelineLevelHeight * timeHierarchyDepth) / 2;
        const drawingAreaHeight = windowSize.height - 35;
        const drawingAreaWidth = timeLeaves.length * timeMarkerWidth + timeSegmentMargin * 2 - 10;
        const timelineWidth = timeLeaves.length * timeMarkerWidth;
        const timelineHeight = (timeHierarchyDepth + 1) * timelineLevelHeight;

        let cards: Card[] = [];
        let lastPosition = new Map();
        let maxStackedCards = 0;

        timeLeaves.forEach((node: DataViewHierarchyNode) => {
            node.rows().forEach((row: DataViewRow) => {
                if (row.categorical(eventAxisName).formattedValue() != "") {
                    let index = row.categorical(timeAxisName).leafIndex;
                    let vp = 0;

                    while (lastPosition.get(vp) != undefined && index - lastPosition.get(vp) < timeSegmentsPerCard) {
                        vp++;
                    }
                    lastPosition.set(vp, index);
                    maxStackedCards = vp + 1 > maxStackedCards ? vp + 1 : maxStackedCards;

                    cards.push({
                        title: "",
                        description: row.categorical(eventAxisName).formattedValue(),
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
        let connectorContainer = drawingLayer
            .selectAll("#connectors")
            .data([null])
            .join("div")
            .attr("id", "connectors");
        let cardContainer = drawingLayer.selectAll("#cards").data([null]).join("div").attr("id", "cards");
        let timeline = drawingLayer
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

        // Drawing Layer
        drawingLayer
            .style("left", `${0}`)
            .style("top", `${0}`)
            .style("height", `${drawingAreaHeight}`)
            .style("width", `${drawingAreaWidth}`)
            .on("mousedown", mouseDownHandler)
            .on("dblclick", doubleclickHandler);

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
            let currentScroll = document.body.scrollLeft;
            if (autoScroll && currentScroll < timelineWidth - windowSize.width) {
                document.body.scrollLeft = currentScroll + 1;
                setTimeout(scroll, autoScrollSpeed);
            }
        }

        //  Connectors

        connectorContainer
            .selectAll<HTMLDivElement, Card>(".connector")
            .data(displayCards, (d: Card) => d.row.elementId(true))
            .join("div")
            .attr("class", "connector")
            .style("left", (d) => `${timeSegmentMargin + d.timePosition * timeMarkerWidth + timeMarkerWidth / 2}px`)
            .style("top", (d) => `${calcConnectorTop(d.verticalPosition)}px`)
            .style("height", (d) => `${calcConnectorHeight(d)}px`);

        // Cards

        cardContainer
            .selectAll<HTMLDivElement, Card>(".card")
            .data(cards, (d: Card) => d.row.elementId(true))
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

        // Timeline

        timeline
            .style("left", (d) => timeSegmentMargin)
            .style("top", (d) => timeLineTop)
            .style("width", (d) => timeLeaves.length * timeMarkerWidth + 2)
            .style("height", (d) => timelineLevelHeight * timeHierarchyDepth + 2);

        // create a d3 hierarchy with the width of each timesegment proportional to the number of descendants
        let hierarchy: d3.HierarchyNode<DataViewHierarchyNode> = d3.hierarchy(hierarchyRoot);
        hierarchy.sum((d: DataViewHierarchyNode) => (!d?.children && 1) || 0);

        let partition = d3.partition().size([timelineWidth, timelineHeight]).padding(0).round(false);
        let partitionedHierarchy: d3.HierarchyRectangularNode<DataViewHierarchyNode> = partition(
            hierarchy
        ) as d3.HierarchyRectangularNode<DataViewHierarchyNode>;

        // remove the root node from the displayed hierarchy
        let displayHierarchy = partitionedHierarchy
            .descendants()
            .filter((d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.parent);

        timeline
            .selectAll(".timeMarker")
            .data(displayHierarchy)
            .join("div")
            .attr("class", "timeMarker")
            .classed("timeMarker-left", (d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.x0 == 0)
            .classed("timeMarker-top", (d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.data.level == 0)
            .on("click", (e, d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => {
                d.data.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace");
                e.stopPropagation();
            })
            .text((d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.data.formattedValue())
            .style("left", (d) => d.x0)
            .style("width", (d) => d.x1 - d.x0 - 5)
            .style("top", (d) => d.y0 - timelineLevelHeight)
            .style("height", (d) => d.y1 - d.y0);

        context.signalRenderComplete();

        /**
         * Inline helper functions
         */

        function mouseDownHandler(event: MouseEvent) {
            let scrollLeft = document.body.scrollLeft;
            let scrollTop = document.body.scrollTop;
            selection = {
                x1: event.clientX + scrollLeft,
                y1: event.clientY + scrollTop,
                x2: event.clientX + scrollLeft,
                y2: event.clientY + scrollTop
            };
            document.addEventListener("mousemove", mouseMoveHandler);
            document.addEventListener("mouseup", mouseUpHandler);
        }

        function mouseMoveHandler(event: MouseEvent) {
            let scrollLeft = document.body.scrollLeft;
            let scrollTop = document.body.scrollTop;
            selection.x2 = event.clientX + scrollLeft;
            selection.y2 = event.clientY + scrollTop;

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

            let selectedCards = cardContainer.selectAll<HTMLDivElement, Card>(".card").filter((c: Card) => {
                let x1 = calculateCardLeft(c);
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

            document.removeEventListener("mousemove", mouseMoveHandler);
            document.removeEventListener("mouseup", mouseUpHandler);
        }

        function calculateCardLeft(d: Card) {
            return timeSegmentMargin + d.timePosition * timeMarkerWidth - cardWidth / 2 + timeMarkerWidth / 2;
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

function contrastColor(hexCode: string): string {
    let L = getLuminance(hexCode);

    if ((L + 0.05) / (0.0 + 0.05) > (1.0 + 0.05) / (L + 0.05)) {
        return "#000000";
    } else {
        return "#ffffff";
    }
}
