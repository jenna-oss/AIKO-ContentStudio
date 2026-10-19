import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { FONT_BOLD, FONT_REGULAR } from "../fonts";
import * as t from "../tokens";

export type Bar = { label: string; value: number; display: string; accent?: boolean; startFrame?: number; durationFrames?: number };

/** Animated vertical bar comparison -- bars grow via eased interpolate()
 * instead of a static render, matching render_mayweather_frames.py's
 * make_leverage_bars but with real CSS-driven growth. */
export const BarChart: React.FC<{ bars: Bar[]; maxValue: number; width: number; height: number }> = ({ bars, maxValue, width, height }) => {
  const frame = useCurrentFrame();
  const padX = 40;
  const padTop = 50;
  const padBottom = 60;
  const plotH = height - padTop - padBottom;
  const gap = 30;
  const barW = (width - 2 * padX - gap * (bars.length - 1)) / bars.length;

  return (
    <div style={{ position: "relative", width, height }}>
      <div style={{ position: "absolute", left: padX, right: padX, top: height - padBottom, height: 2, backgroundColor: "#b4b4af" }} />
      {bars.map((bar, i) => {
        const start = bar.startFrame ?? 0;
        const dur = bar.durationFrames ?? 20;
        const p = interpolate(frame, [start, start + dur], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.out(Easing.cubic),
        });
        const bh = Math.max((plotH * bar.value * p) / maxValue, 2);
        const x = padX + i * (barW + gap);
        const done = p >= 1;
        return (
          <React.Fragment key={i}>
            <div
              style={{
                position: "absolute",
                left: x,
                width: barW,
                bottom: padBottom,
                height: bh,
                backgroundColor: bar.accent ? t.BAR_ACCENT : t.BAR_COLOR,
              }}
            />
            {done && (
              <>
                <div
                  style={{
                    position: "absolute",
                    left: x,
                    width: barW,
                    bottom: padBottom + bh + 10,
                    textAlign: "center",
                    fontFamily: FONT_BOLD,
                    fontSize: 38,
                    color: "#141414",
                  }}
                >
                  {bar.display}
                </div>
                <div
                  style={{
                    position: "absolute",
                    left: x,
                    width: barW,
                    top: height - padBottom + 12,
                    textAlign: "center",
                    fontFamily: FONT_REGULAR,
                    fontSize: 28,
                    color: "#505050",
                  }}
                >
                  {bar.label}
                </div>
              </>
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
};
