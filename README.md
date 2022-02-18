# Timeline Mod for TIBCO Spotfire®
The timeline can be used to show events on a timeline. Here's one example that shows all the Mods released between October 2020 and March 2021:

![Mods Timeline](/images/Timeline.png)

## Try this mod in Spotfire Analyst

### How to open the mod

1. Open Spotfire Analyst, and create an analysis by loading some data.
2. Unzip the downloaded file, and locate the .mod file in the unzipped folder.
3. Drag the file into the analysis.
4. The visualization mod is added to the analysis.
5. To learn about the capabilities and limitations of this visualization mod, keep reading.

For general information on how to use and share visualization mods, [read the Spotfire documentation](https://docs.tibco.com/pub/sfire-analyst/11.0.0/doc/html/en-US/TIB_sfire-analyst_UsersGuide/index.htm?_ga=2.41319073.2072719993.1606728875-1950738096.1600074380#t=modvis%2Fmodvis_how_to_use_a_visualization_mod.htm).

## Data requirement
The timeline can be used to visulize any dataset that contains dates and descriptions. In order to make it work properly a data table with at least two columns is required: 

- One date hierarchy. A column with actual dates works best, but any combination of categorical columns are supported. This determines the timeline. 
- One description column. This determines what is written in the cards. 

Optionally a third categorical column could be used to color the cards. 

Every mod handles missing, corrupted and/or inconsistent data in different ways. It is advised to always review how the data is visualized.

## Setting up the timeline
Let's say we have data about some world events: 

| Date         | Event | Impact |
| -------------| ----- | -------|
| Feb 11, 2021 | Something happened     | Medium   |
| Feb 14, 2021 | Something else happened | Low    |
| March 8, 2021 | Something worse happened | Low    |

A basic timeline can be configured to show these events over time by creating a Timeline with the following settings: 

- Time = Date: Year.Month.Day
- Event = Event 

Optionally you could also color the cards by another color, E.g. 

- Color By = Impact

The end result will look something like this: 

![Mods Timeline](/images/Timeline 2.png)

## Using the Timeline

### Marking
Clicking on an event will mark that event in the timeline and in all other visualizations that uses the same marking. Clicking or dragging in the empty space between events will clear the marking. You can mark several events by Ctrl-clicking on them. 

Clicking and dragging allow you to select multiple events. 

Clicking on a time segment will mark all events within that time segment. E.g. If your timeline shows Year > Month > Day, you can mark all events within a year by clicking on the year segment or for a particular month by clicking on month segments. You can mark several time segments by Ctrl-clicking on them. 

## Building the mod

### Source code

### Developing the mod

Build Project

In a terminal window:

-   `npm install`
-   `npm run build-watch`

In a new terminal window

-   `npm run server`

### Build for production

The development version of bundle.js is uncompressed and not suitable for end users. Run the following command to compress the bundle.

-   `npm run build`

## More information about TIBCO Spotfire® Mods

-   [Spotfire® Mods on the TIBCO Community Exchange](https://community.tibco.com/exchange): A safe and trusted place to discover ready-to-use mods
-   [Spotfire® Mods Developer Documentation](https://tibcosoftware.github.io/spotfire-mods/docs/): Introduction and tutorials for mods developers
-   [Spotfire® Mods by TIBCO Spotfire®](https://github.com/TIBCOSoftware/spotfire-mods/releases/latest): A public repository for example projects

## Version history
