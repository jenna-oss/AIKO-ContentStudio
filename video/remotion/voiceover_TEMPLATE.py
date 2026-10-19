"""
CANONICAL voiceover template -- copy this file to voiceover_<slug>.py for a
new video and fill in LINES. This is the reference the pipeline workflow's
Voiceover stage is told to follow.

Same timestamp-driven approach as every video so far: generate ONE
continuous take via ElevenLabs' with-timestamps endpoint, find each line's
real start time via character alignment, then compute the Remotion scene
durations that make the VIDEO match the VOICE (video timed to voice, never
the other way around).

Two things this template adds over earlier one-off scripts:
1. Numbers are spelled out for the TTS input via numeric_tts.spoken_text()
   -- on-screen captions can keep the compact numeric form ($240,000), but
   raw digits sent to the voice model get mispronounced inconsistently.
2. Voice is generated at natural pace (so it's not slurred/rushed the way
   ElevenLabs' own speed parameter makes it), then uniformly time-stretched
   with ffmpeg's atempo AFTER generation for a faster, more energetic feel
   -- all timestamps are rescaled by the same factor so sync is unaffected.

Run from newsletter_video_pipeline/remotion/:  python voiceover_<slug>.py
Then apply the printed durationInFrames values to <Slug>Video.tsx and the
printed TOTAL_S to Root.tsx, re-render, and re-run this script -- it will
mux the same audio it already generated onto the fresh render.
"""
import base64
import json
import os
import re
import subprocess
import urllib.request
import urllib.error
from pathlib import Path

from dotenv import load_dotenv
from numeric_tts import has_pronunciation, spoken_text

load_dotenv(Path(__file__).parent.parent / ".env")

VOICE_ID = "56bWURjYFHyYyVf490Dp"  # the channel's narrator
MODEL_ID = "eleven_multilingual_v2"
SWIPE = 0.35  # must match SWIPE in the video's .tsx
FPS = 30
TAIL_PAD = 2.0

# How the voice delivers. An edit on the Output page ("more enthusiastic",
# "calmer") changes these, inside the ranges given, and records again.
STABILITY = 0.15  # 0.05-0.6: lower = more range and emotion, less predictable; higher = steadier
STYLE = 1.0       # 0.3-1.0: higher = bolder, more dramatic delivery
SIMILARITY = 0.8  # 0.7-0.9: how closely it keeps to the narrator's cloned voice
SPEEDUP = 1.15    # 1.0-1.2: uniform speedup after recording -- faster/more energetic without per-word slurring
MAX_PAUSE = 0.35  # the longest silence kept between phrases; longer ones are cut back to it

SLUG = "REPLACE_ME"  # e.g. "arnold-schwarzenegger-real-estate" -- used for folder/file naming

# One continuous script, in on-screen order. Keep lines short (8-14 words) --
# these are fast cuts, not a podcast.
LINES = [
    "REPLACE with beat 1 line",
    "REPLACE with beat 2 line",
]

# The words to punch, one list per line, copied from that line (the script's
# own emphasis words -- the same ones the captions turn orange). They are sent
# to the voice in capitals, which it leans into; the captions still read as
# written, because they are matched to the audio without regard to case.
EMPHASIS = [
    [],
    [],
]


def silences(path):
    """[(start, end)] of every silence in the take longer than MAX_PAUSE."""
    out = subprocess.run(
        f'ffmpeg -nostdin -hide_banner -i "{path}" -af silencedetect=n=-40dB:d={MAX_PAUSE:.2f} -f null -',
        shell=True, capture_output=True, text=True,
    ).stderr
    starts = [float(x) for x in re.findall(r"silence_start: ([0-9.]+)", out)]
    ends = [float(x) for x in re.findall(r"silence_end: ([0-9.]+)", out)]
    return list(zip(starts, ends))


def cuts_for(spans):
    """The slice to drop from each over-long pause: its middle, leaving MAX_PAUSE."""
    cuts = []
    for start, end in spans:
        extra = (end - start) - MAX_PAUSE
        if extra > 0.15:  # shaving a twentieth of a second off is not worth a cut
            middle = (start + end) / 2
            cuts.append((round(middle - extra / 2, 3), round(middle + extra / 2, 3)))
    return cuts


def remap(t, cuts):
    """A timestamp in the original take, as it falls in the trimmed one."""
    shift = 0.0
    for start, end in cuts:
        if t >= end:
            shift += end - start
        elif t > start:
            return round(start - shift, 3)  # inside a cut: it lands where the cut begins
        else:
            break
    return round(t - shift, 3)


