import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig, interpolate, Easing } from "remotion";
import { FONT_BOLD, FONT_REGULAR } from "../fonts";
import { BounceText } from "./BounceText";
import * as t from "../tokens";

/**
 * Full-bleed giant stat -- no card, no border. If `targetValue` is given
 * the number counts up (matching render_giant_stat_animated.py); otherwise
 * `text` is shown as a static string that still bounces in.
 */
export const GiantStat: React.FC<{
  text: string;
  label: string;
  targetValue?: number;
  prefix?: string;
  countDurationFrames?: number;
}> = ({ text, label, targetValue, prefix = "$", countDurationFrames = 33 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  let shown = text;
  let done = true;
  if (targetValue !== undefined) {
    const p = interpolate(frame, [0, countDurationFrames], [0, 1], {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.out(Easing.cubic),
    });
    done = p >= 1;
    shown = `${prefix}${Math.round(targetValue * p).toLocaleString()}`;
  }

  return (
    <AbsoluteFill style={{ backgroundColor: t.BG, justifyContent: "center", alignItems: "center" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontFamily: FONT_BOLD, fontSize: 190, color: t.INK, lineHeight: 1 }}>{shown}</div>
        {done && (
          <div style={{ marginTop: 28 }}>
            <BounceText
              text={label}
              fontSize={60}
              color={t.INK}
              startFrame={targetValue !== undefined ? countDurationFrames : 2}
              stagger={2.5}
            />
          </div>
        )}
      </div>
    </AbsoluteFill>
  );
};
