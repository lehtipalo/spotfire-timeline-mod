# Release notes

## 1.0.0

-   First version.

## 1.0.1

-   Command-key + doubleclick now starts and stop auto-scroll on Mac
-   Fixed issue that caused auto-scroll to speed up and become unstoppabel when repeatedly double-clicking on a card.

## 1.1.0

-   The timeline now only draws the cards and time segments currently in or near view, so much larger datasets can be displaved. The previous limit of 2,000 events have been removed.
-   Replaced the browser's native horizontal scrollbar with a custom one styled to match the Spotfire canvas theme. It's hidden by default and only appears while you hover over the visualization.
-   Fixed an issue where the last card on the timeline could be cut off at the edge when scrolled all the way to the end.
-   Fixed an issue where dragging the scrollbar handle to the end wasn't the same as clicking to the end - dragging could stop noticeably short of the last card, especially with a lot of data.
-   Fixed the timeline's left and right edge margins so they're now equal - previously there was a bit more empty space on the left than on the right.
-   Hovering a card that's partially hidden behind another now brings it temporarily to the front so that it can be read.
-   Hovering a card now shows a Spotfire tooltip with the cards date and full description, useful when the card's own text is too long to fit and gets truncated.
-   Added a vertical layout mode. Hover over the visualization to reveal a settings button for switching between horizontal and vertical layout.
-   Fixed an issue where the outermost card in the stack could be cut off by the scrollbar.
-   Added a card alignment option - pin cards to one side of the timeline (top/bottom in horizontal layout, left/right in vertical layout).
-   You can now scroll the timeline with the mouse wheel anywhere over the visualization.
-   Card spacing is now calculated per-card based on nearby crowding, rather than per-cluster - further reducing avoidable overlap between cards that aren't actually near each other in time.
-   Card size is now tied to the width of a time segment, so cards no longer overlap with unrelated events that merely happen to be nearby in time - only genuinely concurrent events need to share space. As a tradeoff, densely-packed timelines now take up more room and may need more scrolling than before.
