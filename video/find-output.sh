#!/usr/bin/env bash
# Which file is the finished video — and is there one?
#
# The Voiceover stage re-renders, then muxes narration onto that render as
# <slug>_voice.mp4. That file is the deliverable. The un-suffixed render sits
# beside it carrying Remotion's own audio track — a music bed, effects, or
# digital silence — and "the first mp4 find returns" is what used to be stored:
# slot 1 reached the bucket without its narration, and slots 2 and 3, whose
# Voiceover stage never ran, were recorded as rendered.
#
# An audio stream is not evidence of narration either: Remotion adds a silent
# track to every render. So a _voice file is required, and it is measured.
#
# Prints three key=value lines for the caller to read:
#   state=ok          a _voice file exists and its audio is audible
#   state=silent      a _voice file exists but its audio is digital silence
#   state=unnarrated  only renders without narration exist — Voiceover did not finish
#   state=none        no mp4 at all
#   path=...          the _voice file, or the newest render found, or empty
#   mean_db=...       that file's mean volume in dB, when measurable
#
# Always exits 0. Deciding what the answer means is the caller's job.

set -uo pipefail

OUT="${1:-video/remotion/out}"
SILENT_DB="${SILENT_DB:--60}"   # -91 dB is digital silence; speech sits around -30 to -15

newest() {
  find "$OUT" -maxdepth 2 -name "$1" -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -1 | cut -d' ' -f2-
}

mean_db() {
  ffmpeg -hide_banner -nostats -i "$1" -map 0:a:0 -af volumedetect -f null - 2>&1 \
    | sed -nE 's/.*mean_volume: (-?[0-9.]+) dB.*/\1/p' | head -1
}

voice=$(newest '*_voice.mp4')
if [ -n "$voice" ]; then
  db=$(mean_db "$voice")
  # An unmeasurable track counts as silent: a narrated file we cannot hear is
  # not one we should call finished.
  if [ -n "$db" ] && awk -v d="$db" -v t="$SILENT_DB" 'BEGIN { exit !(d > t) }'; then
    echo "state=ok"
  else
    echo "state=silent"
  fi
  echo "path=$voice"
  echo "mean_db=$db"
  exit 0
fi

render=$(newest '*.mp4')
if [ -n "$render" ]; then
  echo "state=unnarrated"
  echo "path=$render"
  echo "mean_db=$(mean_db "$render")"
  exit 0
fi

echo "state=none"
echo "path="
echo "mean_db="
