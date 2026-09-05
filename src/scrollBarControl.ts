import { Selection, BaseType } from "d3-selection";
import type { Orientation } from "./index";

// Cross-axis thickness of the scrollbar track (its height in horizontal mode, its width in
// vertical mode). Purely internal - callers hand update() the container's own bounds
// (length/crossSize) and never need this value themselves.
const scrollBarHeight = 14;

/**
 * A scrollbar (start/end buttons, draggable handle, wheel support) styled to match the
 * Spotfire canvas theme, supporting both horizontal and vertical orientation. Values are
 * item indices (e.g. time segments), not pixels.
 *
 * All internal geometry (trackStart/End, handleExtent, handlePos, pointer coordinates) is
 * expressed along a single "track axis" - trackLength/thickness resolve that axis to width/
 * height (or vice versa) once in update(), and pointerCoord() resolves it to clientX/clientY,
 * so the rest of the module never branches on orientation itself.
 *
 * The buttons/arrows keep their "Left"/"Right" DOM ids and CSS classes regardless of
 * orientation - they mean "track-start"/"track-end", not a screen direction - since in
 * vertical mode the start button points up and the end button points down.
 *
 * Handle position and handle extent are deliberately computed independently of each other:
 * extent is sized proportionally to extent/totalItems (clamped to a visible minimum), and
 * position is a direct linear mapping of value in [0, maxValue] onto the handle's actual
 * available travel (track length minus whatever extent it ended up with). An earlier version
 * used a single d3 scale for both, which silently broke - dragging couldn't reach maxValue -
 * whenever the minimum-extent clamp made the handle bigger than its "natural" proportional
 * size, because the scale's domain no longer matched the handle's actual travel range.
 */
