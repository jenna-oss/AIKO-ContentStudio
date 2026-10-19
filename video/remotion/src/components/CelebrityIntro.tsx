import React from "react";
import { AbsoluteFill, Img, staticFile, useCurrentFrame, spring, useVideoConfig } from "remotion";
import { BounceText } from "./BounceText";
import * as t from "../tokens";

/** Frame 1 template: headline with the subject's name highlighted in a
 * black box, then a real background-removed cutout photo below --
 * mirrors render_celebrity_intro.py, plus a subtle spring-in on the photo. */
export const CelebrityIntro: React.FC<{
  headline: string;
  highlightPhrase: string;
  cutoutSrc: string;
}> = ({ headline, highlightPhrase, cutoutSrc }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const photoScale = spring({ frame: frame - 4, fps, config: { damping: 14, stiffness: 120 } });

  // Wrap headline text into styled markup: the highlight phrase gets a
  // black background box, matching the reference GuildShore template.
  const marked = headline.replace(highlightPhrase, `[[${highlightPhrase}]]`);
  const segments = marked.split(/(\[\[[^\]]+\]\])/g).filter(Boolean);

  return (
    <AbsoluteFill style={{ backgroundColor: "#ffffff" }}>
      <div style={{ position: "absolute", top: 300, left: 90, right: 90 }}>
        <HighlightHeadline segments={segments} />
      </div>
      <div
        style={{
          position: "absolute",
          top: 700,
          left: (t.W - 700) / 2,
          width: 700,
          transform: `scale(${Math.min(photoScale, 1)})`,
          transformOrigin: "top center",
        }}
      >
        <Img src={cutoutSrc} style={{ width: "100%" }} />
      </div>
    </AbsoluteFill>
  );
};

const HighlightHeadline: React.FC<{ segments: string[] }> = ({ segments }) => {
  const frame = useCurrentFrame();
  let wordIdx = 0;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "0 0.28em", fontFamily: "AgencyFB-Bold", fontSize: 64, lineHeight: 1.22 }}>
      {segments.map((seg, si) => {
        const isHighlight = seg.startsWith("[[");
        const clean = isHighlight ? seg.slice(2, -2) : seg;
        return clean.split(" ").filter(Boolean).map((w, wi) => {
          const idx = wordIdx++;
          const start = 2 + idx * 2.5;
          const opacity = Math.min(1, Math.max(0, (frame - start) / 4));
          const rise = (1 - Math.min(1, Math.max(0, (frame - start) / 8))) * 22;
          return (
            <span
              key={`${si}-${wi}`}
              style={{
                opacity,
                transform: `translateY(${rise}px)`,
                backgroundColor: isHighlight ? "#0a0a0a" : "transparent",
                color: isHighlight ? "#ffffff" : "#0a0a0a",
                padding: isHighlight ? "2px 10px" : undefined,
              }}
            >
              {w}
            </span>
          );
        });
      })}
    </div>
  );
};
