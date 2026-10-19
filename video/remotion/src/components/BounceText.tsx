import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { FONT_BOLD, FONT_REGULAR } from "../fonts";

/**
 * Word-by-word cascade using real spring physics (Remotion's spring())
 * instead of a hand-tuned ease-out-back approximation -- each word rises
 * into place with natural overshoot, staggered by a per-word delay.
 *
 * `text` may contain **bold** markup (mirrors card_style.py's auto_bold
 * convention) to render specific words/numbers in the bold weight while
 * the rest stays regular.
 */
export const BounceText: React.FC<{
  text: string;
  fontSize: number;
  color: string;
  align?: "center" | "left";
  startFrame?: number;
  stagger?: number;
  maxWidth?: number;
  bold?: boolean;
}> = ({ text, fontSize, color, align = "center", startFrame = 0, stagger = 3, maxWidth, bold = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  const words: { w: string; bold: boolean }[] = [];
  for (const part of parts) {
    const isBold = part.startsWith("**") && part.endsWith("**");
    const clean = isBold ? part.slice(2, -2) : part;
    for (const w of clean.split(" ")) {
      if (w) words.push({ w, bold: isBold || bold });
    }
  }

  return (
    <div
      style={{
        display: "flex",
        flexWrap: "wrap",
        justifyContent: align === "center" ? "center" : "flex-start",
        maxWidth,
        margin: align === "center" ? "0 auto" : undefined,
      }}
    >
      {words.map((word, i) => {
        const wordStart = startFrame + i * stagger;
        const s = spring({
          frame: frame - wordStart,
          fps,
          config: { damping: 12, stiffness: 200, mass: 0.6 },
        });
        const opacity = interpolate(frame - wordStart, [0, 4], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
        });
        const rise = (1 - s) * 26;
        return (
          <span
            key={i}
            style={{
              fontFamily: word.bold ? FONT_BOLD : FONT_REGULAR,
              fontSize,
              color,
              opacity,
              transform: `translateY(${rise}px)`,
              display: "inline-block",
              whiteSpace: "nowrap",
              marginRight: i < words.length - 1 ? "0.28em" : 0,
            }}
          >
            {word.w}
          </span>
        );
      })}
    </div>
  );
};
