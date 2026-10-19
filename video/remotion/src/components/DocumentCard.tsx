import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { FONT_BOLD, FONT_REGULAR } from "../fonts";

/** A styled recreation of a real article's headline + a paraphrased body
 * sentence, with a yellow highlighter box over the cited phrase -- the
 * "real artifact evidence" card, not a literal screenshot. The card itself
 * scales/fades in, and the highlight box wipes on a beat after the body
 * text has landed, like a highlighter stroke being drawn. */
export const DocumentCard: React.FC<{
  source: string;
  headline: string;
  body: string;
  highlightPhrase?: string;
  width: number;
  height: number;
  logoSrc?: string;
}> = ({ source, headline, body, highlightPhrase, width, height, logoSrc }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cardS = spring({ frame, fps, config: { damping: 15, stiffness: 130 } });
  const highlightW = interpolate(frame - 20, [0, 12], [0, 100], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const bodyParts = highlightPhrase ? body.split(highlightPhrase) : [body];
  return (
    <div
      style={{
        width,
        height,
        backgroundColor: "#ffffff",
        padding: 40,
        boxSizing: "border-box",
        opacity: cardS,
        transform: `scale(${0.9 + cardS * 0.1})`,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ fontFamily: FONT_REGULAR, fontSize: 20, color: "#787878", letterSpacing: 1 }}>{source.toUpperCase()}</div>
        {logoSrc && <img src={logoSrc} style={{ height: 22, opacity: 0.85 }} />}
      </div>
      <div style={{ borderBottom: "2px solid #d2d2cd", margin: "16px 0 20px" }} />
      <div style={{ fontFamily: FONT_BOLD, fontSize: 32, color: "#0f0f0f", lineHeight: 1.25, marginBottom: 18 }}>{headline}</div>
      <div style={{ fontFamily: FONT_REGULAR, fontSize: 24, color: "#323232", lineHeight: 1.5 }}>
        {bodyParts.length === 2 ? (
          <>
            {bodyParts[0]}
            <span
              style={{
                background: `linear-gradient(90deg, #ffeb5a ${highlightW}%, transparent ${highlightW}%)`,
                color: "#141414",
              }}
            >
              {highlightPhrase}
            </span>
            {bodyParts[1]}
          </>
        ) : (
          body
        )}
      </div>
    </div>
  );
};
