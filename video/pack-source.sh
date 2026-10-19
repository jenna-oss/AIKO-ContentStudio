#!/usr/bin/env bash
# Pack everything needed to re-render a finished video, so it can be edited
# later from the Output page instead of re-made from scratch.
#
# Usage: pack-source.sh <remotion dir> <output .tar.gz>
#
# Finds the video from the newest <slug>_voice.mp4 in out/ (the deliverable, as
# find-output.sh judges it), then packs, relative to the remotion dir:
#   src/<Pascal>Video.tsx     the scenes
#   voiceover_<slug>.py       the narration lines and the script that voices them
#   _voiceover_<slug>/        the recorded narration, word timings and script text
#   public/<slug>/            the footage clips and captions.json
#   .edit/Root.as-run.tsx     src/Root.tsx as it was, for the registration and TOTAL_S
#   .edit/manifest.json       slug, component file and composition id
#
# Supabase's free plan takes uploads up to 50MB, and stock clips are the bulk of
# it, so clips over CLIP_MAX_MB are re-encoded smaller (same frame size, higher
# compression) before packing. If the bundle is still over PACK_MAX_MB it is not
# kept, with a warning: that video can then only be re-made with a change, not
# edited exactly.
#
# Always exits 0. A video without a kept source is a worse edit, not a failed
# render.

set -uo pipefail

ROOT="${1:?usage: pack-source.sh <remotion dir> <output .tar.gz>}"
OUT="${2:?usage: pack-source.sh <remotion dir> <output .tar.gz>}"
CLIP_MAX_MB="${CLIP_MAX_MB:-6}"
PACK_MAX_MB="${PACK_MAX_MB:-45}"
# Run by hand on Windows (Git Bash), a C:\ path would neither count as absolute
# nor survive tar, which reads "C:" as a remote host. CI never takes this branch.
if command -v cygpath >/dev/null; then
  ROOT=$(cygpath -u "$ROOT")
  OUT=$(cygpath -u "$OUT")
fi
case "$OUT" in /*) ;; *) OUT="$PWD/$OUT" ;; esac

voice=$(find "$ROOT/out" -maxdepth 1 -name '*_voice.mp4' -printf '%T@ %p\n' 2>/dev/null \
  | sort -rn | head -1 | cut -d' ' -f2-)
if [ -z "$voice" ]; then
  echo "No narrated video, so there is no source to keep."
  exit 0
fi

slug=$(basename "$voice" _voice.mp4)
# The pipeline names the component after the slug: dscr-083-worked-example ->
# Dscr083WorkedExampleVideo, composition id Dscr083WorkedExample.
pascal=$(printf '%s' "$slug" | awk -F- '{ for (i = 1; i <= NF; i++) printf "%s", toupper(substr($i, 1, 1)) substr($i, 2) }')
tsx="src/${pascal}Video.tsx"

cd "$ROOT" || exit 0
if [ ! -f "$tsx" ]; then
  echo "::warning::$tsx not found, so this video's source was not kept. It can be re-made with a change, but not edited exactly."
  exit 0
fi

rm -rf .edit && mkdir -p .edit
cp src/Root.tsx .edit/Root.as-run.tsx
printf '{"slug":"%s","component":"%s","composition":"%s"}\n' "$slug" "$tsx" "$pascal" > .edit/manifest.json

# Shrink big clips in place. The render is already made, so this only changes
# what an edit would start from.
if [ -d "public/$slug" ] && command -v ffmpeg >/dev/null; then
  find "public/$slug" -maxdepth 1 -name '*.mp4' -size +"${CLIP_MAX_MB}"M | while read -r clip; do
    # -nostdin: otherwise ffmpeg reads the rest of this loop's file list as
    # keyboard commands, and every clip after the first is skipped.
    if ffmpeg -nostdin -hide_banner -loglevel error -y -i "$clip" -c:v libx264 -preset veryfast -crf 30 \
         -pix_fmt yuv420p -c:a aac -b:a 96k -movflags +faststart "$clip.small.mp4"; then
      mv "$clip.small.mp4" "$clip"
    else
      rm -f "$clip.small.mp4"
    fi
  done
fi

files=(.edit "$tsx")
for f in "voiceover_${slug}.py" "_voiceover_${slug}" "public/${slug}"; do
  [ -e "$f" ] && files+=("$f")
done

if ! tar -czf "$OUT" "${files[@]}"; then
  echo "::warning::Could not pack this video's source."
  rm -f "$OUT"
  exit 0
fi

bytes=$(wc -c < "$OUT" | tr -d ' ')
if [ "$bytes" -gt $((PACK_MAX_MB * 1024 * 1024)) ]; then
  echo "::warning::This video's source is $((bytes / 1024 / 1024))MB, over the ${PACK_MAX_MB}MB that can be kept. It can be re-made with a change, but not edited exactly."
  rm -f "$OUT"
  exit 0
fi

echo "slug=$slug"
echo "Kept the source: $((bytes / 1024))KB, ${#files[@]} entries."