def drop_pauses(src, dst, cuts):
    """Write src to dst with those slices removed."""
    kept, prev = [], 0.0
    for start, end in cuts:
        kept.append((prev, start))
        prev = end
    kept.append((prev, None))
    parts = []
    for i, (start, end) in enumerate(kept):
        rng = f"start={start}" + (f":end={end}" if end is not None else "")
        parts.append(f"[0:a]atrim={rng},asetpts=PTS-STARTPTS[a{i}]")
    joined = "".join(f"[a{i}]" for i in range(len(kept)))
    graph = ";".join(parts) + f";{joined}concat=n={len(kept)}:v=0:a=1[out]"
    run(f'ffmpeg -y -i "{src}" -filter_complex "{graph}" -map "[out]" "{dst}"')


def punched(spoken_line, words):
    """The spoken line with its emphasis words capitalised. Words on the
    pronunciation list are left as they are: in capitals the voice reads a
    respelling letter by letter."""
    out = spoken_line
    for word in words or []:
        if has_pronunciation(str(word)):
            continue
        key = spoken_text(str(word)).strip(" .,;:!?\"'()-").strip()
        if not key:
            continue
        out = re.sub(rf"(?<![A-Za-z]){re.escape(key)}(?![A-Za-z])", key.upper(), out, count=1, flags=re.I)
    return out


def spoken_lines_for(lines):
    """What actually gets sent: numbers spelled out, emphasis words punched."""
    return [punched(spoken_text(line), EMPHASIS[i] if i < len(EMPHASIS) else [])
            for i, line in enumerate(lines)]


def run(cmd):
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    if result.returncode != 0:
        print(result.stderr[-2000:])
        raise SystemExit(f"Command failed: {cmd}")


def duration_of(path):
    out = subprocess.run(
        f'ffprobe -v error -show_entries format=duration -of csv=p=0 "{path}"',
        shell=True, capture_output=True, text=True,
    ).stdout.strip()
    return float(out)


