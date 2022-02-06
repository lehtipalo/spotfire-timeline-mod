import { DataView, DataViewRow } from "spotfire-api";
import { getLuminance } from "polished";
import * as d3 from "d3";

const Spotfire = window.Spotfire;
const DEBUG = false;

const timeAxisName = "Time";
const descriptionAxisName = "Description";
const minimumTimeMarkerWidth = 50;
const timeMarkermargin = 50;
const timelineHeight = 25;
const cardWidth = 150;
const cardHeight = 100;
const spaceBetweenCards = 50;

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

        if (!hasTime) return;

        const timeLeaves = (await (await dataView.hierarchy(timeAxisName))?.root())?.leaves() || [];

        const rows = (await dataView.allRows()) || [];

        let timeMarketWidth = (windowSize.width - timeMarkermargin * 2) / timeLeaves.length;
        let timeMarkerWidth = timeMarketWidth < minimumTimeMarkerWidth ? minimumTimeMarkerWidth : timeMarketWidth;
        let cardsPerTimeSegment = Math.ceil((cardWidth + spaceBetweenCards) / timeMarkerWidth);

        let timeLineTop =
            cardsPerTimeSegment > 1
                ? windowSize.height / 2 - timelineHeight / 2
                : (2 * windowSize.height) / 3 - timelineHeight / 2;

        // Update mod display

        let timeline = modContainer
            .selectAll(".timeline")
            .data([null])
            .join("div")
            .attr("class", "timeline")
            .attr(
                "style",
                (d, i) => `top:${timeLineTop}px; width:${timeMarkermargin * 2 + timeLeaves.length * timeMarkerWidth}px`
            );

        timeline
            .selectAll(".timeMarker")
            .data(timeLeaves)
            .join("div")
            .attr("class", "timeMarker")
            .on("click", (e, d) => d.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace"))
            .text((d) => d.formattedValue())
            .attr(
                "style",
                (d: Spotfire.DataViewHierarchyNode, i) => `
            left:${timeMarkermargin + i * timeMarkerWidth}px; 
            width:${timeMarkerWidth}px;
            background-color:${d.markedRowCount() > 0 ? "darkgray" : "lightgray"}
            `
            );

        modContainer
            .selectAll(".connector")
            .data(rows)
            .join("div")
            .attr("class", "connector")
            .attr("style", (d: DataViewRow, i) => {
                let left =
                    timeMarkermargin + d.categorical(timeAxisName).leafIndex * timeMarkerWidth + timeMarkerWidth / 2;
                let top = timeLineTop;
                let height = 0;

                switch (d.categorical(timeAxisName).leafIndex % cardsPerTimeSegment) {
                    case 0:
                        top = top - timelineHeight;
                        height = timelineHeight;
                        break;
                    case 1:
                        top = top + timelineHeight;
                        height = timelineHeight;
                        break;
                    case 2:
                        top = top - cardHeight - timelineHeight * 2;
                        height = cardHeight + timelineHeight * 2;
                        break;
                    case 3:
                        top = top + timelineHeight;
                        height = timelineHeight * 3 + cardHeight;
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
            .data(rows)
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
                        top = top - cardHeight - timelineHeight;
                        break;
                    case 1:
                        top = top + timelineHeight * 2;
                        break;
                    case 2:
                        top = top - cardHeight * 2 - timelineHeight * 2;
                        break;
                    case 3:
                        top = top + cardHeight + timelineHeight * 3;
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
