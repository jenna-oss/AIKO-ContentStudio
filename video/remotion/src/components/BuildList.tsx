import React from "react";
import { AbsoluteFill, useCurrentFrame, interpolate } from "remotion";
import { FONT_BOLD } from "../fonts";
import { BounceText } from "./BounceText";
import * as t from "../tokens";

/** Progressive list reveal -- items appear one at a time (each bouncing in)
 * rather than a 3-stage crossfade between static images. */
export const BuildList: React.FC<{
  header: string;
  items: string[];
  itemStaggerFrames?: number;
  headerFontSize?: number;
  itemFontSize?: number;
}> = ({ header, items, itemStaggerFrames = 24, headerFontSize = 100, itemFontSize = 62 }) => {
  const frame = useCurrentFrame();
  const headerW = header.length * (headerFontSize * 0.44); // rough estimate for the underline width

  return (
    <AbsoluteFill style={{ backgroundColor: t.BG, justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center" }}>
        <BounceText text={header} fontSize={headerFontSize} color={t.INK} startFrame={2} stagger={3} />
        <div style={{ width: Math.min(headerW, 560), height: 3, backgroundColor: t.BAR_ACCENT, marginTop: 20, marginBottom: 60 }} />
        {items.map((item, i) => {
          const itemStart = 20 + i * itemStaggerFrames;
          const opacity = interpolate(frame - itemStart, [0, 1], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
          if (opacity <= 0) return <div key={i} style={{ height: itemFontSize * 1.56 }} />;
          return (
            <div key={i} style={{ display: "flex", gap: 22, alignItems: "flex-start", marginBottom: 38, maxWidth: 900 }}>
              <div style={{ fontFamily: FONT_BOLD, fontSize: itemFontSize, color: t.INK }}>{i + 1}.</div>
              <BounceText text={item} fontSize={itemFontSize} color={t.INK} align="left" startFrame={itemStart} stagger={2} maxWidth={760} />
            </div>
          );
        })}
      </div>
    </AbsoluteFill>
  );
};
