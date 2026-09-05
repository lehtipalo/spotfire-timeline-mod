# Timeline Mod User Guide

Turn a list of dated events into a story you can scan at a glance. The Timeline mod lays events out along a date or category axis, stacking overlapping ones into readable cards you can color, mark, and explore — from a handful of milestones to tens of thousands of events without the visualization slowing down.

It's built to play well with the rest of your analysis: use it as a starting point, marking events to explore them further in your other visualizations, or as a details view that reacts to filtering and marking coming from elsewhere on the page.

- [Get started](#get-started)
- [Configuring the timeline](#configuring-the-timeline)
- [Exploring the timeline](#exploring-the-timeline)

## Get started

All a timeline needs is something to put events in order and something to describe them. Give it a date (or any categorical column, if you don't have real dates) for **Time**, and a short piece of text for **Event**, and it lays out a scannable story of what happened when.

Let's say we have data about some world events:

| Date          | Event                   | Sentiment |
| ------------- | ----------------------- | --------- |
| Feb 11, 2021  | Something happened      | Neutral   |
| Feb 14, 2021  | Something else happened | Neutral   |
| March 8, 2021 | Something bad happened  | Negative  |

A basic timeline can be configured to show these events over time with:

- Time = Date: Year.Month.Day
- Event = Event

Add a splash of meaning by coloring the cards, using either a categorical or a continuous (gradient) expression, e.g.:

- Color By = Sentiment

The end result will look something like this:

![Mods Timeline 2](/images/Timeline2.png)

## Configuring the timeline

### Layout

Hover over the visualization to reveal a settings button in the upper-right corner. Click it to choose an orientation and card alignment.

- **Horizontal** timeline goes from left to right
  - **Top** — cards are pinned above the timeline.
  - **Middle** — cards alternate above and below the timeline
  - **Bottom** — cards are pinned below the timeline.
- **Vertical** — timeline goes from the top to the bottom of the screen
  - **Left** — cards are pinned to the left of the timeline.
  - **Middle** — cards alternate on both sides of the timeline.
  - **Right** — cards are pinned to the right of the timeline.

The chosen orientation and alignment are saved with the analysis.

### Card Density

The same settings popout also lets you choose how tightly cards are packed:

- **Dense** — cards can overlap down to about one line of text, fitting more of them on screen at once.
- **Spacious** — cards are always kept fully separated, at the cost of leaving some overlapping cards off-screen.

The chosen density is saved with the analysis.

### Auto-scroll to marked

The same settings popout has an **Auto-scroll to marked** toggle, off by default. When it's on and none of the currently marked cards are visible on screen, the timeline scrolls to bring one into view.

Marking a card from within the timeline itself never triggers this, since a card you just clicked or drag-selected is already visible by definition — the toggle only kicks in when an event gets marked in another visualization and its card would otherwise be off-screen.

### Time

The time segments are determined by the hierarchy on the Time axis. Drag the hierarchy slider (see [Adjusting the hierarchy](#adjusting-the-hierarchy)) to drill from years all the way down to individual days, or back out again.

In Spotfire Desktop the timeline defaults to showing the filtered range, including days with no events. This can be changed in the time axis settings. In the Spotfire Web Client the timeline shows only filtered values, skipping days without events.

### Events

The number of cards is determined by the expression on the Event axis, and by the Color axis when categorical color is used.

### Styling

The visualization responds to changes in the Spotfire canvas style. Label fonts, sizes, and line colors follow the visualization's canvas settings, and card and time-segment sizes adjust to match the selected font size.

## Exploring the timeline

| Action                                               | Result                                                          |
| ---------------------------------------------------- | --------------------------------------------------------------- |
| Click a card or time segment                         | Mark it, replacing the current marking                          |
| Ctrl-click (Cmd-click on Mac) a card or time segment | Add or remove it from the current marking                       |
| Click and drag across empty space                    | Draw a selection box and mark every card it touches             |
| Click empty space                                    | Clear the marking                                               |
| Hover a card                                         | Show its date and full description; bring it to front if hidden |
| Ctrl+double-click (Cmd+double-click on Mac)          | Start or stop automatic scrolling                               |

### Marking

Click a card to mark its event, or click a time segment — a month or a year, depending on the hierarchy currently shown — to mark every event within it. Marking updates every other visualization that shares the same marking.

Ctrl-click (Cmd-click on Mac) to add or remove items from the current marking instead of replacing it; this works the same way for cards and time segments.

Click and drag across empty space to draw a selection box and mark every card it touches. Clicking empty space without dragging clears the marking.

A marked card is drawn on top of any overlapping unmarked cards.

This marking isn't local to the timeline — it's the same marking used throughout Spotfire, so events marked here are marked everywhere else on the page that shares it, letting you [explore the same events across your other visualizations](https://docs.tibco.com/pub/sfire-analyst/latest/doc/html/en-US/TIB_sfire_client/client/topics/en-US/exploring_data_across_visualizations.html). Right-click a marking to [drill down into a details visualization](https://docs.tibco.com/pub/sfire-analyst/latest/doc/html/en-US/TIB_sfire_client/client/topics/en-US/drilling_down_into_details.html) built from just the marked events, or open the Details-on-Demand panel to [inspect every underlying event](https://docs.tibco.com/pub/sfire-analyst/latest/doc/html/en-US/TIB_sfire_client/client/topics/en-US/displaying_item_details.html) behind a marked card.

Marking an event in another visualization can land somewhere off-screen in a long timeline — turn on [Auto-scroll to marked](#auto-scroll-to-marked) to have the timeline scroll to it automatically.

### Tooltips

Hovering over a card shows a Spotfire tooltip with its date and full description — handy when the card's own text is too long to fit and gets truncated.

Hovering over a card that's partially hidden behind another also brings it to the front so it can be read in full, without disturbing which card stays on top once you move the mouse away.

### Adjusting the hierarchy

If the timeline is configured with a date hierarchy, drag the hierarchy slider to decide what level to show — drill from years down to individual days, or zoom back out.

### Scrolling

If the timeline doesn't fit within the visualization area, a scrollbar is available along the edge it scrolls toward — the bottom in horizontal layout, the right in vertical layout (see [Layout](#layout)). It's hidden by default and fades in while you hover over the visualization.

The scrollbar can be operated in several ways:

- Drag the handle to scroll to a specific position.
- Click the arrow buttons at either end to step by one time segment at a time.
- Click on the track on either side of the handle to page by roughly one handle-length.
- Scroll the mouse wheel anywhere over the visualization, not just the scrollbar.

For a hands-free ride through the whole timeline, Ctrl+double-click (Cmd+double-click on Mac) to start automatic scrolling. Double-click again the same way, or click anywhere, to stop it.
