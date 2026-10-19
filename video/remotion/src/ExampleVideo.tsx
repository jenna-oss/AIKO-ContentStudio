// The reference video: how a generated video is wired (TransitionSeries, the
// s() helper, SWIPE, footage, captions, the closing frame) and what the AIKO
// brand looks like on a 1080x1920 frame. The pipeline points new videos here
// for mechanics only -- every new video designs its own scenes.
//
// The lines are AIKO's own approved copy, so the frames double as a brand check.
import React from "react";
import { AbsoluteFill, OffthreadVideo, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { TransitionSeries, linearTiming } from "@remotion/transitions";
import { slide } from "@remotion/transitions/slide";
import { wipe } from "@remotion/transitions/wipe";
import {
  DEEP, DISPLAY, DISPLAY_LEADING, ELECTRIC, H, HANDLE, INK, LABEL, PAPER, SAFE, SKY, SafeArea,
  TANGERINE, TEXT, W, Wordmark,
} from "./brand";
import { Captions } from "./Captions";

const FPS = 30;
export const SWIPE = Math.round(0.35 * FPS);
const s = (seconds: number) => Math.round(seconds * FPS);

/** Scene lengths in seconds, in order. Root.tsx sums these for the composition. */
export const EXAMPLE_SCENES = [4, 4, 4.5, 4.5, 4];

const useRise = (delay = 0) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  return spring({ frame: frame - delay, fps, config: { damping: 200 }, durationInFrames: 14 });
};

const Rail: React.FC<{ text: string; color: string }> = ({ text, color }) => (
  <div style={{ fontFamily: LABEL, fontWeight: 500, fontSize: 40, letterSpacing: "0.24em", textTransform: "uppercase", color }}>{text}</div>
);

/** Hard horizon: an Electric field meets a Tangerine field on a straight edge,
 *  and the two-part line lands half on each, each half in its own legal ink. */
const Horizon: React.FC = () => {
  const a = useRise(0);
  const b = useRise(8);
  return (
    <AbsoluteFill>
      <div style={{ position: "absolute", top: 0, left: 0, width: W, height: 980, backgroundColor: ELECTRIC }} />
      <div style={{ position: "absolute", top: 980, left: 0, width: W, height: H - 980, backgroundColor: TANGERINE }} />
      <div style={{ position: "absolute", left: SAFE.left, right: SAFE.right, bottom: H - 940, opacity: a, transform: `translateY(${(1 - a) * 30}px)` }}>
        <div style={{ fontFamily: DISPLAY, fontSize: 132, lineHeight: DISPLAY_LEADING, color: PAPER }}>Nobody hires the best person.</div>
      </div>
      <div style={{ position: "absolute", left: SAFE.left, right: SAFE.right, top: 1020, opacity: b, transform: `translateY(${(1 - b) * 30}px)` }}>
        <div style={{ fontFamily: DISPLAY, fontStyle: "italic", fontSize: 132, lineHeight: DISPLAY_LEADING, color: INK }}>They hire the one they remember.</div>
      </div>
    </AbsoluteFill>
  );
};

/** A number filling the frame on Paper, with a mono rail label. */
const Minutes: React.FC = () => {
  const frame = useCurrentFrame();
  const n = Math.round(interpolate(frame, [0, s(1.2)], [0, 20], { extrapolateRight: "clamp" }));
  return (
    <AbsoluteFill style={{ backgroundColor: PAPER }}>
      <SafeArea style={{ justifyContent: "center", alignItems: "center" }}>
        <Rail text="Your time, per month" color={ELECTRIC} />
        <div style={{ fontFamily: DISPLAY, fontSize: 520, lineHeight: 0.9, color: ELECTRIC }}>{n}</div>
        <div style={{ width: 160, height: 14, backgroundColor: TANGERINE, margin: "24px 0 40px" }} />
        <div style={{ fontFamily: DISPLAY, fontSize: 120, lineHeight: DISPLAY_LEADING, color: INK, textAlign: "center" }}>
          minutes <span style={{ fontStyle: "italic" }}>from you.</span>
        </div>
      </SafeArea>
    </AbsoluteFill>
  );
};

/** Cropped word: one word blown up past the edge until it is the ground. The
 *  copy over it sits on its own solid plate. */
const CroppedWord: React.FC = () => {
  const frame = useCurrentFrame();
  const drift = interpolate(frame, [0, s(4.5)], [0, -60]);
  const a = useRise(6);
  return (
    <AbsoluteFill style={{ backgroundColor: TANGERINE, overflow: "hidden" }}>
      <div style={{ position: "absolute", left: -40 + drift, top: 700, fontFamily: DISPLAY, fontSize: 900, lineHeight: 0.8, color: INK, whiteSpace: "nowrap" }}>voice</div>
      <SafeArea style={{ justifyContent: "flex-start" }}>
        <div style={{ backgroundColor: PAPER, padding: 48, opacity: a, transform: `translateY(${(1 - a) * 30}px)` }}>
          <div style={{ fontFamily: DISPLAY, fontSize: 116, lineHeight: DISPLAY_LEADING, color: INK }}>
            A week of posts <span style={{ fontStyle: "italic" }}>that sound like you.</span>
          </div>
        </div>
      </SafeArea>
    </AbsoluteFill>
  );
};