def tts_with_timestamps(text: str):
    key = os.environ["ELEVENLABS_API_KEY"]
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}/with-timestamps"
    body = json.dumps({
        "text": text,
        "model_id": MODEL_ID,
        # lower stability + higher style = more expressive/enthusiastic delivery
        "voice_settings": {
            "stability": STABILITY,
            "similarity_boost": SIMILARITY,
            "style": STYLE,
            "use_speaker_boost": True,
        },
    }).encode("utf-8")
    req = urllib.request.Request(
        url, data=body,
        headers={"xi-api-key": key, "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req) as resp:
            return json.loads(resp.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"ElevenLabs TTS failed: {e.code} {e.read().decode()}")


def write_captions(base, script_text, align, spoken_lines, line_indexes, total_dur):
    """Word timings for the burned-in captions (src/Captions.tsx), from the
    same character alignment. Captions show each line as written ("$4,500"),
    but the voice read its spoken form ("four thousand five hundred dollars"),
    so each written word is found in the spoken script by its own spoken form.
    A word the search can't place is spread evenly between its neighbours."""
    starts = align["character_start_times_seconds"]
    ends = align.get("character_end_times_seconds") or starts
    lowered = script_text.lower()
    words = []
    for beat, (line, spoken, line_idx) in enumerate(zip(LINES, spoken_lines, line_indexes), start=1):
        pos, stop = line_idx, line_idx + len(spoken)
        for w in line.split():
            key = spoken_text(w).strip(" .,;:!?\"'()—-").lower()
            found = lowered.find(key, pos, stop) if key else -1
            if found < 0:
                words.append({"text": w, "start": None, "end": None, "beat": beat})
                continue
            last = min(found + len(key) - 1, len(ends) - 1)
            words.append({"text": w, "start": round(starts[found], 3), "end": round(ends[last], 3), "beat": beat})
            pos = found + len(key)

    unplaced = sum(1 for w in words if w["start"] is None)
    i = 0
    while i < len(words):
        if words[i]["start"] is not None:
            i += 1
            continue
        j = i
        while j < len(words) and words[j]["start"] is None:
            j += 1
        a = words[i - 1]["end"] if i > 0 else 0.0
        b = words[j]["start"] if j < len(words) else total_dur
        step = max(b - a, 0.0) / (j - i)
        for k in range(i, j):
            words[k]["start"] = round(a + step * (k - i), 3)
            words[k]["end"] = round(a + step * (k - i + 1), 3)
        i = j

    out_dir = base / "public" / SLUG
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "captions.json").write_text(json.dumps({"words": words}, indent=1))
    print(f"Captions: {len(words)} words -> public/{SLUG}/captions.json ({unplaced} spread between neighbours)\n")


def main():
    base = Path(__file__).parent  # remotion/
    voice_dir = base / f"_voiceover_{SLUG}"
    voice_dir.mkdir(exist_ok=True)

    raw_path = voice_dir / "narration_raw.mp3"      # natural pace, straight from ElevenLabs
    audio_path = voice_dir / "narration.mp3"         # final, sped-up track actually muxed onto the video

    if audio_path.exists():
        print(f"Reusing existing narration at {audio_path} (delete it + narration_raw.mp3 to regenerate).")
        total_dur = duration_of(audio_path)
        align = json.loads((voice_dir / "alignment.json").read_text())
        script_text = (voice_dir / "script.txt").read_text()
    else:
        script_text = " ".join(spoken_lines_for(LINES))
        print("Generating one continuous narration with timestamps (ElevenLabs, cloned client voice)...")
        result = tts_with_timestamps(script_text)
        raw_path.write_bytes(base64.b64decode(result["audio_base64"]))
        align = result["alignment"]
        (voice_dir / "alignment.json").write_text(json.dumps(align))
        (voice_dir / "script.txt").write_text(script_text)

        # Dead air first: the model leaves 0.4-0.8s between phrases, which reads
        # as a limp rhythm however fast the rest is played. Every pause longer
        # than MAX_PAUSE is cut back to it and the timestamps move with the
        # audio, so the captions stay on the word.
        cuts = cuts_for(silences(raw_path))
        speech_path = raw_path
        if cuts:
            speech_path = voice_dir / "narration_tight.mp3"
            drop_pauses(raw_path, speech_path, cuts)
            for k in ("character_start_times_seconds", "character_end_times_seconds"):
                if k in align:
                    align[k] = [remap(t, cuts) for t in align[k]]
            dropped = sum(end - start for start, end in cuts)
            print(f"  trimmed {dropped:.2f}s of silence out of {len(cuts)} pause(s)")

        # then rescale every character timestamp by the speedup factor and
        # actually stretch the audio -- sync stays correct against the faster track
        align["character_start_times_seconds"] = [t / SPEEDUP for t in align["character_start_times_seconds"]]
        if "character_end_times_seconds" in align:
            align["character_end_times_seconds"] = [t / SPEEDUP for t in align["character_end_times_seconds"]]
        (voice_dir / "alignment.json").write_text(json.dumps(align))

        run(f'ffmpeg -y -i "{speech_path}" -filter:a "atempo={SPEEDUP}" -ar 44100 "{audio_path}"')
        total_dur = duration_of(audio_path)

    print(f"  {total_dur:.2f}s of audio (post-speedup, {SPEEDUP}x)\n")

    starts = align["character_start_times_seconds"]
    search_from = 0
    line_starts = []
    line_indexes = []
    spoken_lines = spoken_lines_for(LINES)
    for line in spoken_lines:
        idx = script_text.index(line, search_from)
        line_starts.append(starts[idx])
        line_indexes.append(idx)
        search_from = idx + len(line)

    write_captions(base, script_text, align, spoken_lines, line_indexes, total_dur)

    print("Per-line actual start times in the generated audio:")
    for line, st in zip(LINES, line_starts):
        print(f"  {st:6.2f}s  \"{line[:60]}\"")

    durations = []
    for i in range(len(line_starts) - 1):
        durations.append(round(line_starts[i + 1] - line_starts[i] + SWIPE, 2))
    durations.append(round(total_dur - line_starts[-1] + TAIL_PAD, 2))

    print(f"\nScene durationInFrames to use in the .tsx (video timed to this voice take):")
    for i, d in enumerate(durations):
        print(f"  scene {i:02d}: s({d})  -> {round(d * FPS)} frames")

    total_s = sum(durations) - (len(durations) - 1) * SWIPE
    print(f"\nTOTAL_S for Root.tsx: {' + '.join(str(d) for d in durations)} - {len(durations)-1} * {SWIPE} = {total_s:.2f}")

    video_path = base / "out" / f"{SLUG}.mp4"
    final_path = base / "out" / f"{SLUG}_voice.mp4"
    if video_path.exists():
        cur_video_dur = duration_of(video_path)
        if abs(cur_video_dur - total_s) < 0.5:
            # apad pads the narration with silence, so -shortest stops at the
            # end of the video rather than the voice. The video runs TAIL_PAD
            # past the last line on purpose; a plain -shortest cut that off.
            run(
                f'ffmpeg -y -i "{video_path}" -i "{audio_path}" '
                f'-c:v copy -map 0:v:0 -map 1:a:0 -af apad -c:a aac -shortest "{final_path}"'
            )
            print(f"\nVideo duration matches the voice take -- muxed: {final_path} ({duration_of(final_path):.2f}s)")
        else:
            print(f"\nNOTE: out/{SLUG}.mp4 is {cur_video_dur:.2f}s but this voice take needs {total_s:.2f}s --")
            print("apply the durations above to the .tsx/Root.tsx and re-render before muxing.")


if __name__ == "__main__":
    main()
