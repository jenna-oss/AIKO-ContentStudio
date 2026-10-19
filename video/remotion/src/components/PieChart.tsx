import React from "react";
import { useCurrentFrame, interpolate, Easing } from "remotion";
import { FONT_BOLD, FONT_REGULAR } from "../fonts";

export type Slice = { label: string; value: number; color: string };

/** Animated pie sweep -- the slice angle grows from 0 to its full extent
 * via a conic-gradient driven by interpolate(), then labels pop in above
 * and below the circle once the sweep finishes. */
export const PieChart: React.FC<{ slices: [Slice, Slice]; width: number; height: number; sweepDurationFrames?: number }> = ({
  slices,
  width,
  height,
  sweepDurationFrames = 27,
}) => {
  const frame = useCurrentFrame();
  const total = slices[0].value + slices[1].value;
  const p = interpolate(frame, [0, sweepDurationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.out(Easing.cubic),
  });
  const done = p >= 1;
  const r = Math.min(width, height) / 4;
  const cx = width / 2;
  const cy = height / 2;
  const sliceDeg = (360 * slices[0].value * p) / total;

  return (
    <div style={{ position: "relative", width, height }}>
      <div
        style={{
          position: "absolute",
          left: cx - r,
          top: cy - r,
          width: r * 2,
          height: r * 2,
          borderRadius: "50%",
          background: `conic-gradient(${slices[0].color} 0deg ${sliceDeg}deg, ${slices[1].color} ${sliceDeg}deg 360deg)`,
        }}
      />
      {done && (
        <>
          <PieLabel x={cx} y={20} value={slices[0].value} total={total} label={slices[0].label} />
          <PieLabel x={cx} y={cy + r + 30} value={slices[1].value} total={total} label={slices[1].label} />
        </>
      )}
    </div>
  );
};

const PieLabel: React.FC<{ x: number; y: number; value: number; total: number; label: string }> = ({ x, y, value, total, label }) => (
  <div style={{ position: "absolute", left: x - 150, top: y, width: 300, textAlign: "center" }}>
    <div style={{ fontFamily: FONT_BOLD, fontSize: 38, color: "#141414" }}>{Math.round((value / total) * 100)}%</div>
    <div style={{ fontFamily: FONT_REGULAR, fontSize: 28, color: "#5a5a5a" }}>{label}</div>
  </div>
);