/** Dense data on Deep: Paper type, Sky for the secondary line, Electric dividers. */
const Steps: React.FC = () => {
  const rows: [string, string][] = [["Voice capture", "20 min, once"], ["System build", "0 min from you"], ["We run it", "5 min a week, optional"]];
  return (
    <AbsoluteFill style={{ backgroundColor: DEEP }}>
      <SafeArea style={{ justifyContent: "center" }}>
        <Rail text="How it works" color={SKY} />
        <div style={{ height: 40 }} />
        {rows.map(([title, time], i) => (
          <StepRow key={title} title={title} time={time} delay={i * 8} />
        ))}
      </SafeArea>
    </AbsoluteFill>
  );
};

const StepRow: React.FC<{ title: string; time: string; delay: number }> = ({ title, time, delay }) => {
  const a = useRise(delay);
  return (
    <div style={{ borderTop: `4px solid ${ELECTRIC}`, padding: "32px 0", opacity: a, transform: `translateX(${(1 - a) * 40}px)` }}>
      <div style={{ fontFamily: DISPLAY, fontSize: 110, lineHeight: DISPLAY_LEADING, color: PAPER }}>{title}</div>
      <div style={{ fontFamily: TEXT, fontWeight: 300, fontSize: 48, lineHeight: 1.4, color: SKY, marginTop: 12 }}>{time}</div>
    </div>
  );
};

/** Footage plays full-bleed; the text over it always sits on a solid plate.
 *  Not used by this example (it has no downloaded clip), kept as the pattern. */
export const FootageScene: React.FC<{ src: string; line: string }> = ({ src, line }) => (
  <AbsoluteFill style={{ backgroundColor: INK }}>
    <OffthreadVideo src={src} style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    <SafeArea style={{ justifyContent: "flex-end" }}>
      <div style={{ backgroundColor: PAPER, padding: 40, fontFamily: DISPLAY, fontSize: 110, lineHeight: DISPLAY_LEADING, color: INK }}>{line}</div>
    </SafeArea>
  </AbsoluteFill>
);

/** The closing frame: wordmark, takeaway, handle. */
const Close: React.FC = () => {
  const a = useRise(0);
  return (
    <AbsoluteFill style={{ backgroundColor: ELECTRIC }}>
      <SafeArea style={{ justifyContent: "space-between", opacity: a }}>
        <Wordmark ground={ELECTRIC} size={120} />
        <div style={{ fontFamily: DISPLAY, fontSize: 128, lineHeight: DISPLAY_LEADING, color: PAPER }}>
          You already know your work. <span style={{ fontStyle: "italic" }}>Let your niche find out.</span>
        </div>
        <div style={{ fontFamily: LABEL, fontWeight: 500, fontSize: 44, letterSpacing: "0.22em", textTransform: "uppercase", color: PAPER }}>Follow {HANDLE}</div>
      </SafeArea>
    </AbsoluteFill>
  );
};

export const ExampleVideo: React.FC = () => (
  <AbsoluteFill>
    <TransitionSeries>
      <TransitionSeries.Sequence durationInFrames={s(EXAMPLE_SCENES[0])}><Horizon /></TransitionSeries.Sequence>
      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: SWIPE })} presentation={slide({ direction: "from-right" })} />
      <TransitionSeries.Sequence durationInFrames={s(EXAMPLE_SCENES[1])}><Minutes /></TransitionSeries.Sequence>
      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: SWIPE })} presentation={wipe({ direction: "from-left" })} />
      <TransitionSeries.Sequence durationInFrames={s(EXAMPLE_SCENES[2])}><CroppedWord /></TransitionSeries.Sequence>
      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: SWIPE })} presentation={slide({ direction: "from-bottom" })} />
      <TransitionSeries.Sequence durationInFrames={s(EXAMPLE_SCENES[3])}><Steps /></TransitionSeries.Sequence>
      <TransitionSeries.Transition timing={linearTiming({ durationInFrames: SWIPE })} presentation={wipe({ direction: "from-top" })} />
      <TransitionSeries.Sequence durationInFrames={s(EXAMPLE_SCENES[4])}><Close /></TransitionSeries.Sequence>
    </TransitionSeries>
    <Captions slug="example" emphasis={["remember", "twenty"]} />
  </AbsoluteFill>
);
