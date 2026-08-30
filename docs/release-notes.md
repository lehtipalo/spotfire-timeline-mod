# Release notes

## 1.0.0

-   First version.

## 1.0.1

-   Command-key + doubleclick now starts and stop auto-scroll on Mac
-   Fixed issue that caused auto-scroll to speed up and become unstoppabel when repeatedly double-clicking on a card.

## 1.1.0

-   Removed the previous 2000-row / 2000-time-segment limits, fixing an error that occurred after attempting to display too many rows. The timeline now only draws the cards and time segments currently in or near view, so much larger datasets can be displayed without the mod erroring out or slowing down.
-   Replaced the browser's native horizontal scrollbar with a custom one styled to match the Spotfire canvas theme. It's hidden by default and only appears while you hover over the visualization.
-   Fixed an issue where the last card on the timeline could be cut off at the edge when scrolled all the way to the end.
-   Fixed an issue where dragging the scrollbar handle to the end wasn't the same as clicking to the end - dragging could stop noticeably short of the last card, especially with a lot of data.
-   Fixed the timeline's left and right edge margins so they're now equal - previously there was a bit more empty space on the left than on the right.
-   Hovering a card that's partially hidden behind another now brings it to the front so it can be read, without disturbing which card is on top once you move the mouse away.
-   Hovering a card now shows a Spotfire tooltip with its date and full description, useful when the card's own text is too long to fit and gets truncated.