export function scrollBarControl(context: Selection<BaseType, unknown, HTMLElement, any>) {
    let buttonSize: number;

    let value: number;
    let maxValue: number;
    let top: number;
    let left: number;
    let height: number;
    let width: number;
    let orientation: Orientation;
    let trackLength: number;
    let thickness: number;
    let totalItems: number;
    let extent: number;
    let trackStart: number;
    let trackEnd: number;
    let handleExtent: number;
    let handleDragStart: number;
    let handlePos: number;
    let valueChanged: (value: number) => void;
    let color: string;
    let background: string;
    let handleDrag = false;
    let scrollDistance: number;

    let scrollBar = context.select<HTMLDivElement>("#scrollBar");
    if (scrollBar.empty()) {
        scrollBar = context
            .append("div")
            .attr("draggable", "false")
            .attr("id", "scrollBar")
            .style("opacity", "0")
            .style("pointer-events", "none")
            .on("mousedown", scrollBarMouseClick)
            .on("wheel", scrollBarMouseWheel);
    }

    let scrollBarButtonLeft = scrollBar.select<HTMLDivElement>("#scrollBarButtonLeft");

    if (scrollBarButtonLeft.empty()) {
        scrollBarButtonLeft = scrollBar.append("div").attr("draggable", "false").attr("id", "scrollBarButtonLeft");
        scrollBarButtonLeft.on("mousedown", leftButtonClick);
    }

    let arrowLeft = scrollBarButtonLeft.select<HTMLDivElement>("#arrowLeft");

    if (arrowLeft.empty()) {
        arrowLeft = scrollBarButtonLeft.append("div").attr("draggable", "false").attr("id", "arrowLeft");
    }

    let scrollBarButtonRight = scrollBar.select<HTMLDivElement>("#scrollBarButtonRight");

    if (scrollBarButtonRight.empty()) {
        scrollBarButtonRight = scrollBar.append("div").attr("draggable", "false").attr("id", "scrollBarButtonRight");
        scrollBarButtonRight.on("mousedown", rightButtonClick);
    }

    let arrowRight = scrollBarButtonRight.select<HTMLDivElement>("#arrowRight");

    if (arrowRight.empty()) {
        arrowRight = scrollBarButtonRight.append("div").attr("draggable", "false").attr("id", "arrowRight");
    }

    let scrollBarHandle = scrollBar.select<HTMLDivElement>("#scrollBarHandle");

    if (scrollBarHandle.empty()) {
        scrollBarHandle = scrollBar
            .append("div")
            .attr("draggable", "false")
            .attr("id", "scrollBarHandle")
            .on("mousedown", scrollBarHandleMouseDown)
            .on("dragstart", preventDragging);
    }

    return {
        setValue,
        render,
        update,
        hide,
        show,
        isHandleBeingDragged,
        handleWheel: scrollBarMouseWheel
    };

    function isHandleBeingDragged() {
        return handleDrag;
    }

    function update(options: {
        // The container's own along-axis and cross-axis extents - not the scrollbar's own
        // width/height/left/top, which it derives from these plus its own fixed thickness
        // (scrollBarHeight) below. Callers never need to know that thickness themselves.
        length: number;
        crossSize: number;
        orientation: Orientation;
        totalItems: number;
        value: number;
        maxValue: number;
        extent: number;
        color: string;
        background: string;
        scrollDistance: number;
        valueChanged: (value: number) => void;
    }) {
        let length: number, containerCrossSize: number;
        ({
            length,
            crossSize: containerCrossSize,
            orientation,
            totalItems,
            value,
            maxValue,
            extent,
            color,
            background,
            scrollDistance,
            valueChanged
        } = options);

        let isHorizontal = orientation === "horizontal";
        thickness = scrollBarHeight;
        trackLength = length;
        width = isHorizontal ? length : thickness;
        height = isHorizontal ? thickness : length;
        left = isHorizontal ? 0 : containerCrossSize - thickness;
        top = isHorizontal ? containerCrossSize - thickness : 0;

        buttonSize = Math.max(8, thickness - 4);
        trackStart = buttonSize + 4;
        trackEnd = trackLength - buttonSize - 4;
    }

    // How far the handle's leading edge is actually free to travel, given its own extent.
    function travelDistance() {
        return Math.max(0, trackEnd - trackStart - handleExtent);
    }

    function valueToHandlePos(v: number) {
        if (maxValue <= 0) {
            return trackStart;
        }
        return trackStart + (v / maxValue) * travelDistance();
    }

    function handlePosToValue(hp: number) {
        let travel = travelDistance();
        if (travel <= 0) {
            return 0;
        }
        let ratio = (hp - trackStart) / travel;
        return Math.max(0, Math.min(maxValue, ratio * maxValue));
    }

    function pointerCoord(event: MouseEvent) {
        return orientation === "horizontal" ? event.clientX : event.clientY;
    }

    function setValue(_value: number) {
        value = _value;
        render();
    }

    function render() {
        let isHorizontal = orientation === "horizontal";

        scrollBar
            .style("width", `${width}px`)
            .style("height", `${height}px`)
            .style("left", `${left}px`)
            .style("top", `${top}px`)
            .style("flex-direction", isHorizontal ? "row" : "column")
            .style("background-color", background);

        let trackSpan = Math.max(0, trackEnd - trackStart);
        let naturalExtent = totalItems > 0 ? trackSpan * (extent / totalItems) : trackSpan;
        // Keep the handle draggable/visible even when there are many more items than fit
        // in the viewport at once, rather than letting it shrink to a near-invisible sliver.
        handleExtent = Math.min(trackSpan, Math.max(buttonSize * 2, naturalExtent));

        handlePos = valueToHandlePos(value);

        let handleThickness = Math.max(6, thickness - 8);
        scrollBarHandle
            .style("background-color", color)
            .style("width", `${isHorizontal ? handleExtent : handleThickness}px`)
            .style("height", `${isHorizontal ? handleThickness : handleExtent}px`)
            .style("left", `${isHorizontal ? handlePos : 0}px`)
            .style("top", `${isHorizontal ? 0 : handlePos}px`)
            .style("transform", isHorizontal ? "translateY(-50%)" : "translateX(-50%)")
            // The offset axis is anchored at the track's cross-center; the transform above
            // then re-centers the handle on that anchor along the same axis.
            .style(isHorizontal ? "top" : "left", "50%");

        scrollBarButtonLeft.style("width", `${buttonSize}px`).style("height", `${buttonSize}px`);

        scrollBarButtonRight.style("width", `${buttonSize}px`).style("height", `${buttonSize}px`);

        // Scale the arrow triangles to the button size. A CSS border-triangle's rendered
        // box (perpendicular pair by pointing-direction pair) exactly equals its visible
        // bounds, so the buttons' flex centering places it correctly with no extra
        // positioning math needed here. "Left"/"Right" mean track-start/track-end, not a
        // screen direction - in vertical mode the start button points up, end points down.
        const arrowHalfThickness = Math.max(3, Math.round(buttonSize * 0.3));
        const arrowLength = Math.max(3, Math.round(buttonSize * 0.4));

        arrowLeft
            .style("border-top", isHorizontal ? `${arrowHalfThickness}px solid transparent` : "0")
            .style("border-bottom", isHorizontal ? `${arrowHalfThickness}px solid transparent` : `${arrowLength}px solid ${color}`)
            .style("border-left", isHorizontal ? "0" : `${arrowHalfThickness}px solid transparent`)
            .style("border-right", isHorizontal ? `${arrowLength}px solid ${color}` : `${arrowHalfThickness}px solid transparent`);

        arrowRight
            .style("border-top", isHorizontal ? `${arrowHalfThickness}px solid transparent` : `${arrowLength}px solid ${color}`)
            .style("border-bottom", isHorizontal ? `${arrowHalfThickness}px solid transparent` : "0")
            .style("border-right", isHorizontal ? "0" : `${arrowHalfThickness}px solid transparent`)
            .style("border-left", isHorizontal ? `${arrowLength}px solid ${color}` : `${arrowHalfThickness}px solid transparent`);
    }

    function hide() {
        // Fades out on hover-leave rather than an instant visibility switch. pointer-events
        // is toggled alongside opacity so the (invisible) bar can't intercept clicks/drags
        // meant for the visualization underneath it while hidden.
        scrollBar.style("opacity", "0").style("pointer-events", "none");
    }

    function show() {
        scrollBar.style("opacity", "1").style("pointer-events", "auto");
    }

    /**
     * Internal Functions
     */

    function preventDragging(event: MouseEvent) {
        /**
         * Prevent dragging from interfering with the behavior of the scrollbar.
         * In theory this should not be necessary but for some reason dragging is initiated on
         * the scrollbar handle in the Spotfire windows client if the previous attempt to move the handle
         * is terminated outside the scrollbar.
         * */
        event.preventDefault();
    }

    function scrollBarMouseClick(event: MouseEvent) {
        // Page by one viewport's worth of value (the visible extent), like clicking the
        // track on a native scrollbar. Deriving this from handleExtent's pixel size would
        // overshoot whenever the handle is clamped to its minimum visible size (see render()),
        // since the clamped handle no longer represents extent/totalItems proportionally.
        let pageValue = extent;
        let pointer = pointerCoord(event);

        if (pointer < handlePos) {
            value = Math.max(0, value - pageValue);
        } else if (pointer > handlePos + handleExtent) {
            value = Math.min(maxValue, value + pageValue);
        }

        render();
        valueChanged(value);
    }

    function scrollBarMouseWheel(event: WheelEvent) {
        // Also used for wheel scrolling over the visualization itself (see index.ts), where
        // an unprevented horizontal delta can otherwise trigger the browser's swipe-to-navigate
        // gesture instead of panning the timeline.
        event.preventDefault();
        let delta =
            orientation === "horizontal" ? event.deltaX || event.deltaY : event.deltaY || event.deltaX;
        let change = Math.round(delta / scrollDistance);

        value += change;

        if (value < 0) {
            value = 0;
        }
        if (value > maxValue) {
            value = maxValue;
        }
        render();
        valueChanged(value);
    }

    function scrollBarHandleMouseDown(event: MouseEvent) {
        handleDrag = true;
        handleDragStart = pointerCoord(event);
        event.stopPropagation();
        document.addEventListener("mouseup", scrollBarMouseUp);
        document.addEventListener("mousemove", scrollBarMouseMove);
    }

    function scrollBarMouseUp(event: MouseEvent) {
        if (handleDrag) {
            handleDrag = false;
            adjustScrollHandle(event);
        }
        document.removeEventListener("mouseup", scrollBarMouseUp);
        document.removeEventListener("mousemove", scrollBarMouseMove);
    }

    function scrollBarMouseMove(event: MouseEvent) {
        if (handleDrag) {
            adjustScrollHandle(event);
        }
    }

    function adjustScrollHandle(event: MouseEvent) {
        let travel = travelDistance();
        let pointer = pointerCoord(event);
        handlePos = handlePos + (pointer - handleDragStart);
        if (handlePos < trackStart) {
            handlePos = trackStart;
        }
        if (handlePos > trackStart + travel) {
            handlePos = trackStart + travel;
        }
        handleDragStart = pointer;
        value = handlePosToValue(handlePos);
        render();
        valueChanged(value);
    }

    function rightButtonClick(event: MouseEvent) {
        if (value < maxValue) {
            value += 1;
            render();
            valueChanged(value);
        }
        event.stopPropagation();
    }

    function leftButtonClick(event: MouseEvent) {
        if (value > 0) {
            value -= 1;
            render();
            valueChanged(value);
        }
        event.stopPropagation();
    }
}
