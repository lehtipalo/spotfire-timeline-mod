import { LayoutAlgorithm, LayoutResult } from "./layoutTypes";

// Same first-fit band packing as greedyLaneLayout (an event takes the first lane whose
// last occupant is far enough behind it along the primary axis), but for "middle"
// alignment - where events split across both sides of the axis - it chooses a side by
// comparing how many bands are *currently active* on each side (i.e. how many lanes a
// new event would actually collide with if placed there), not by lane parity. A
// concurrent run of events therefore spreads evenly across both sides as it grows,
// rather than strictly alternating in insertion order. Ties (equal active-band count on
// both sides) alternate, starting with the "a" side.
//
// Lane pitch is resolved per event from its own *local* peak concurrency - like
// greedyLaneLayout's cardSpacingForPeak, and for the same reason: a single value shared
// by a whole side would let one crowded pocket compress an otherwise-roomy stretch far
// away on the same side. It only squeezes as far as context.minVisibleCrossExtent - short
// of that floor, further crowding overflows to the shared off-screen lane exactly as
// before (greedyLaneLayout has no such floor, so it overflows the drawing area instead
// once its own natural pitch can't be squeezed any further).
//
// primarySize isn't used - see the equivalent note in greedyLaneLayout.ts, which applies
// here too. axisPosition likewise isn't read directly, but secondarySize *is* used below,
// unlike in greedyLaneLayout.
export const balancedLaneLayout: LayoutAlgorithm = (events, primarySize, secondarySize, axisPosition, context) => {
    const {
        timeSegmentsPerCard,
        crossCardExtent,
        crossSpaceBetweenCards,
        numAlignmentGroups,
        timelineCrossExtent,
        minVisibleCrossExtent
    } = context;
    const naturalPitch = crossCardExtent + 4 + crossSpaceBetweenCards;
    // A floor above the natural pitch would squeeze lanes that already fit comfortably -
    // never useful, so it's clamped down to natural rather than treated as a caller error.
    const minPitch = Math.min(naturalPitch, Math.max(1, minVisibleCrossExtent));

    // A lane beyond this many is guaranteed to fall outside the drawing area, which clips
    // with overflow:hidden and has no cross-axis scrollbar - such a card is unreachable no
    // matter which excess lane it lands in. Once a side hits this cap, further events for
    // that side skip the (otherwise unbounded) first-fit scan entirely, which is what
    // keeps a single huge same-instant cluster (see the "Cluster stress test" datasets)
    // from degrading to O(n^2): every place()/activeCount() call is bounded by this
    // constant instead of by how many events have piled up so far. Sized against minPitch
    // (the tightest pitch any event could ever use), so the cap is exactly as permissive
    // as the squeeze allows. +2 is just slack against rounding, not a load-bearing margin -
    // being off by one here only risks wasting a little extra (still O(1)) work on the
    // last real lane, never hiding a card that would otherwise have been visible.
    const availablePerSide =
        numAlignmentGroups === 2 ? (secondarySize - timelineCrossExtent) / 2 : secondarySize - timelineCrossExtent;
    const maxVisibleLanes = Math.max(1, Math.ceil(availablePerSide / minPitch) + 2);
    // A local peak search (see localPeak below) can never usefully exceed this - every
    // lane beyond it is the shared overflow lane, already the worst case.
    const maxPossiblePeak = maxVisibleLanes + 1;
    // How many neighbouring positions (matching side or not) a local search visits before
    // giving up, whether or not it ever finds one worth counting. Bounds each event's
    // search to O(maxVisibleLanes) even in a pathological run where this event's own side
    // is thinly represented among many opposite-side neighbours at nearly the same
    // primary-axis position - without this, that scenario could force scanning arbitrarily
    // many events just to find the few that share this one's side.
    const localSearchStepBudget = maxVisibleLanes * 2;

    // Process events in time order regardless of input order, but write results back by
    // original index so callers can zip the returned array 1:1 against their own events.
    const order = events.map((_, i) => i).sort((a, b) => events[a].timePosition - events[b].timePosition);
    const verticalPositions = new Array<number>(events.length);
    // Concurrent-lane count at the moment each event was placed (its own lane index + 1) -
    // seeds the local peak search below rather than one peak shared by every event that
    // ever transitively chained together on the same side.
    const rawPeakAtInsertion = new Array<number>(events.length);
    // Only meaningful in "middle" alignment (numAlignmentGroups === 2): 0 for side "a", 1
    // for side "b" - lets the local search below skip neighbours on the other side without
    // needing to decode verticalPosition back into a side.
    const sideOfEvent = new Array<0 | 1>(events.length);

    // A lane is free again once a new event's near edge (t - halfWidth) reaches or
    // passes the far edge of the last event placed there (t + halfWidth), recorded in
    // `bands`. Returns the lane index the event was placed in. Once `bands` has grown to
    // maxVisibleLanes with none free, every further event on this side is off-screen
    // regardless of index, so it's parked at the same overflow lane rather than growing
    // `bands` (and therefore every future scan's cost) without bound.
    function place(bands: number[], timePosition: number): number {
        for (let k = 0; k < bands.length; k++) {
            if (timePosition - timeSegmentsPerCard / 2 >= bands[k]) {
                bands[k] = timePosition + timeSegmentsPerCard / 2;
                return k;
            }
        }
        if (bands.length < maxVisibleLanes) {
            bands.push(timePosition + timeSegmentsPerCard / 2);
            return bands.length - 1;
        }
        return maxVisibleLanes;
    }

    // How many of this side's lanes are still occupied (would collide with an event
    // arriving at timePosition) - i.e. this side's current concurrency.
    function activeCount(bands: number[], timePosition: number): number {
        return bands.reduce(
            (count, farEdge) => (timePosition - timeSegmentsPerCard / 2 < farEdge ? count + 1 : count),
            0
        );
    }

    // The pitch that fits `peakLanes` into availablePerSide, no tighter than minPitch and
    // never tighter than naturalPitch when that already fits.
    function pitchForPeak(peakLanes: number): number {
        if (peakLanes <= 1) return naturalPitch;
        return naturalPitch * peakLanes <= availablePerSide
            ? naturalPitch
            : Math.max(minPitch, availablePerSide / peakLanes);
    }

    // The worst concurrency reached within timeSegmentsPerCard of event order[orderIdx],
    // among events on the same side (side is ignored - matches anything - when null, for
    // "start"/"end" alignment's single band list). Bounded by maxPossiblePeak (nothing
    // beyond it is worth finding) and localSearchStepBudget (nothing beyond it is
    // affordable to keep looking for) in each direction - see their declarations above.
    function localPeak(orderIdx: number, side: 0 | 1 | null): number {
        const i = order[orderIdx];
        let peak = rawPeakAtInsertion[i];
        const t = events[i].timePosition;

        for (
            let j = orderIdx - 1, steps = 0;
            j >= 0 && steps < localSearchStepBudget && peak < maxPossiblePeak;
            j--, steps++
        ) {
            const other = order[j];
            if (t - events[other].timePosition >= timeSegmentsPerCard) break;
            if (side === null || sideOfEvent[other] === side) {
                peak = Math.max(peak, rawPeakAtInsertion[other]);
            }
        }
        for (
            let j = orderIdx + 1, steps = 0;
            j < order.length && steps < localSearchStepBudget && peak < maxPossiblePeak;
            j++, steps++
        ) {
            const other = order[j];
            if (events[other].timePosition - t >= timeSegmentsPerCard) break;
            if (side === null || sideOfEvent[other] === side) {
                peak = Math.max(peak, rawPeakAtInsertion[other]);
            }
        }
        return peak;
    }

    const results = new Array<LayoutResult>(events.length);

    if (numAlignmentGroups === 1) {
        // "start"/"end" alignment: everything lives in a single band list; verticalPosition
        // is the lane index directly, matching laneInfo's single-group cases.
        let bands: number[] = [];
        order.forEach((i) => {
            const lane = place(bands, events[i].timePosition);
            verticalPositions[i] = lane;
            rawPeakAtInsertion[i] = lane + 1;
        });
        order.forEach((i, orderIdx) => {
            results[i] = { verticalPosition: verticalPositions[i], cardSpacing: pitchForPeak(localPeak(orderIdx, null)) };
        });
        return results;
    }

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
        rawPeakAtInsertion[i] = lane + 1;
        sideOfEvent[i] = side === "a" ? 0 : 1;
    });

    order.forEach((i, orderIdx) => {
        results[i] = {
            verticalPosition: verticalPositions[i],
            cardSpacing: pitchForPeak(localPeak(orderIdx, sideOfEvent[i]))
        };
    });
    return results;
};
