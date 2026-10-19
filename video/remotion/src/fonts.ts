import { staticFile } from "remotion";

// Fraunces (a variable serif, editorial/luxury feel -- much more weighted
// and sophisticated than the earlier condensed sans, Agency FB). Kept
// under the SAME family names every video/component already references
// ("AgencyFB-Bold"/"AgencyFB-Regular") so swapping the typeface required
// touching only this one file: both aliases point at the same variable
// font file, distinguished only by the font-weight descriptor (900 for
// the "Bold" role, 600 for the "Regular" role -- still heavy, nothing in
// this brand should read as thin).
export const FONT_BOLD = "AgencyFB-Bold";
export const FONT_REGULAR = "AgencyFB-Regular";

let injected = false;

export function ensureFontsLoaded() {
  if (injected || typeof document === "undefined") return;
  injected = true;
  const style = document.createElement("style");
  style.textContent = `
    @font-face {
      font-family: '${FONT_BOLD}';
      src: url('${staticFile("fonts/Fraunces-Variable.woff2")}') format('woff2');
      font-weight: 900;
    }
    @font-face {
      font-family: '${FONT_REGULAR}';
      src: url('${staticFile("fonts/Fraunces-Variable.woff2")}') format('woff2');
      font-weight: 600;
    }
  `;
  document.head.appendChild(style);
}
