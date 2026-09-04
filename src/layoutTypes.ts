/**
 * Shared contract for pluggable event layout algorithms.
 *
 * A layout algorithm's only job is to resolve overlap along the cross axis: given each
 * event's position along the primary (time) axis, assign it a `verticalPosition` (a lane
 * index - 0, 1, 2... counting outward) and a `cardSpacing` (the cross-axis pitch between
 * lanes at that event). The render loop turns those two numbers into actual pixel
 * coordinates via calculateCardCrossPos/calcConnectorCrossPos - unchanged regardless of
 * which algorithm produced them - so a different algorithm only needs to honor this
 * contract, not know anything about rendering.
 */
export interface LayoutEvent {
    timePosition: number;
}

export interface LayoutResult {
    verticalPosition: number;
    cardSpacing: number;
}

export interface LayoutContext {
    // Minimum along-axis distance (in the same units as timePosition) two events must
    // have before they're allowed to share a lane.
    timeSegmentsPerCard: number;
    crossCardExtent: number;
    crossSpaceBetweenCards: number;
    // How many lanes share the same cross-axis footprint (e.g. "middle" alignment splits
    // lanes across both sides of the timeline; "start"/"end" keep them on one side).
    numAlignmentGroups: number;
    // Cross-axis thickness of the timeline itself, reserved out of secondarySize.
    timelineCrossExtent: number;
    // The smallest cross-axis sliver of a card an algorithm may leave visible when
    // resolving crowding by overlapping cards instead of dropping them - a practical
    // "enough to still read something" floor (e.g. approximating one line of text height),
    // not a guarantee about which pixels of a specific card stay uncovered. A value >=
    // crossCardExtent means no overlap is ever allowed (equivalent to omitting this
    // concept entirely) - algorithms that don't support graceful overlap can ignore it.
    minVisibleCrossExtent: number;
}

export type LayoutAlgorithm = (
    events: LayoutEvent[],
    primarySize: number,
    secondarySize: number,
    axisPosition: number,
    context: LayoutContext
) => LayoutResult[];
