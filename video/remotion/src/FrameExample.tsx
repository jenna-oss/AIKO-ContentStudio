import React from "react";
import { AbsoluteFill } from "remotion";
import { BounceText } from "./components/BounceText";
import { ensureFontsLoaded } from "./fonts";
import * as t from "./tokens";

/** Standalone test frame -- not part of any video, used to iterate quickly
 * on type scale/palette without re-rendering a full multi-scene video. */
export const FrameExample: React.FC = () => {
  ensureFontsLoaded();
  return (
    <AbsoluteFill style={{ backgroundColor: t.BG, justifyContent: "center", alignItems: "center" }}>
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", padding: "0 30px" }}>
        <div style={{ fontFamily: "AgencyFB-Bold", fontSize: 64, color: t.BAR_ACCENT, letterSpacing: 7, marginBottom: 34 }}>THE BUY</div>
        <BounceText text="$240,000" fontSize={168} color={t.INK} startFrame={0} stagger={0} />
        <div style={{ marginTop: 34 }}>
          <BounceText text="the listing price" fontSize={64} color="#3E5872" startFrame={0} stagger={0} />
        </div>
        <div style={{ marginTop: 80, backgroundColor: t.CAPTION_BG, borderRadius: 12, padding: "30px 38px", maxWidth: 980 }}>
          <BounceText
            text="A 20-something bodybuilder bought his first six-unit building for this."
            fontSize={58}
            color={t.CAPTION_FG}
            startFrame={0}
            stagger={0}
            align="center"
          />
        </div>
      </div>
    </AbsoluteFill>
  );
};
