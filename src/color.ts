/**
 * Relative luminance of a #RRGGBB (or #RGB) color, per the WCAG 2.0 definition.
 */
function getLuminance(hexCode: string): number {
    let hex = hexCode.replace("#", "");
    if (hex.length == 3) {
        hex = hex
            .split("")
            .map((c) => c + c)
            .join("");
    }

    let channels = [0, 2, 4].map((offset) => {
        let channel = parseInt(hex.substring(offset, offset + 2), 16) / 255;
        return channel <= 0.03928 ? channel / 12.92 : Math.pow((channel + 0.055) / 1.055, 2.4);
    });

    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

export function contrastColor(hexCode: string): string {
    let L = getLuminance(hexCode);

    if ((L + 0.05) / (0.0 + 0.05) > (1.0 + 0.05) / (L + 0.05)) {
        return "#000000";
    } else {
        return "#ffffff";
    }
}
