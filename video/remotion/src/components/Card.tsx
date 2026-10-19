import React from "react";
import { AbsoluteFill } from "remotion";
import { BounceText } from "./BounceText";
import * as t from "../tokens";

function headerFontSize(header: string): number {
  const n = header.length;
  if (n <= 10) return 130;
  if (n <= 16) return 108;
  if (n <= 24) return 86;
  return 68;
}

// Rough heuristic to estimate how many lines the caption will wrap to, so
// the whole block (header + inset + caption) can be centered as one unit
// without a real DOM text-measurement pass.
function estimateLines(text: string, fontSize: number, maxWidth: number): number {
  const avgCharWidth = fontSize * 0.52;
  const charsPerLine = Math.max(1, Math.floor(maxWidth / avgCharWidth));
  return Math.max(1, Math.ceil(text.replace(/\*\*/g, "").length / charsPerLine));
}

const GAP_HEADER_TO_MIDDLE = 60;
const GAP_MIDDLE_TO_LAST = 60;
const CAPTION_MAX_WIDTH = 860;

/**
 * The bordered-inset card. The whole header+inset+caption block is
 * vertically centered as one unit (computed from real font sizes, not
 * fixed pixel offsets), so different insetH/headerSize combinations never
 * leave an awkward dead-space gap at the bottom.
 */
export const Card: React.FC<{
  header: string;
  caption: string;
  insetW?: number;
  insetH?: number;
  headerSize?: number;
  headerAlign?: "center" | "left";
  captionFontSize?: number;
  captionPosition?: "above" | "below";
  bg?: string;
  children: React.ReactNode;
}> = ({
  header,
  caption,
  insetW = 640,
  insetH = 480,
  headerSize,
  headerAlign = "center",
  captionFontSize = 54,
  captionPosition = "below",
  bg = t.BG,
  children,
}) => {
  const size = headerSize ?? headerFontSize(header);
  const headerH = size * 1.25;
  const captionLines = estimateLines(caption, captionFontSize, CAPTION_MAX_WIDTH);
  const captionH = captionLines * captionFontSize * 1.28 + 34;

  const totalH = headerH + GAP_HEADER_TO_MIDDLE + insetH + GAP_MIDDLE_TO_LAST + captionH;
  const top = (t.H - totalH) / 2;

  const headerY = top;
  let insetY: number;
  let captionY: number;
  if (captionPosition === "below") {
    insetY = top + headerH + GAP_HEADER_TO_MIDDLE;
    captionY = insetY + insetH + GAP_MIDDLE_TO_LAST;
  } else {
    captionY = top + headerH + GAP_HEADER_TO_MIDDLE;
    insetY = captionY + captionH + GAP_MIDDLE_TO_LAST;
  }

  const insetX = (t.W - insetW) / 2;

  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      <div
        style={{
          position: "absolute",
          top: headerY,
          left: headerAlign === "left" ? 70 : 0,
          right: headerAlign === "left" ? undefined : 0,
        }}
      >
        <BounceText text={header} fontSize={size} color={t.INK} startFrame={2} stagger={2.5} align={headerAlign} maxWidth={headerAlign === "left" ? 800 : undefined} />
      </div>

      <div
        style={{
          position: "absolute",
          top: insetY,
          left: insetX,
          width: insetW,
          height: insetH,
          border: `1.5px solid ${t.BAR_ACCENT}`,
          boxShadow: "0 22px 48px rgba(0,31,73,0.22)",
          backgroundColor: t.INSET_BG,
          overflow: "hidden",
        }}
      >
        {children}
      </div>

      <div
        style={{
          position: "absolute",
          top: captionY,
          left: 60,
          right: 60,
          display: "flex",
          justifyContent: headerAlign === "left" ? "flex-start" : "center",
        }}
      >
        <div
          style={{
            backgroundColor: t.CAPTION_BG,
            borderRadius: 8,
            padding: "17px 24px",
            maxWidth: CAPTION_MAX_WIDTH,
          }}
        >
          <BounceText text={caption} fontSize={captionFontSize} color={t.CAPTION_FG} startFrame={10} stagger={2.2} align={headerAlign} />
        </div>
      </div>
    </AbsoluteFill>
  );
};
