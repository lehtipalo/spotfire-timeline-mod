import { LayoutAlgorithm, LayoutResult } from "./layoutTypes";

// Greedy interval-graph coloring along the primary axis: an event takes the first lane
// whose last occupant is far enough behind it. For "middle" alignment - where events
// split across both sides of the axis - it chooses a side by comparing how many bands are
// *currently active* on each side (i.e. how many lanes a new event would actually collide
// with if placed there), not by lane parity. A concurrent run of events therefore spreads
// evenly across both sides as it grows, rather than strictly alternating in insertion
// order. Ties (equal active-band count on both sides) alternate, starting with the "a" side.
//
// Lane pitch is resolved per event from its own *local* peak concurrency, not one value
// shared by a whole side - that would let one crowded pocket compress an otherwise-roomy
// stretch far away on the same side. It only squeezes as far as
// context.minVisibleCrossExtent - short of that floor, further crowding overflows to the
// shared off-screen lane instead of compressing past it.
//
// primarySize and axisPosition aren't used - lane assignment only depends on relative
// timePosition differences, and pitch only on how much cross-axis room is available.
//
// Each result's offScreen flag reports whether the event landed in that shared overflow
// lane, so callers don't have to re-derive unreachability themselves from cardSpacing and
// their own pixel geometry.
export const balancedLaneLayout: LayoutAlgorithm = (events, primarySize, secondarySize, axisPosition, context) => {
    const {
        timeSegmentsPerCard,
        crossCardExtent,
        crossSpaceBetweenCards,
        numAlignmentGroups,
        timelineCrossExtent,
        minVisibleCrossExtent,
        outerEdgeMargin
    } = context;
    // A single card's cross-axis size plus its configured gap - both the pitch between
    // lanes when nothing is squeezed, and the fixed budget the outermost/only card always
    // needs regardless of squeeze (see its two uses below).
    const cardFootprint = crossCardExtent + crossSpaceBetweenCards;
    // A floor above cardFootprint would squeeze lanes that already fit comfortably - never
    // useful, so it's clamped down to that rather than treated as a caller error.
    const minPitch = Math.min(cardFootprint, Math.max(1, minVisibleCrossExtent));
    // N lanes at a given pitch occupy (N-1)*pitch of *steps* plus one full card at the far
    // end - not N*pitch. Below cardFootprint, cards overlap, so `pitch` is only the stagger
    // between successive near edges; the outermost card still needs its whole footprint
    // (crossCardExtent, plus the gap this side keeps from the timeline/previous card) past
    // that last step, since nothing overlaps it from beyond. Treating the budget as N*pitch
    // (as if a further, nonexistent card followed the last one) silently overstates how
    // many lanes fit and understates the pitch each needs once pitch is squeezed well below
    // crossCardExtent - the fixed part below corrects for that in both places it matters:
    // maxVisibleLanes and pitchForPeak.

    // A lane beyond this many is guaranteed to fall outside the drawing area, which clips
    // with overflow:hidden and has no cross-axis scrollbar - such a card is unreachable no
    // matter which excess lane it lands in. Once a side hits this cap, further events for
    // that side skip the (otherwise unbounded) first-fit scan entirely, which is what
    // keeps a single huge same-instant cluster (see the "Cluster stress test" datasets)
    // from degrading to O(n^2): every place()/activeCount() call is bounded by this
    // constant instead of by how many events have piled up so far. Sized against minPitch
    // (the tightest pitch any event could ever use), so the cap is exactly as permissive as
    // the squeeze allows - lane index maxVisibleLanes-1 (the last real lane) is exactly the
    // largest index still satisfying the same (N-1)*pitch + cardFootprint <= availablePerSide
    // budget pitchForPeak enforces below. Unlike the old N*pitch model, this +1 is exact,
    // not padding: any larger and the last real lane's own pitchForPeak clamp to minPitch
    // would push it past availablePerSide - i.e. the same clipping this file exists to
    // prevent, just at the boundary lane instead of every squeezed one.
    // outerEdgeMargin comes out of every side's budget up front, before any lane math -
    // fitting exactly `availablePerSide` worth of lanes still leaves outerEdgeMargin of
    // untouched space past the outermost one, on every side, for the same reason
    // cardFootprint's derivation holds regardless of how tight the squeeze gets.
    //
    // The single-group ("start"/"end") case additionally subtracts crossSpaceBetweenCards:
    // unlike "middle" (where the timeline sits exactly centered, so secondarySize/2 already
    // is each side's true budget), "start"/"end" anchor the timeline crossSpaceBetweenCards
    // in from the drawing area's edge (see timeLineCrossPos in index.ts), so that same gap
    // has to come out of the far side's budget too, or the outermost lane's card (and its
    // shadow) can clip past the edge this margin exists to protect.
    const availablePerSide =
        (numAlignmentGroups === 2
            ? (secondarySize - timelineCrossExtent) / 2
            : secondarySize - timelineCrossExtent - crossSpaceBetweenCards) - outerEdgeMargin;
    const maxVisibleLanes = Math.max(1, Math.floor(Math.max(0, availablePerSide - cardFootprint) / minPitch) + 1);
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
    // Per-side time-ordered subsequences of `order`, plus each event's own index within its
    // side's subsequence - built once sides are assigned below. localPeak's two-sided search
    // walks these directly instead of the merged (both-sides) order list, so its step budget
    // is spent entirely on same-side neighbours: a run of many opposite-side events between
    // two same-side events no longer eats into the budget and can no longer hide a same-side
    // peak that's really just a few same-side neighbours away.
    const sameSideOrder: [number[], number[]] = [[], []];
    const sameSideIndex = new Array<number>(events.length);

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
    // never tighter than cardFootprint when that already fits. `peakLanes` cards need only
    // peakLanes-1 steps of `pitch` (see cardFootprint above) plus the last card's own
    // footprint, not peakLanes full steps.
    function pitchForPeak(peakLanes: number): number {
        if (peakLanes <= 1) return cardFootprint;
        const availableForSteps = availablePerSide - cardFootprint;
        return cardFootprint * (peakLanes - 1) <= availableForSteps
            ? cardFootprint
            : Math.max(minPitch, availableForSteps / (peakLanes - 1));
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

        // Single-group ("start"/"end") case: everything is one side, so the merged order
        // list already contains only relevant neighbours.
        if (side === null) {
            for (
                let j = orderIdx - 1, steps = 0;
                j >= 0 && steps < localSearchStepBudget && peak < maxPossiblePeak;
                j--, steps++
            ) {
                const other = order[j];
                if (t - events[other].timePosition >= timeSegmentsPerCard) break;
                peak = Math.max(peak, rawPeakAtInsertion[other]);
            }
            for (
                let j = orderIdx + 1, steps = 0;
                j < order.length && steps < localSearchStepBudget && peak < maxPossiblePeak;
                j++, steps++
            ) {
                const other = order[j];
                if (events[other].timePosition - t >= timeSegmentsPerCard) break;
                peak = Math.max(peak, rawPeakAtInsertion[other]);
            }
            return peak;
        }

        // "middle" alignment: walk this event's own side's subsequence directly, so every
        // one of localSearchStepBudget's steps is spent on an actual same-side neighbour
        // rather than being burned on opposite-side events sitting in between.
        const sideOrder = sameSideOrder[side];
        const pos = sameSideIndex[i];
        for (
            let j = pos - 1, steps = 0;
            j >= 0 && steps < localSearchStepBudget && peak < maxPossiblePeak;
            j--, steps++
        ) {
            const other = sideOrder[j];
            if (t - events[other].timePosition >= timeSegmentsPerCard) break;
            peak = Math.max(peak, rawPeakAtInsertion[other]);
        }
        for (
            let j = pos + 1, steps = 0;
            j < sideOrder.length && steps < localSearchStepBudget && peak < maxPossiblePeak;
            j++, steps++
        ) {
            const other = sideOrder[j];
            if (events[other].timePosition - t >= timeSegmentsPerCard) break;
            peak = Math.max(peak, rawPeakAtInsertion[other]);
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
            results[i] = {
                verticalPosition: verticalPositions[i],
                cardSpacing: pitchForPeak(localPeak(orderIdx, null)),
                // rawPeakAtInsertion[i] is lane+1 (see its declaration above), so it only
                // reaches maxVisibleLanes+1 when place() returned the overflow sentinel -
                // reusing that instead of re-deriving off-screen-ness from pixel geometry.
                offScreen: rawPeakAtInsertion[i] === maxVisibleLanes + 1
            };
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
        const sideIndex = side === "a" ? 0 : 1;
        sideOfEvent[i] = sideIndex;
        sameSideIndex[i] = sameSideOrder[sideIndex].length;
        sameSideOrder[sideIndex].push(i);
    });

    order.forEach((i, orderIdx) => {
        results[i] = {
            verticalPosition: verticalPositions[i],
            cardSpacing: pitchForPeak(localPeak(orderIdx, sideOfEvent[i])),
            // Same overflow-sentinel check as the single-group branch above.
            offScreen: rawPeakAtInsertion[i] === maxVisibleLanes + 1
        };
    });
    return results;
};
