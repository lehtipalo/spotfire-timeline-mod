import { LayoutAlgorithm } from "./layoutTypes";

// Greedy interval-graph coloring along the primary axis (each event takes the first lane
// whose last occupant is far enough behind it), then a local-peak pass that sizes each
// event's lane pitch to the worst concurrency found near it rather than one pitch shared
// by an entire transitively-chained run of overlapping events.
//
// primarySize and axisPosition aren't used by this particular algorithm - lane
// assignment only depends on relative timePosition differences, and pitch only on how
// much cross-axis room is available - but are part of the contract so other algorithms
// (e.g. ones that vary lane pitch along the primary axis, or split around the axis
// asymmetrically) have what they need without changing the call site.
export const greedyLaneLayout: LayoutAlgorithm = (events, primarySize, secondarySize, axisPosition, context) => {
    const { timeSegmentsPerCard, crossCardExtent, crossSpaceBetweenCards, numAlignmentGroups, timelineCrossExtent } =
        context;

    // Tracks, per lane, the time index of the last event placed there - a lane is free
    // again once a new event is far enough past it (>= timeSegmentsPerCard) to guarantee
    // no overlap.
    let lastPosition = new Map<number, number>();
    // Concurrent-lane count at the moment each event was placed (its own lane index + 1),
    // in event order. Seeds the local-peak search below rather than one peak shared by
    // every event that ever transitively chained together.
    let rawPeakAtInsertion: number[] = [];
    let verticalPositions: number[] = [];

    events.forEach((event) => {
        let vp = 0;
        while (
            lastPosition.get(vp) != undefined &&
            event.timePosition - (lastPosition.get(vp) as number) < timeSegmentsPerCard
        ) {
            vp++;
        }
        lastPosition.set(vp, event.timePosition);
        rawPeakAtInsertion.push(vp + 1);
        verticalPositions.push(vp);
    });

    const naturalCardSpacing = crossCardExtent + 4 + crossSpaceBetweenCards;
    function cardSpacingForPeak(peakLanes: number): number {
        const lanesPerGroup = Math.ceil(peakLanes / numAlignmentGroups);
        const totalSpaceRequired = naturalCardSpacing * (numAlignmentGroups * lanesPerGroup) + timelineCrossExtent;
        return totalSpaceRequired < secondarySize
            ? naturalCardSpacing
            : (secondarySize - timelineCrossExtent - (crossCardExtent + 4) * numAlignmentGroups) /
                  (numAlignmentGroups * lanesPerGroup);
    }

    // See the module-level comment above for why each event needs its own spacing
    // (worst local concurrency) rather than one value shared by a whole overlapping run,
    // and the known approximation limit that comes with it in horizontal mode.
    return events.map((event, i) => {
        let peak = rawPeakAtInsertion[i];
        for (let j = i - 1; j >= 0 && event.timePosition - events[j].timePosition < timeSegmentsPerCard; j--) {
            peak = Math.max(peak, rawPeakAtInsertion[j]);
        }
        for (let j = i + 1; j < events.length && events[j].timePosition - event.timePosition < timeSegmentsPerCard; j++) {
            peak = Math.max(peak, rawPeakAtInsertion[j]);
        }
        return { verticalPosition: verticalPositions[i], cardSpacing: cardSpacingForPeak(peak) };
    });
};
