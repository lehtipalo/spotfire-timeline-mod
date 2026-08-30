import { Selection, BaseType } from "d3-selection";

/**
 * A horizontal scrollbar (left/right buttons, draggable handle, wheel support) styled to
 * match the Spotfire canvas theme. Values are item indices (e.g. time segments), not pixels.
 *
 * Vertical layout is left to CSS rather than hand-computed pixel offsets: #scrollBar is a
 * flex container that centers the buttons (and, via flex, the arrow triangles inside them)
 * automatically, and the handle - a plain rectangle, so the standard trick applies exactly -
 * uses "top: 50%; transform: translateY(-50%)" in main.css.
 *
 * Handle position and handle width are deliberately computed independently of each other:
 * width is sized proportionally to extent/totalItems (clamped to a visible minimum), and
 * position is a direct linear mapping of value in [0, maxValue] onto the handle's actual
 * available travel (track width minus whatever width it ended up with). An earlier version
 * used a single d3 scale for both, which silently broke - dragging couldn't reach maxValue -
 * whenever the minimum-width clamp made the handle wider than its "natural" proportional
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
    let totalItems: number;
    let extent: number;
    let trackStart: number;
    let trackEnd: number;
    let handleWidth: number;
    let handleDragStartX: number;
    let handleLeft: number;
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
        isHandleBeingDragged
    };

    function isHandleBeingDragged() {
        return handleDrag;
    }

    function update(
        _width: number,
        _left: number,
        _top: number,
        _height: number,
        _totalItems: number,
        _value: number,
        _maxValue: number,
        _extent: number,
        _color: string,
        _background: string,
        _scrollDistance: number,
        _valueChanged: (value: number) => void
    ) {
        width = _width;
        left = _left;
        top = _top;
        height = _height;
        totalItems = _totalItems;
        value = _value;
        maxValue = _maxValue;
        extent = _extent;
        color = _color;
        background = _background;
        scrollDistance = _scrollDistance;
        valueChanged = _valueChanged;

        buttonSize = Math.max(8, height - 4);
        trackStart = buttonSize + 4;
        trackEnd = width - buttonSize - 4;
    }

    // How far the handle's left edge is actually free to travel, given its own width.
    function travelDistance() {
        return Math.max(0, trackEnd - trackStart - handleWidth);
    }

    function valueToHandleLeft(v: number) {
        if (maxValue <= 0) {
            return trackStart;
        }
        return trackStart + (v / maxValue) * travelDistance();
    }

    function handleLeftToValue(hl: number) {
        let travel = travelDistance();
        if (travel <= 0) {
            return 0;
        }
        let ratio = (hl - trackStart) / travel;
        return Math.max(0, Math.min(maxValue, ratio * maxValue));
    }

    function setValue(_value: number) {
        value = _value;
        render();
    }

    function render() {
        scrollBar
            .style("width", `${width}px`)
            .style("height", `${height}px`)
            .style("left", `${left}px`)
            .style("top", `${top}px`)
            .style("border-color", color)
            .style("background-color", background);

        let trackSpan = Math.max(0, trackEnd - trackStart);
        let naturalWidth = totalItems > 0 ? trackSpan * (extent / totalItems) : trackSpan;
        // Keep the handle draggable/visible even when there are many more items than fit
        // in the viewport at once, rather than letting it shrink to a near-invisible sliver.
        handleWidth = Math.min(trackSpan, Math.max(buttonSize * 2, naturalWidth));

        handleLeft = valueToHandleLeft(value);

        scrollBarHandle
            .style("height", `${Math.max(6, height - 6)}px`)
            .style("background-color", color)
            .style("width", `${handleWidth}px`)
            .style("left", `${handleLeft}px`);

        scrollBarButtonLeft.style("width", `${buttonSize}px`).style("height", `${buttonSize}px`);

        scrollBarButtonRight.style("width", `${buttonSize}px`).style("height", `${buttonSize}px`);

        // Scale the arrow triangles to the button size. A CSS border-triangle's rendered
        // box (border-left-width + border-right-width by border-top-width + border-bottom-width)
        // exactly equals its visible bounds, so the buttons' flex centering places it
        // correctly with no extra positioning math needed here.
        const arrowHalfHeight = Math.max(3, Math.round(buttonSize * 0.3));
        const arrowWidth = Math.max(3, Math.round(buttonSize * 0.4));

        arrowLeft
            .style("border-top", `${arrowHalfHeight}px solid transparent`)
            .style("border-bottom", `${arrowHalfHeight}px solid transparent`)
            .style("border-left", "0")
            .style("border-right", `${arrowWidth}px solid ${color}`);

        arrowRight
            .style("border-top", `${arrowHalfHeight}px solid transparent`)
            .style("border-bottom", `${arrowHalfHeight}px solid transparent`)
            .style("border-right", "0")
            .style("border-left", `${arrowWidth}px solid ${color}`);
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
        // Page by roughly one handle-width worth of value, like clicking the track on a
        // native scrollbar.
        let travel = travelDistance();
        let pageValue = travel > 0 ? (handleWidth / travel) * maxValue : maxValue;

        if (event.clientX < handleLeft) {
            value = Math.max(0, value - pageValue);
        } else if (event.clientX > handleLeft + handleWidth) {
            value = Math.min(maxValue, value + pageValue);
        }

        render();
        valueChanged(value);
    }

    function scrollBarMouseWheel(event: WheelEvent) {
        let delta = event.deltaX || event.deltaY;
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
        handleDragStartX = event.clientX;
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
        handleLeft = handleLeft + (event.clientX - handleDragStartX);
        if (handleLeft < trackStart) {
            handleLeft = trackStart;
        }
        if (handleLeft > trackStart + travel) {
            handleLeft = trackStart + travel;
        }
        handleDragStartX = event.clientX;
        value = handleLeftToValue(handleLeft);
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
