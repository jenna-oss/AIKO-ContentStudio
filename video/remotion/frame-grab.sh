#!/usr/bin/env bash
# Grab still frames from a finished video, for the frame check: one image per
# time given, named in order (frame-01.jpg, frame-02.jpg, ...), 540px wide, so
# each can be Read and looked at closely.
#
# Usage: frame-grab.sh <video.mp4> <out dir> <seconds> [<seconds> ...]
#
# Prints each image's path. A time that can't be grabbed prints a line saying
# so and the rest carry on. Exits 1 only when no frame could be grabbed.

set -uo pipefail

VIDEO="${1:?usage: frame-grab.sh <video.mp4> <out dir> <seconds>...}"
OUT="${2:?usage: frame-grab.sh <video.mp4> <out dir> <seconds>...}"
shift 2
[ $# -gt 0 ] || { echo "no times given" >&2; exit 1; }

mkdir -p "$OUT"
rm -f "$OUT"/frame-*.jpg
n=0
got=0
for t in "$@"; do
  n=$((n + 1))
  file=$(printf '%s/frame-%02d.jpg' "$OUT" "$n")
  if ffmpeg -nostdin -hide_banner -loglevel error -y -ss "$t" -i "$VIDEO" \
       -frames:v 1 -q:v 3 -vf scale=540:-2 "$file" && [ -s "$file" ]; then
    echo "$file  (at ${t}s)"
    got=$((got + 1))
  else
    echo "could not grab a frame at ${t}s"
  fi
done
[ "$got" -gt 0 ]
