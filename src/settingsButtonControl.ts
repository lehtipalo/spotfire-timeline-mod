import { Selection, BaseType } from "d3-selection";
import type { Mod } from "spotfire-api";
import type { Orientation, CardAlignment, CardDensity, CardSize } from "./index";

// stroke="currentColor" picks up #settingsButton's own `color` style via inheritance.
const settingsIconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
    <path stroke="none" d="M0 0h24v24H0z" fill="none" />
    <path d="M12 8a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
    <path d="M4 8l8 0" />
    <path d="M16 8l4 0" />
    <path d="M6 16a2 2 0 1 0 4 0a2 2 0 1 0 -4 0" />
    <path d="M4 16l2 0" />
    <path d="M10 16l10 0" />
</svg>`;

const settingsButtonSize = 24;
// A plain top-align collides with Spotfire's floating action button (FAB), which
// renders in the visualization's top-right corner regardless of the mod's own
// horizontal/vertical layout orientation - SIP mods deliberately reserve clearance
// there instead of top-aligning their own config button. The FAB's own container sits
// at top:16px in this same coordinate space (confirmed via devtools); its buttons are
// the standard 32px Spotfire action-button size, so this clears its bottom edge
// (~48px) with a small margin.
const settingsButtonTop = 56;
// Same right inset regardless of orientation - keeps the button aligned under the FAB
// (which uses this same inset) instead of shifting sideways when orientation changes.
// Also happens to clear the scrollbar running down that same edge in vertical mode
// (its thickness is well under this); revisit this value if the scrollbar is ever
// made noticeably thicker.
const settingsButtonRight = 22;

/**
 * The settings (gear) button and its popout menu for orientation/card-alignment/card-density.
 * update() is idempotent and expected to be called on every render, like the rest of index.ts's
 * top-level DOM nodes.
 */
export function settingsButtonControl(modContainer: Selection<BaseType, unknown, HTMLElement, any>, mod: Mod) {
    return { update, setVisible };

    function setVisible(visible: boolean) {
        modContainer
            .select("#settingsButton")
            .style("opacity", visible ? "1" : "0")
            .style("pointer-events", visible ? "auto" : "none");
    }

    function update(options: {
        uiChromeColor: string;
        backgroundColor: string;
        windowSize: Spotfire.Size;
        modMargin: number;
        orientation: Orientation;
        cardAlignment: CardAlignment;
        cardDensity: CardDensity;
        cardSize: CardSize;
    }) {
        const {
            uiChromeColor,
            backgroundColor,
            windowSize,
            modMargin,
            orientation,
            cardAlignment,
            cardDensity,
            cardSize
        } = options;

        let settingsButton = modContainer
            .selectAll("#settingsButton")
            .data([null])
            .join("div")
            .attr("id", "settingsButton")
            .style("top", `${settingsButtonTop}px`)
            .style("right", `${settingsButtonRight}px`)
            // Interactive UI chrome (unlike the muted scale-line color used for the
            // timeline/connectors) should read like native Spotfire toolbar icons, so it
            // uses the theme's primary foreground color rather than the gridline color.
            .style("color", uiChromeColor)
            .style("border-color", uiChromeColor)
            // Without a fill, the timeline underneath shows through the button wherever
            // it overlaps - give it the mod's own background so it reads as opaque chrome.
            .style("background-color", backgroundColor)
            .on("click", () => {
                mod.controls.popout.show(
                    {
                        // #settingsButton's top/right are relative to #mod-container, which
                        // is itself inset by modMargin from windowSize's true edges (see
                        // availableSize in index.ts) - popout.show wants true iframe-relative
                        // coordinates, so that inset has to be added back in here.
                        x: windowSize.width - modMargin - settingsButtonRight - settingsButtonSize,
                        y: modMargin + settingsButtonTop + settingsButtonSize / 2,
                        alignment: "Right",
                        autoClose: true,
                        onChange: (event) => {
                            if (event.name === "orientationAlignment") {
                                const [newOrientation, newCardAlignment] = (event.value as string).split("-");
                                mod.property<string>("orientation").set(newOrientation);
                                mod.property<string>("cardAlignment").set(newCardAlignment);
                            } else if (event.name === "cardDensity") {
                                mod.property<string>("cardDensity").set(event.value as string);
                            } else if (event.name === "cardSize") {
                                mod.property<string>("cardSize").set(event.value as string);
                            }
                        }
                    },
                    () => [
                        mod.controls.popout.section({
                            heading: "Horizontal",
                            children: [
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Top",
                                    checked: orientation === "horizontal" && cardAlignment === "start",
                                    value: "horizontal-start"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Middle",
                                    checked: orientation === "horizontal" && cardAlignment === "middle",
                                    value: "horizontal-middle"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Bottom",
                                    checked: orientation === "horizontal" && cardAlignment === "end",
                                    value: "horizontal-end"
                                })
                            ]
                        }),
                        mod.controls.popout.section({
                            heading: "Vertical",
                            children: [
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Left",
                                    checked: orientation === "vertical" && cardAlignment === "start",
                                    value: "vertical-start"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Middle",
                                    checked: orientation === "vertical" && cardAlignment === "middle",
                                    value: "vertical-middle"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "orientationAlignment",
                                    text: "Right",
                                    checked: orientation === "vertical" && cardAlignment === "end",
                                    value: "vertical-end"
                                })
                            ]
                        }),
                        mod.controls.popout.section({
                            heading: "Card Density",
                            children: [
                                mod.controls.popout.components.radioButton({
                                    name: "cardDensity",
                                    text: "Dense",
                                    checked: cardDensity === "dense",
                                    value: "dense"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "cardDensity",
                                    text: "Spacious",
                                    checked: cardDensity === "spacious",
                                    value: "spacious"
                                })
                            ]
                        }),
                        mod.controls.popout.section({
                            heading: "Card Size",
                            children: [
                                mod.controls.popout.components.radioButton({
                                    name: "cardSize",
                                    text: "Small",
                                    checked: cardSize === "small",
                                    value: "small"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "cardSize",
                                    text: "Medium",
                                    checked: cardSize === "medium",
                                    value: "medium"
                                }),
                                mod.controls.popout.components.radioButton({
                                    name: "cardSize",
                                    text: "Large",
                                    checked: cardSize === "large",
                                    value: "large"
                                })
                            ]
                        })
                    ]
                );
            });
        settingsButton.html(settingsIconSvg);
    }
}
