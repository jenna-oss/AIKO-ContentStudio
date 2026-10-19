// The AIKO Group brand (direction 8C: Instrument Serif and a tangerine rule, on
// electric blue and tangerine). A new video takes its colours, fonts, wordmark
// and safe zone from here and nowhere else.
//
// There are no layouts in this file on purpose: every video designs its own
// scenes from scratch, for variety. What stays fixed is the brand.
import React from "react";
import { loadFont as loadInstrumentSerif } from "@remotion/google-fonts/InstrumentSerif";
import { loadFont as loadPublicSans } from "@remotion/google-fonts/PublicSans";
import { loadFont as loadPlexMono } from "@remotion/google-fonts/IBMPlexMono";

const serif = loadInstrumentSerif("normal", { weights: ["400"], subsets: ["latin"] });
loadInstrumentSerif("italic", { weights: ["400"], subsets: ["latin"] });
const sans = loadPublicSans("normal", { weights: ["300", "400", "500", "600"], subsets: ["latin"] });
const mono = loadPlexMono("normal", { weights: ["400", "500"], subsets: ["latin"] });

/** Instrument Serif, weight 400: every hook, headline, big number and the
 *  wordmark. Roman for the statement, italic for the turn -- the word or
 *  clause that reframes it, once per scene. Never negative tracking. */
export const DISPLAY = serif.fontFamily;
/** Public Sans: body copy only (300 for running text, 400-500 for UI). Never a hook. */
export const TEXT = sans.fontFamily;
/** IBM Plex Mono, 400-500: rail labels, counters, handles, eyebrows. Uppercase,
 *  letterSpacing 0.2em-0.28em. */
export const LABEL = mono.fontFamily;

// Grounds and inks.
/** The workhorse ground: about a third of all scenes. */
export const ELECTRIC = "#3150FD";
/** Electric's equal partner, not an accent: grounds, blocks, the rule. */
export const TANGERINE = "#FC3D05";
export const PAPER = "#F3F5F9";
/** Cards and tiles on Paper. */
export const PAPER_RAISED = "#F9FAFC";
/** Dark blue ground for dense data. */
export const DEEP = "#0B1A5C";
export const INK = "#101114";
/** Hairlines and card borders on Paper. */
export const LINE = "#D9DEE7";
/** Secondary copy on Paper. */
export const SLATE = "#3C4450";
/** Secondary copy on Deep. */
export const SKY = "#C3CCE8";
/** Secondary copy on Tangerine. */
export const INK_WARM = "#2A1305";

export const PALETTE = [ELECTRIC, TANGERINE, PAPER, PAPER_RAISED, DEEP, INK, LINE, SLATE, SKY, INK_WARM] as const;

/** What may sit on each ground. These are the only legal pairings: Tangerine
 *  type only ever on Ink, never on Paper, Electric or Deep; Electric and
 *  Tangerine meet as blocks, never as type on type. The rule is Tangerine
 *  everywhere except on Tangerine, where it is Ink. */
export const ON = {
  [ELECTRIC]: { type: [PAPER], secondary: PAPER, rule: TANGERINE },
  [TANGERINE]: { type: [INK], secondary: INK_WARM, rule: INK },
  [PAPER]: { type: [INK, ELECTRIC], secondary: SLATE, rule: TANGERINE },
  [PAPER_RAISED]: { type: [INK, ELECTRIC], secondary: SLATE, rule: TANGERINE },
  [INK]: { type: [PAPER, TANGERINE], secondary: PAPER, rule: TANGERINE },
  [DEEP]: { type: [PAPER], secondary: SKY, rule: TANGERINE },
} as const;
export type Ground = keyof typeof ON;

export const W = 1080;
export const H = 1920;

/** Brand margin on a 1080 canvas: 88px. */
export const MARGIN = 88;

/** The Reels safe zone, in px from each edge. Text and faces stay inside it,
 *  clear of the top bar, the like/comment/share column on the right, and the
 *  caption and handle at the bottom. Wider than the brand margin, so it wins. */
export const SAFE = { top: 180, right: 150, bottom: 440, left: 110 } as const;
export const SAFE_W = W - SAFE.left - SAFE.right;

/** Captions sit at the bottom of the safe zone; scene text stays above them. */
export const CAPTION_SIZE = 56;
export const SCENE_BOTTOM = H - SAFE.bottom - 200;
/** How far up from the bottom edge scene content aims to stay. */
export const SCENE_FLOOR = H - SCENE_BOTTOM;
/** The top of the caption box at its tallest (two lines), in px from the
 *  bottom edge. When a scene needs the room, its text may dip below
 *  SCENE_FLOOR, but never below this: that is where it would hit the captions. */
export const CAPTION_TOP = SAFE.bottom + 160;
/** How far past the safe zone's top, left and right edges text may go when a
 *  scene needs the room to keep from overlapping. */
export const SAFE_SLACK = 40;

/** The part of the frame scene text may use: inside the Reels safe zone and
 *  above the captions. It is a positioned box, so absolute children are
 *  placed relative to it: `bottom: 0` in here sits just above the captions.
 *  Full-bleed backgrounds and footage go outside it; text goes inside.
 *  Plumbing, not a layout -- what goes in it is designed per scene.
 *
 *  A flex column, so a scene's alignItems / justifyContent take effect. With
 *  no style it stacks top to bottom at full width. */
export const SafeArea: React.FC<{ children?: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) =>
  React.createElement(
    "div",
    {
      style: {
        position: "absolute", top: SAFE.top, left: SAFE.left, right: SAFE.right, bottom: SCENE_FLOOR,
        display: "flex", flexDirection: "column",
        ...style,
      },
    },
    children,
  );

/** Text-size floors, px on the 1080x1920 frame. The brand's floor for body
 *  copy on a 1080 canvas is 36px; this keeps a little above it. */
export const MIN_HEADLINE = 110;
export const MIN_TEXT = 40;

/** Display line-height: 0.92-0.98. Body: 1.24-1.7. */
export const DISPLAY_LEADING = 0.95;

export const HANDLE = "@aikogroup.ai";

/** The wordmark: roman caps AIKO and italic Group, with a rule above. There is
 *  no symbol; the rule is the mark. `size` is the type size in px. Colours
 *  follow the ground: Paper on Electric, Ink on Tangerine (rule Ink too), on
 *  Paper AIKO in Ink and Group in Electric. On Ink or Deep, Paper. */
export const Wordmark: React.FC<{ ground: Ground; size?: number; style?: React.CSSProperties }> = ({ ground, size = 96, style }) => {
  const cap = size * 0.7;
  const onLight = ground === PAPER || ground === PAPER_RAISED;
  const word = ground === TANGERINE || onLight ? INK : PAPER;
  const group = onLight ? ELECTRIC : word;
  return React.createElement(
    "div",
    { style: { display: "inline-flex", flexDirection: "column", alignItems: "flex-start", gap: cap / 8, ...style } },
    // Rule: about 1.3x the cap height wide, a quarter of it thick.
    React.createElement("div", { style: { width: cap * 1.3, height: cap / 4, backgroundColor: ON[ground].rule } }),
    React.createElement(
      "div",
      { style: { fontFamily: DISPLAY, fontWeight: 400, fontSize: size, lineHeight: 0.9, letterSpacing: "0.005em", color: word, whiteSpace: "nowrap" } },
      "AIKO ",
      React.createElement("span", { style: { fontStyle: "italic", color: group } }, "Group"),
    ),
  );
};
