# Timeline Mod User Guide

## Data requirements

The timeline can be used to visulize any dataset that contains dates and descriptions. In order to make it work properly a data table with at least two columns is required:

-   One date hierarchy. A column with actual dates works best, but any combination of categorical columns are supported. This determines the timeline.
-   One description column. This determines what is written in the cards.

Optionally a third categorical column could be used to color the cards.

Every mod handles missing, corrupted and/or inconsistent data in different ways. It is advised to always review how the data is visualized.

## Setting up the timeline

Let's say we have data about some world events:

| Date          | Event                   | Sentiment |
| ------------- | ----------------------- | --------- |
| Feb 11, 2021  | Something happened      | Neutral   |
| Feb 14, 2021  | Something else happened | Neutral   |
| March 8, 2021 | Something bad happened  | Negative  |

A basic timeline can be configured to show these events over time by creating a Timeline with the following settings:

-   Time = Date: Year.Month.Day
-   Event = Event

Optionally you could also color the cards by another column, E.g.

-   Color By = Sentiment

The end result will look something like this:

![Mods Timeline 2](/images/Timeline2.png)

## Configuring the timeline

### Time

The time segments will be determined by the hierarchy on the time axis.

In the Spotfire Desktop the timeline will default to show the filtered range, meaning that it will include days regardless of whether or not there is an event for that day. This behavior can be changed in the time axis settings.

In the Spotfire Web Client the timeline will show all filtered values, meaning that it will skip days for which there is no event.

### Events

The number of cards will be determined by the expression on the event axis and the color axis if categorical color is used.

### Styling

The visualization will respond to changes in the Spotfire canvas style. Label fonts, sizes and the color of lines are determined by visualization canvas settings. The size of cards and time segments will adjust to the selected font size.

## Using the Timeline

### Marking

Clicking on an event will mark that event in the timeline and in all other visualizations that uses the same marking. Clicking or dragging in the empty space between events will clear the marking. You can mark several events by Ctrl-clicking on them.

Clicking and dragging allow you to select multiple events.

Clicking on a time segment will mark all events within that time segment. E.g. If your timeline shows Year > Month > Day, you can mark all events within a year by clicking on the year segment or for a particular month by clicking on month segments. You can mark several time segments by Ctrl-clicking on them.

### Adjusting the hierarchy

If the timeline is configured to use a date hierarchy you can decide what level of the hierarchy to show by dragging the hierarchy slider.

### Horizontal Scrolling

If the timeline is wider than the visualization area a scrollbar will be displayed at the bottom of the visualization.

The visualization will scroll right automatically if you double click on it while holding down ctrl on Windows and the command key on Mac. Clicking anywhere will stop the automatic scrolling.
