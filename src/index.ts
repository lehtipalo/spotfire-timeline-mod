import { DataView, DataViewRow, DataViewHierarchyNode } from "spotfire-api";
import { getLuminance } from "polished";
import * as d3 from "d3";

const Spotfire = window.Spotfire;
const DEBUG = false;

const timeAxisName = "Time";
const descriptionAxisName = "Description";
const minimumTimeMarkerWidth = 50;
const timeMarkermargin = 50;
const timelineHeight = 25;
const spacing = 25;
const cardWidth = 150;
const cardHeight = 100;
const spaceBetweenCards = 50;
const maxTimeSegments = 2000;

Spotfire.initialize(async (mod) => {
    /**
     * Initialize render context - should show 'busy' cursor.
     * A necessary step for printing (another step is calling render complete)
     */
    const context = mod.getRenderContext();

    const reader = mod.createReader(mod.visualization.data(), mod.windowSize());

    reader.subscribe(generalErrorHandler(mod)(onChange), (err) => {
        mod.controls.errorOverlay.show(err);
    });

    const modContainer = d3.select("#mod-container");

    async function onChange(dataView: DataView, windowSize: Spotfire.Size) {
        const hasTime = !!(await dataView.categoricalAxis(timeAxisName));
        const hasDescription = !!(await dataView.categoricalAxis(descriptionAxisName));

        if (!hasTime) {
            modContainer.selectAll("*").remove();
            return;
        }

        let timeLeaves = (await (await dataView.hierarchy(timeAxisName))?.root())?.leaves() || [];

        if (timeLeaves.length > maxTimeSegments) {
            modContainer.selectAll("*").remove();
            return;
        }

        let timeHierarchy = await dataView.hierarchy(timeAxisName);
        let timeHierarchyDepth = timeHierarchy?.levels.length || 0;
        let hierarchyRoot = await timeHierarchy?.root();
        if (!hierarchyRoot) return;

        let rows = (await dataView.allRows()) || [];
        let displayRows = rows.filter((row:DataViewRow) => row.categorical(descriptionAxisName).formattedValue() != "")

        let timeMarketWidth = (windowSize.width - timeMarkermargin * 2) / timeLeaves.length;
        let timeMarkerWidth = timeMarketWidth < minimumTimeMarkerWidth ? minimumTimeMarkerWidth : timeMarketWidth;
        let cardsPerTimeSegment = Math.ceil((cardWidth + spaceBetweenCards) / timeMarkerWidth);

        let timeLineTop =
            cardsPerTimeSegment > 1
                ? windowSize.height / 2 - timelineHeight*timeHierarchyDepth / 2
                : (2 * windowSize.height) / 3 - timelineHeight*timeHierarchyDepth / 2;

        // Update mod display

        let timeline = modContainer
            .selectAll(".timeline")
            .data([null])
            .join("div")
            .attr("class", "timeline")
            .attr(
                "style",
                (d, i) => `
                    left:${0}px;
                    top:${timeLineTop}px; 
                    width:${timeMarkermargin * 2 + timeLeaves.length * timeMarkerWidth}px;
                    height:${timelineHeight*timeHierarchyDepth+4}px;
                    `
            );
    
        let hierarchy: d3.HierarchyNode<DataViewHierarchyNode> = d3.hierarchy(hierarchyRoot);
        hierarchy.sum((d: DataViewHierarchyNode) => (!d?.children && 1) || 0);
    
        let partition = d3.partition().size([timeLeaves.length*timeMarkerWidth, (timeHierarchyDepth+1)*timelineHeight]).padding(0).round(false);
        let partitionedHierarchy: d3.HierarchyRectangularNode<DataViewHierarchyNode> = partition(
            hierarchy
        ) as d3.HierarchyRectangularNode<DataViewHierarchyNode>;

        let displayHierarchy = partitionedHierarchy
            .descendants()
         .filter((d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.parent);
            
        timeline
            .selectAll(".timeMarker")
            .data(displayHierarchy)
            .join("div")
            .attr("class", "timeMarker")
            .on("click", (e, d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.data.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace"))
            .text((d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.data.formattedValue())
            .classed("timeMarker-marked",(d:d3.HierarchyRectangularNode<DataViewHierarchyNode>,i) => d.data.markedRowCount() == d.data.rowCount())
            .attr(
                "style",
                (d: d3.HierarchyRectangularNode<DataViewHierarchyNode>, i) => `
            left:${timeMarkermargin+d.x0}px; 
            width:${(d.x1-d.x0)}px;
            top:${d.y0-timelineHeight}px;
            height:${d.y1-d.y0}px
            `
            );

        modContainer
            .selectAll(".connector")
            .data(displayRows)
            .join("div")
            .attr("class", "connector")
            .attr("style", (d: DataViewRow, i) => {
                let left =
                    timeMarkermargin + d.categorical(timeAxisName).leafIndex * timeMarkerWidth + timeMarkerWidth / 2;
                let top = timeLineTop;
                let height = 0;

                switch (d.categorical(timeAxisName).leafIndex % cardsPerTimeSegment) {
                    case 0:
                        top = top - spacing;
                        height = spacing;
                        break;
                    case 1:
                        top = top + timelineHeight*timeHierarchyDepth;
                        height = spacing;
                        break;
                    case 2:
                        top = top - cardHeight - spacing*2;
                        height = cardHeight + spacing * 2;
                        break;
                    case 3:
                        top = top + timelineHeight*timeHierarchyDepth;
                        height = spacing * 2 + cardHeight;
                        break;
                }

                return `
            left:${left}px; 
            top:${top}px;
            height:${height}px;
            width:${2}px
            `;
            });

        modContainer
            .selectAll(".card")
            .data(displayRows)
            .join("div")
            .attr("class", "card")
            .on("click", (e, d) => {
                d.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace");
            })
            .html((d) => {
                let s = `
            ${hasDescription ? d.categorical(descriptionAxisName).formattedValue() : ""}
            `;
                return s;
            })
            .attr("style", (d: DataViewRow, i) => {
                let left =
                    timeMarkermargin +
                    d.categorical(timeAxisName).leafIndex * timeMarkerWidth -
                    cardWidth / 2 +
                    timeMarkerWidth / 2;
                let top = timeLineTop;

                switch (d.categorical(timeAxisName).leafIndex % cardsPerTimeSegment) {
                    case 0:
                        top = top - cardHeight - spacing;
                        break;
                    case 1:
                        top = top + timelineHeight*timeHierarchyDepth+spacing;
                        break;
                    case 2:
                        top = top - cardHeight * 2 - spacing * 2;
                        break;
                    case 3:
                        top = top + timelineHeight*timeHierarchyDepth+cardHeight + spacing*2;
                        break;
                }

                return `
            left:${left}px; 
            top:${top}px;
            background-color: ${d.color().hexCode};
            color: ${contrastColor(d.color().hexCode)};
            `;
            });

        context.signalRenderComplete();
    }
});

/**
 * subscribe callback wrapper with general error handling, row count check and an early return when the data has become invalid while fetching it.
 *
 * The only requirement is that the dataview is the first argument.
 * @param mod - The mod API, used to show error messages.
 * @param rowLimit - Optional row limit.
 */
export function generalErrorHandler<T extends (dataView: Spotfire.DataView, ...args: any) => any>(
    mod: Spotfire.Mod,
    rowLimit = 2000
): (a: T) => T {
    return function (callback: T) {
        return async function callbackWrapper(dataView: Spotfire.DataView, ...args: any) {
            try {
                const errors = await dataView.getErrors();
                if (errors.length > 0) {
                    mod.controls.errorOverlay.show(errors, "DataView");
                    return;
                }
                mod.controls.errorOverlay.hide("DataView");

                /**
                 * Hard abort if row count exceeds an arbitrary selected limit
                 */
                const rowCount = await dataView.rowCount();
                if (rowCount && rowCount > rowLimit) {
                    mod.controls.errorOverlay.show(
                        `☹️ Cannot render - too many rows (rowCount: ${rowCount}, limit: ${rowLimit}) `,
                        "General"
                    );
                    return;
                }

                /**
                 * User interaction while rows were fetched. Return early and respond to next subscribe callback.
                 */
                const allRows = await dataView.allRows();
                if (allRows == null) {
                    return;
                }

                await callback(dataView, ...args);

                mod.controls.errorOverlay.hide("General");
            } catch (e) {
                if (e instanceof Error) {
                    mod.controls.errorOverlay.show(e.message, "General");

                    if (DEBUG) {
                        throw e;
                    }
                }
            }
        } as T;
    };
}

function contrastColor(hexCode: string): string {
    let L = getLuminance(hexCode);

    if ((L + 0.05) / (0.0 + 0.05) > (1.0 + 0.05) / (L + 0.05)) {
        return "#000000";
    } else {
        return "#ffffff";
    }
}
