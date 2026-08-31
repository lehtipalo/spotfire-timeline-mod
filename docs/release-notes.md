# Release notes

## 1.0.0

-   First version.

## 1.0.1

-   Command-key + doubleclick now starts and stop auto-scroll on Mac
-   Fixed issue that caused auto-scroll to speed up and become unstoppabel when repeatedly double-clicking on a card.

## 1.1.0

-   The timeline can now handle tens of thousands of events without performance degradation. The previous 2,000 event limit has been removed.
-   Added a vertical layout mode with support for rendering the timeline to the left, right or in the middle of the visualization
-   Added options to control whether the horizontal timeline is rendered at the top of the visualization, in the middle or at the bottom.
-   Improved the card layout algorithm to minimize the number of overlapping cards. Card size is now tied to the width of a time segment.
-   Spotfire tooltips are enabled for all cards.
-   Hovering over a card that's partially hidden behind another now brings it temporarily to the front so that it can be more easily read.
-   The scrollbar more closely matches Spotfire native scrollbar look and feel. It's hidden by default and only appears while you hover over the visualization.
-   You can now scroll the timeline with the mouse wheel anywhere over the visualization.
-   Fixed an issue where the last card on the timeline could be cut off at the edge when scrolled all the way to the end.
-   Fixed an issue where dragging the scrollbar could stop noticeably short of the last card, especially with a lot of data.
-   Fixed the timeline's left and right edge margins so they're now equal - previously there was a bit more empty space on the left than on the right.
-   Fixed an issue where the outermost card in the stack could be cut off by the scrollbar
