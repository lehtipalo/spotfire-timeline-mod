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
};

const DEBUG = false;

/**
 * Constants
 */
const timeAxisName = "Time",
    descriptionAxisName = "Event",
    verticalSpaceBetweenCards = 12.5,
    horizontalSpaceBetweenCards = 12.5,
    rowsPerCard = 2,
    maxTimeSegments = 2000,
    scaleToFitHorizontally = false,
    scaleToFitVertically = true,
     dragSensitivity = 6;


/**
 * Set up drawing layers
 */
const modContainer = d3.select("#mod-container");

// Layer 2: The interaction layer
// @ts-ignore
const interactionLayer = modContainer.append("div").attr("id", "interactionLayer")

// Layer 3: The drawing layer
const drawingLayer = modContainer.append("div").attr("id", "drawingLayer");

// Layer 5: The marking overlay layer
// @ts-ignore
const markingOverlay = modContainer.append("div").attr("id", "").attr("class", "inactiveMarking");



window.Spotfire.initialize(async (mod) => {
    /**
     * Initialize render context - should show 'busy' cursor.
     * A necessary step for printing (another step is calling render complete)
     */
    const context = mod.getRenderContext();

    let fontSize = parseInt(context.styling.general.font.fontSize.toString()); // workaround bug in Spotfire 11.4 where fontSize returns string

    let cardHeight = fontSize*rowsPerCard*1.5;
    let timelineHeight = fontSize*2;
    let minimumTimeSegmentWidth = fontSize*4.5;
    let cardWidth = 2.8*minimumTimeSegmentWidth;
    let timeSegmentMargin = cardWidth / 2;

    // configfure styling
    document.querySelector("#extra_styling")!.innerHTML = `
    .body { fill: ${context.styling.general.font.color}; font-size: ${context.styling.general.font.fontSize}px; font-weight: ${context.styling.general.font.fontWeight}; font-style: ${context.styling.general.font.fontStyle};}
    .timeMarker {border-color: ${context.styling.scales.line.stroke}} 
    .timeline {border-color: ${context.styling.scales.line.stroke}} 
    .connector {background-color: ${context.styling.scales.line.stroke}}
    `;

    const reader = mod.createReader(mod.visualization.data(), mod.windowSize());

    reader.subscribe(generalErrorHandler(mod)(onChange), (err) => {
        mod.controls.errorOverlay.show(err);
    });

    let marking = false;
    let mouseDown = false;
    let markingX1 = 0; 
    let markingX2 = 0;
    let markingY1 = 0;
    let markingY2 = 0; 

    async function onChange(dataView: DataView, windowSize: Spotfire.Size) {

        /**
         * Get Data
         */
        const hasTime = !!(await dataView.categoricalAxis(timeAxisName));
        const hasDescription = !!(await dataView.categoricalAxis(descriptionAxisName));

        if (!hasTime) {
            drawingLayer.selectAll("*").remove();
            return;
        }

        let timeLeaves = (await (await dataView.hierarchy(timeAxisName))?.root())?.leaves() || [];

        if (timeLeaves.length > maxTimeSegments) {
            drawingLayer.selectAll("*").remove();
            return;
        }

        let timeHierarchy = await dataView.hierarchy(timeAxisName);
        let timeHierarchyDepth = timeHierarchy?.levels.length || 0;
        let hierarchyRoot = await timeHierarchy?.root();
        if (!hierarchyRoot) return;

        let timeMarketWidth = (windowSize.width - timeSegmentMargin * 2) / timeLeaves.length;
        let timeMarkerWidth = timeMarketWidth >= minimumTimeSegmentWidth || scaleToFitHorizontally ?  timeMarketWidth : minimumTimeSegmentWidth;
        let timeSegmentsPerCard = Math.ceil((cardWidth+horizontalSpaceBetweenCards) / timeMarkerWidth);

        let timeLineTop = windowSize.height / 2 - timelineHeight*timeHierarchyDepth / 2;
        
        /**
         * Calculate Abstract Layout
         */
    
        let cards:Card[] = [];
        let lastPosition = new Map();
        let maxStackedCards = 0;

        timeLeaves.forEach((node:DataViewHierarchyNode) => {

            node.rows().forEach((row:DataViewRow) => {

                if (row.categorical(descriptionAxisName).formattedValue() != "") {
                    
                    let index = row.categorical(timeAxisName).leafIndex;
                    let vp = 0;
        
                    while (lastPosition.get(vp) != undefined && index-lastPosition.get(vp) < timeSegmentsPerCard) {
                        vp++;
                    }
                    lastPosition.set(vp,index)
                    maxStackedCards = vp+1 > maxStackedCards ? vp+1 : maxStackedCards;
    
                    cards.push(
                        {
                        title: "",
                        description:  hasDescription ? row.categorical(descriptionAxisName).formattedValue(): "",
                        verticalPosition: vp,
                        timePosition: row.categorical(timeAxisName).leafIndex,
                        color: row.color(),
                        row: row,
                        }
                    )
                }    
             }
            )
    

        });

        /**
         * Enable rectangle selection
         */

        drawingLayer
            .on("mousedown", (event:MouseEvent) => {
                markingY1 = event.clientY;
                markingX1 = event.clientX;
                markingY2 = markingY1;
                markingX2 = markingX2;
                mouseDown = true; 
            })
            .on("mousemove",(event:MouseEvent) => {
                markingX2 = event.clientX;
                markingY2 = event.clientY;
                if (mouseDown) {
                    marking = Math.abs(markingX2-markingX1) > dragSensitivity && Math.abs(markingY2-markingY1) > dragSensitivity;
                }
                if (marking) {
                    mouseDown = false; 
                    markingX2 = event.clientX;
                    markingY2 = event.clientY;
                    markingOverlay
                        .attr("class","activeMarking")
                        .style("left",`${markingX2 > markingX1 ? markingX1:markingX2}`)
                        .style("top",`${markingY2 > markingY1 ? markingY1:markingY2}`)
                        .style("width",`${Math.abs(markingX2-markingX1)}`)
                        .style("height",`${Math.abs(markingY2-markingY1)}`)
                }
            })
            .on("mouseup", (event: MouseEvent) => {
                mouseDown = false; 
                if (marking) {
                    markingOverlay
                    .attr("class","inactiveMarking");
                    marking = false; 
                    cardContainer.selectAll<HTMLDivElement,Card>(".card")
                        .each((c:Card) => {
                            let cardTop = calculateCardTop(c.verticalPosition);
                            let cardLeft = calculateCardLeft(c);
                            let cardRight = cardLeft + cardWidth;
                            let cardBottom = cardTop + cardHeight;

                            let markingLeft = markingX1 < markingX2 ? markingX1 : markingX2;
                            let markingTop = markingY1 < markingY2 ? markingY1 : markingY2;
                            let markingRight = markingX1 < markingX2 ? markingX2 : markingX1;
                            let markingBottom = markingY1 < markingY2 ? markingY2 : markingY1;
                        
                            if (intersect(cardLeft,cardTop,cardBottom,cardRight, markingLeft, markingTop,markingBottom, markingRight)) {
                                c.row.mark(event.ctrlKey || event.metaKey ? "ToggleOrAdd" : "Replace");
                            };
                        })
                } 
                else {
                    dataView.clearMarking();
                } 
            });
    
        
    

        /**
         * Display Cards
         */
        let displayCards = cards.filter((card:Card) => card.description != "" && card.verticalPosition > -1 )

        let cardSpacing = cardHeight + 4 + verticalSpaceBetweenCards;
        if (scaleToFitVertically) {
            let totalSpaceRequired = cardSpacing*(2*Math.ceil(maxStackedCards/2)) + timelineHeight*timeHierarchyDepth;        
            cardSpacing = totalSpaceRequired < windowSize.height ? cardSpacing : (windowSize.height- timelineHeight*timeHierarchyDepth-(cardHeight+4)*2) / (2*Math.ceil(maxStackedCards/2));
        }
     
        // render connectors between the cards and the timeline
    
        let connectorContainer = drawingLayer
            .selectAll("#connectors")
            .data([null])
            .join("div")
            .attr("id", "connectors");

        connectorContainer
            .selectAll<HTMLDivElement,Card>(".connector")
            .data(displayCards,(d: Card) => d.row.elementId(true))
            .join("div")
            .attr("class", "connector")
            .style("left",(d) => `${timeSegmentMargin + d.timePosition * timeMarkerWidth + timeMarkerWidth / 2}px`) 
            .style("top",(d) => `${calcConnectorTop(d.verticalPosition)}px`)
            .style("height",(d) => `${calcConnectorHeight(d)}px`);

        let cardContainer = drawingLayer
            .selectAll("#cards")
            .data([null])
            .join("div")
            .attr("id", "cards");

        cardContainer
            .selectAll<HTMLDivElement,Card>(".card")
            .data(cards,(d: Card) => d.row.elementId(true))
            .join("div")
            .attr("class", "card")
            .classed("card-marked",(d) => d.row.isMarked())
            .on("mouseup", (e,d) => {
                mouseDown = false; 
                if (marking) {
                    markingOverlay
                    .attr("class","inactiveMarking");
                    marking = false; 
                    cardContainer.selectAll<HTMLDivElement,Card>(".card")
                        .each((c:Card) => {
                            let cardTop = calculateCardTop(c.verticalPosition);
                            let cardLeft = calculateCardLeft(c);
                            let cardRight = cardLeft + cardWidth;
                            let cardBottom = cardTop + cardHeight;

                            let markingLeft = markingX1 < markingX2 ? markingX1 : markingX2;
                            let markingTop = markingY1 < markingY2 ? markingY1 : markingY2;
                            let markingRight = markingX1 < markingX2 ? markingX2 : markingX1;
                            let markingBottom = markingY1 < markingY2 ? markingY2 : markingY1;
                        
                            if (intersect(cardLeft,cardTop,cardBottom,cardRight, markingLeft, markingTop,markingBottom, markingRight)) {
                                c.row.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace");
                            };
                        })
                        
                }
                else {
                    d.row.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace");
                } 
                e.stopPropagation();
            })
            .html((d) => {
                let s = `
            ${d.description}
            `;
                return s;
            })
            .style("left",(d) => `${
                    calculateCardLeft(d)}px`
            )
            .style("top",(d) => `${calculateCardTop(d.verticalPosition)}px`)
            .style("height",(d) => `${cardHeight}px`)
            .style("width",(d) => `${cardWidth}px`)
            .style("background-color",(d) => `${d.color.hexCode}`)
            .style("color",(d) => `${contrastColor(d.color.hexCode)}`);

            // marked cards on top
            cardContainer.selectAll<HTMLDivElement,Card>(".card")
                .filter((d:Card)=> d.row.isMarked()).raise();

            // render timeline

            let timeline = drawingLayer
            .selectAll(".timeline")
            .data([null])
            .join("div")
            .attr("class", "timeline")
            .style("left",(d) => timeSegmentMargin)
            .style("top",(d) => timeLineTop) 
            .style("width",(d) => timeLeaves.length * timeMarkerWidth+2)
            .style("height",(d) => timelineHeight*timeHierarchyDepth+2)
        
    
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
            .classed("timeMarker-left",(d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.x0 == 0)
            .classed("timeMarker-top",(d:d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.data.level == 0)
            .on("click", (e, d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) =>{
                d.data.mark(e.ctrlKey || e.metaKey ? "ToggleOrAdd" : "Replace")
                e.stopPropagation();
            })
            .text((d: d3.HierarchyRectangularNode<DataViewHierarchyNode>) => d.data.formattedValue())
            .style("left",(d) => d.x0) 
            .style("width",(d) => d.x1-d.x0-5)
            .style("top",(d) => d.y0-timelineHeight)
            .style("height",(d) => d.y1-d.y0);

        context.signalRenderComplete();

        function calculateCardLeft(d: Card) {
            return timeSegmentMargin +
                d.timePosition * timeMarkerWidth -
                cardWidth / 2 +
                timeMarkerWidth / 2;
        }

        function calcConnectorHeight(d: Card) {
            let height = 0;

            let group = d.verticalPosition % 2;
            let lane = Math.floor(d.verticalPosition / 2);

            switch (group) {
                case 0:
                    height = lane * cardSpacing+verticalSpaceBetweenCards;
                    break;
                case 1:
                    height = verticalSpaceBetweenCards + lane * (cardSpacing) - 3;
                    break;
            }
            return height;
        }

        function calcConnectorTop(verticalPosition:number) {
            let top = timeLineTop;
            let group = verticalPosition % 2;
            let lane = Math.floor(verticalPosition / 2);
    
            switch (group) {
                case 0:
                    top = top - verticalSpaceBetweenCards - lane * cardSpacing;
                    break;
                case 1:
                    top = top + timelineHeight * timeHierarchyDepth + 3;
                    break;
            }
            return top;
        }
            
        function calculateCardTop(verticalPosition:number) {
            let top = timeLineTop;
            let group = verticalPosition % 2;
            let lane = Math.floor(verticalPosition / 2);

            switch (group) {
                case 0:
                    top = top - verticalSpaceBetweenCards - lane * cardSpacing - cardHeight ;
                    break;
                case 1:
                    top = top + timelineHeight * timeHierarchyDepth + lane * cardSpacing + verticalSpaceBetweenCards;
                    break;
            }
            return top;
        }
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

function intersect(
    left1:Number,
    top1:Number,
    bottom1:Number,
    right1:Number,
    left2:Number,
    top2:Number,
    bottom2:Number,
    right2:Number) 
    {
        if (left1 > right2 || left2 > right1) {
            return false;
        }
        if (top1 > bottom2 || top2 > bottom1) {
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
