// Burned-in captions in the brand guide's style (page 5): white Inter in a
// tight black box, with the line's key words in Site Orange. They are timed
// word by word to the narration: the voiceover step writes
// public/<slug>/captions.json from ElevenLabs' character timestamps.
//
// The first render happens before any voiceover exists, so a missing file
// renders nothing instead of failing.
import React, { useEffect, useMemo, useState } from "react";
import { AbsoluteFill, continueRender, delayRender, interpolate, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { BLACK, BODY, CAPTION_SIZE, ORANGE, SAFE, SAFE_W, WHITE } from "./brand";

type Word = { text: string; start: number; end: number; beat: number };
type Page = { words: Word[]; start: number; until: number };

const MAX_WORDS = 4;
/** Seconds a page may linger into a pause before it clears. */
const HOLD = 0.35;
/** The longest a single word may hold the page. One word came back with a
 *  3.1s slot, which reads as the captions drifting off the read. */
const MAX_WORD = 0.9;

const key = (s: string) => s.toLowerCase().replace(/^[^a-z0-9$]+|[^a-z0-9%]+$/g, "");
const endsPhrase = (s: string) => /[.?!:;,—]$/.test(s);

function paginate(words: Word[]): Page[] {
  const pages: Page[] = [];
  let cur: Word[] = [];
  const flush = () => {
    if (cur.length) pages.push({ words: cur, start: cur[0].start, until: cur[cur.length - 1].end });
    cur = [];
  };
  for (const w of words) {
    if (!/[a-z0-9]/i.test(w.text)) continue; // a lone dash or quote mark
    const last = cur[cur.length - 1];
    if (last && (w.beat !== last.beat || cur.length >= MAX_WORDS || endsPhrase(last.text))) flush();
    cur.push({ ...w, end: Math.min(w.end, w.start + MAX_WORD) });
  }
  flush();
  pages.forEach((p, i) => {
    const next = pages[i + 1];
    p.until = next ? Math.min(p.until + HOLD, next.start) : p.until + HOLD;
  });
  return pages;
}

export const Captions: React.FC<{ slug: string; emphasis?: string[] }> = ({ slug, emphasis = [] }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const [words, setWords] = useState<Word[] | null>(null);
  const [handle] = useState(() => delayRender(`captions for ${slug}`));

  useEffect(() => {
    fetch(staticFile(`${slug}/captions.json`))
      .then((r) => (r.ok ? r.json() : { words: [] }))
      .then((j) => setWords(Array.isArray(j?.words) ? j.words : []))
      .catch(() => setWords([]))
      .finally(() => continueRender(handle));
  }, [slug, handle]);

  const pages = useMemo(() => paginate(words ?? []), [words]);
  const hot = useMemo(
    () => new Set(emphasis.flatMap((e) => String(e).split(/\s+/)).map(key).filter(Boolean)),
    [emphasis],
  );

  const t = frame / fps;
  const page = pages.find((p) => t >= p.start && t < p.until);
  if (!page) return null;

  const enter = interpolate(t - page.start, [0, 0.12], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      <div
        style={{
          position: "absolute",
          left: SAFE.left,
          width: SAFE_W,
          bottom: SAFE.bottom,
          display: "flex",
          justifyContent: "center",
          opacity: enter,
          transform: `translateY(${(1 - enter) * 14}px)`,
        }}
      >
        <div
          style={{
            backgroundColor: BLACK,
            padding: "10px 20px",
            fontFamily: BODY,
            fontWeight: 700,
            fontSize: CAPTION_SIZE,
            lineHeight: 1.2,
            textAlign: "center",
          }}
        >
          {page.words.map((w, i) => (
            <span
              key={i}
              style={{ color: hot.has(key(w.text)) ? ORANGE : WHITE, opacity: t >= w.start - 0.02 ? 1 : 0 }}
            >
              {i ? " " : ""}
              {w.text}
            </span>
          ))}
        </div>
      </div>
    </AbsoluteFill>
  );
};
