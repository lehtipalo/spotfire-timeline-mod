# Timeline Mod for TIBCO Spotfire®

The timeline can be used to show events on a timeline. Here's one example that shows all the Mods released between October 2020 and March 2021:

![Mods Timeline](/images/Timeline.png)

# Try this visualization mod

To use this mod, download it from Community Exchange.

## Download from Exchange

1. Sign in with your community account.
2. Click Download in the upper right part of this page and download the .mod file.
3. Open Spotfire, and create an analysis by loading some data.
4. Drag the downloaded .mod file into the analysis.
5. The visualization is added to the analysis.

To learn more about the capabilities and limitations of this visualization mod, read its [user guide](docs/user-guide.md).

# Documentation

For more information on data requirements, the available settings, and how to configure the mod, see the [user guide](docs/user-guide.md).

For general information on how to use and share visualization mods, [read the Spotfire documentation](https://docs.tibco.com/pub/sfire-analyst/latest/doc/html/en-US/TIB_sfire_client/client/topics/en-US/visualization_mods.html).

# Support

_This mod is not supported by Spotfire._

To ask questions or request enhancements, post a question in the [Forum](https://community.spotfire.com/forums/) and tag with Mods.

# Building the mod

## Developing the mod

Build Project

In a terminal window:

-   `npm install`
-   `npm run build-watch`

In a new terminal window

-   `npm run server`

## Build for production

The development version of bundle.js is uncompressed and not suitable for end users. Run the following command to compress the bundle.

-   `npm run build`

## More information about TIBCO Spotfire® Mods

-   [Spotfire® Mods on the TIBCO Community Exchange](https://community.tibco.com/exchange): A safe and trusted place to discover ready-to-use mods
-   [Spotfire® Mods Developer Documentation](https://tibcosoftware.github.io/spotfire-mods/docs/): Introduction and tutorials for mods developers
-   [Spotfire® Mods by TIBCO Spotfire®](https://github.com/TIBCOSoftware/spotfire-mods/releases/latest): A public repository for example projects

## Version history

See the [release notes](docs/release-notes.md).
