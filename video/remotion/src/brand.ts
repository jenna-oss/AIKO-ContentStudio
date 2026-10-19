// The Buy Box brand, from its brand guide (v1.1, Sep 2026). A new video takes
// its colors, fonts, logo and safe zone from here and nowhere else.
//
// There are no layouts in this file on purpose: every video designs its own
// scenes from scratch, for variety. What stays fixed is the brand.
import React from "react";
import { staticFile } from "remotion";
import { loadFont as loadArchivo } from "@remotion/google-fonts/Archivo";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";

const archivo = loadArchivo("normal", { weights: ["700", "800", "900"], subsets: ["latin"] });
const inter = loadInter("normal", { weights: ["500", "600", "700", "800"], subsets: ["latin"] });

/** Archivo: every headline, title and big number (weights 700-900). */
export const HEAD = archivo.fontFamily;
/** Inter: labels, captions and other small copy (weights 500-800). */
export const BODY = inter.fontFamily;

// Surfaces
export const BLACK = "#000000";
export const WHITE = "#FFFFFF";
/** Secondary surface: panels and cards on white. */
export const CONCRETE = "#E6E7E8";
/** Secondary surface: small labels and rules. */
export const GRAPHITE = "#6A6E72";

// Accents. Each one means something, so the viewer learns to read them.
/** Site Orange: the one thing to look at in a scene -- the problem, the cost, the key word or number. */
export const ORANGE = "#FF5A1F";
/** Pencil: the answer -- fundable, the fix, "after". */
export const GREEN = "#0E7A42";

export const PALETTE = [BLACK, WHITE, CONCRETE, GRAPHITE, ORANGE, GREEN] as const;

export const W = 1080;
export const H = 1920;

/** The Reels safe zone (page 5 of the guide), in px from each edge. Text and
 *  faces stay inside it, clear of the top bar, the like/comment/share column
 *  on the right, and the caption and handle at the bottom. */
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
 *  A flex column, so a scene's alignItems / justifyContent take effect. It
 *  was a plain block, which silently ignored them: every scene that asked to
 *  be centred stacked top-left instead (found 2026-09-19). With no style it
 *  still stacks top to bottom at full width, as a block did. */
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

/** The opening photograph's black frame: a tall rectangle of picture with
 *  black around it, and the scene's headline boxes straddling one of its
 *  edges, half on the picture and half on the black. Two placements, so the
 *  videos don't all open the same way: `high` puts the picture up and the
 *  words across its bottom edge, `low` puts it down and the words across its
 *  top edge. Same size either way; the numbers live here, not in each
 *  video's own file. */
export const PHOTO_FRAME = {
  left: 90,
  width: 900,
  /** Picture up, words across its bottom edge. */
  high: { top: 150, height: 1150, bottom: 1300 },
  /** Picture down, words across its top edge. Shorter, because both stop at
   *  the same line: any lower and the captions would sit on the picture. */
  low: { top: 430, height: 870, bottom: 1300 },
};

/** Text-size floors, px on the 1080x1920 frame. */
export const MIN_HEADLINE = 110;
export const MIN_TEXT = 40;

export const HANDLE = "@thebuyboxre";
/** The logo drawn in white, for black backgrounds. */
export const LOGO_WHITE = staticFile("brand/logo-white.svg");
/** The logo drawn in black, for white and concrete backgrounds. */
export const LOGO_BLACK = staticFile("brand/logo-black.svg");
