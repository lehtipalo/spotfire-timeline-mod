import { LayoutAlgorithm } from "./layoutTypes";

// Same first-fit band packing as greedyLaneLayout (an event takes the first lane whose
// last occupant is far enough behind it along the primary axis), but for "middle"
// alignment - where events split across both sides of the axis - it chooses a side by
// comparing how many bands are *currently active* on each side (i.e. how many lanes a
// new event would actually collide with if placed there), not by lane parity. A
// concurrent run of events therefore spreads evenly across both sides as it grows,
// rather than strictly alternating in insertion order. Ties (equal active-band count on
// both sides) alternate, starting with the "a" side.
//
// Unlike greedyLaneLayout's cardSpacingForPeak, lane pitch here is a fixed
// crossCardExtent-derived constant for every event - it isn't squeezed to fit when a
// cluster is denser than the available cross-axis space, so a sufficiently crowded
// cluster will overflow the drawing area rather than compress.
//
// primarySize and axisPosition aren't used - see the equivalent note in
// greedyLaneLayout.ts, which applies here too.
export const balancedLaneLayout: LayoutAlgorithm = (events, primarySize, secondarySize, axisPosition, context) => {
    const { timeSegmentsPerCard, crossCardExtent, crossSpaceBetweenCards, numAlignmentGroups } = context;
    const cardSpacing = crossCardExtent + 4 + crossSpaceBetweenCards;

    // Process events in time order regardless of input order, but write results back by
    // original index so callers can zip the returned array 1:1 against their own events.
    const order = events.map((_, i) => i).sort((a, b) => events[a].timePosition - events[b].timePosition);
    const verticalPositions = new Array<number>(events.length);

    // A lane is free again once a new event's near edge (t - halfWidth) reaches or
    // passes the far edge of the last event placed there (t + halfWidth), recorded in
    // `bands`. Returns the lane index the event was placed in.
    function place(bands: number[], timePosition: number): number {
        for (let k = 0; k < bands.length; k++) {
            if (timePosition - timeSegmentsPerCard / 2 >= bands[k]) {
                bands[k] = timePosition + timeSegmentsPerCard / 2;
                return k;
            }
        }
        bands.push(timePosition + timeSegmentsPerCard / 2);
        return bands.length - 1;
    }

    // How many of this side's lanes are still occupied (would collide with an event
    // arriving at timePosition) - i.e. this side's current concurrency.
    function activeCount(bands: number[], timePosition: number): number {
        return bands.reduce(
            (count, farEdge) => (timePosition - timeSegmentsPerCard / 2 < farEdge ? count + 1 : count),
            0
        );
    }

    if (numAlignmentGroups === 1) {
        // "start"/"end" alignment: everything lives in a single band list; verticalPosition
        // is the lane index directly, matching laneInfo's single-group cases.
        let bands: number[] = [];
        order.forEach((i) => {
            verticalPositions[i] = place(bands, events[i].timePosition);
        });
    } else {
        // "middle" alignment: verticalPosition packs {side, lane} the same way laneInfo
        // decodes it - even values are side "a" (group 0), odd values are side "b" (group 1).
        let bandsA: number[] = [];
        let bandsB: number[] = [];
        let lastTie: "a" | "b" = "b"; // so the first tie goes to "a"

        order.forEach((i) => {
            const t = events[i].timePosition;
            const activeA = activeCount(bandsA, t);
            const activeB = activeCount(bandsB, t);

            let side: "a" | "b";
            if (activeA < activeB) side = "a";
            else if (activeB < activeA) side = "b";
            else {
                side = lastTie === "a" ? "b" : "a";
                lastTie = side;
            }

            const lane = place(side === "a" ? bandsA : bandsB, t);
            verticalPositions[i] = side === "a" ? lane * 2 : lane * 2 + 1;
        });
    }

    return verticalPositions.map((verticalPosition) => ({ verticalPosition, cardSpacing }));
};
