import React from "react";
import { useCurrentFrame, useVideoConfig, spring, interpolate } from "remotion";
import { FONT_BOLD } from "../fonts";

/** Two plain text wordmarks connected by a "+", for partnership frames
 * where no official logo is accessible. Each side slides in from its own
 * edge and the "+" pops in once both have landed. */
export const LogoPair: React.FC<{ labels: [string, string]; width: number; height: number }> = ({ labels, width, height }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const leftS = spring({ frame: frame - 3, fps, config: { damping: 14, stiffness: 140 } });
  const rightS = spring({ frame: frame - 8, fps, config: { damping: 14, stiffness: 140 } });
  const plusOpacity = interpolate(frame - 16, [0, 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <div style={{ width, height, display: "flex", alignItems: "center", justifyContent: "center", gap: 24 }}>
      <div
        style={{
          fontFamily: FONT_BOLD,
          fontSize: 34,
          color: "#141414",
          textAlign: "center",
          flex: 1,
          opacity: leftS,
          transform: `translateX(${(1 - leftS) * -60}px)`,
        }}
      >
        {labels[0]}
      </div>
      <div style={{ fontSize: 30, color: "#a0a0a0", opacity: plusOpacity }}>+</div>
      <div
        style={{
          fontFamily: FONT_BOLD,
          fontSize: 34,
          color: "#141414",
          textAlign: "center",
          flex: 1,
          opacity: rightS,
          transform: `translateX(${(1 - rightS) * 60}px)`,
        }}
      >
        {labels[1]}
      </div>
    </div>
  );
};
