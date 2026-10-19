// A short cut out of a long take: the footage itself, the brand's captions
// burned onto it, and the hook over the opening seconds on solid plates.
//
// The captions are the same component the made-from-scratch videos use, fed
// the same way — public/<slug>/captions.json — so a clip and a rendered video
// caption identically. The words come from the take's transcript with their
// timings rebased to this clip's own clock, which is why nothing has to be
// transcribed twice.
//
// The hook is the sentence the clip opens on, in Instrument Serif on two
// stacked plates that meet as blocks: the statement in Paper on Electric, the
// turn in Ink italic on Tangerine. Copy over a picture always sits on a plate.
import React from "react";
import { AbsoluteFill, OffthreadVideo, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { DISPLAY, ELECTRIC, INK, PAPER, SAFE, SAFE_W, TANGERINE } from "./brand";
import { Captions } from "./Captions";

/** How long the hook holds before the ordinary captions carry it. */
const HOOK_S = 2.6;
/** Big, because it is the thing someone reads before deciding to stay — but
 *  only as big as will fit on one line, or the box wraps and the brand's two
 *  tidy blocks become one ragged slab. Instrument Serif runs about 0.44em a
 *  character; it is narrow, so it can go bigger than a grotesque. */
const HOOK_MAX = 104;
const HOOK_MIN = 48;
const CHAR_EM = 0.44;

function hookSize(lines: string[]): number {
  const longest = Math.max(...lines.map((l) => l.length), 1);
  const fits = SAFE_W / (CHAR_EM * longest);
  return Math.max(HOOK_MIN, Math.min(HOOK_MAX, Math.floor(fits)));
}

/** The most the card can hold in the two lines the guide draws. Past about 74
 *  characters the font has already shrunk as far as it goes and the card just
 *  grows downward — a 30-word opener came out six lines deep, over his face.
 *  He still says the whole sentence; this is only what is worth reading at a
 *  glance. */
const HOOK_CHARS = 70;

function shorten(text: string): string {
  const whole = text.trim();
  if (whole.length <= HOOK_CHARS) return whole;

  const window = whole.slice(0, HOOK_CHARS + 1);
  /* A clause break reads as a finished thought; a cut mid-phrase does not. */
  const clause = Math.max(
    window.lastIndexOf(", "),
    window.lastIndexOf("; "),
    window.lastIndexOf(" — "),
    window.lastIndexOf(": "),
  );
  const cut = clause > HOOK_CHARS * 0.3 ? clause : window.lastIndexOf(" ");
  return whole.slice(0, cut > 0 ? cut : HOOK_CHARS).replace(/[,;:\s]+$/, "").trim();
}

/** Split a sentence into two balanced lines, on a word. One line if it is
 *  short enough to need only one. */
function twoLines(text: string): string[] {
  const words = text.trim().split(/\s+/);
  if (words.length <= 4) return [words.join(" ")];
  let best = 1;
  let closest = Infinity;
  for (let i = 1; i < words.length; i += 1) {
    const left = words.slice(0, i).join(" ").length;
    const right = words.slice(i).join(" ").length;
    const gap = Math.abs(left - right);
    if (gap < closest) { closest = gap; best = i; }
  }
  return [words.slice(0, best).join(" "), words.slice(best).join(" ")];
}

/* display:inline, not inline-block: an inline box fragments across lines and
   box-decoration-break clones the background onto each fragment, which is what
   gives the guide its tight box per line. An inline-block cannot fragment, so
   a long line wrapped inside one rectangle and left a ragged edge. */
const Line: React.FC<{ text: string; size: number; turn?: boolean }> = ({ text, size, turn }) => (
  <div style={{ lineHeight: 1.3 }}>
    <span
      style={{
        display: "inline",
        backgroundColor: turn ? TANGERINE : ELECTRIC,
        color: turn ? INK : PAPER,
        fontFamily: DISPLAY,
        fontWeight: 400,
        fontStyle: turn ? "italic" : "normal",
        fontSize: size,
        letterSpacing: "0.005em",
        padding: "0.1em 0.22em",
        boxDecorationBreak: "clone",
        WebkitBoxDecorationBreak: "clone",
      }}
    >
      {text}
    </span>
  </div>
);

const Hook: React.FC<{ text: string }> = ({ text }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (t > HOOK_S) return null;

  const lines = twoLines(shorten(text));
  const size = hookSize(lines);
  return (
    <AbsoluteFill
      style={{
        padding: `${SAFE.top}px ${SAFE.right}px ${SAFE.bottom}px ${SAFE.left}px`,
        alignItems: "flex-start",
        justifyContent: "flex-start",
      }}
    >
      <div style={{ width: SAFE_W }}>
        {lines.map((line, i) => (
          <Line key={line + i} text={line} size={size} turn={i === 1} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

export type ClipProps = {
  /** The folder under public/ holding clip.mp4 and captions.json. */
  slug: string;
  /** What the clip opens on. Empty renders no hook card. */
  hook?: string;
  /** Seconds — the composition's length is worked out from this. */
  seconds: number;
  /** Words the captions should put in Tangerine. */
  emphasis?: string[];
};

export const Clip: React.FC<ClipProps> = ({ slug, hook, emphasis = [] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const showing = hook ? frame / fps <= HOOK_S : false;

  return (
    <AbsoluteFill style={{ backgroundColor: INK }}>
      <OffthreadVideo
        src={staticFile(`${slug}/clip.mp4`)}
        style={{ width: "100%", height: "100%", objectFit: "cover" }}
      />
      {hook ? <Hook text={hook} /> : null}
      {/* While the hook card is up the captions would be saying the same words
          underneath it, which reads as a mistake. They carry on from there. */}
      <AbsoluteFill style={{ opacity: showing ? 0 : 1 }}>
        <Captions slug={slug} emphasis={emphasis} />
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
