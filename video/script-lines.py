#!/usr/bin/env python3
"""Print a video's narration lines as a JSON array, for the Edit page's script
panel. Prints null when there are none to read.

Usage: script-lines.py <source.tar.gz | voiceover_<slug>.py>

The lines are LINES in the video's voiceover script (see
remotion/voiceover_TEMPLATE.py), which pack-source.sh keeps in the source
bundle. That file was written by an agent, so it is parsed and never run: ast
finds the LINES assignment and literal_eval reads it, which accepts plain
values only.

Used by the render workflow's store job for every new video, and by the
backfill-scripts workflow for videos stored before the panel existed.
"""
import ast
import json
import sys
import tarfile

MAX_LINES = 30
MAX_CHARS = 400
MAX_FILE_BYTES = 200_000


def lines_in(text):
    try:
        tree = ast.parse(text)
    except (SyntaxError, ValueError):
        return None
    for node in tree.body:
        if isinstance(node, ast.Assign):
            targets, value = node.targets, node.value
        elif isinstance(node, ast.AnnAssign) and node.value is not None:
            targets, value = [node.target], node.value
        else:
            continue
        if not any(isinstance(t, ast.Name) and t.id == "LINES" for t in targets):
            continue
        try:
            lines = ast.literal_eval(value)
        except Exception:
            return None
        if (isinstance(lines, (list, tuple)) and 0 < len(lines) <= MAX_LINES
                and all(isinstance(line, str) and line.strip() for line in lines)):
            return [" ".join(line.split())[:MAX_CHARS] for line in lines]
        return None
    return None


def voiceover_source(path):
    if path.endswith(".py"):
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(MAX_FILE_BYTES)
    with tarfile.open(path, "r:gz") as tar:
        for member in tar.getmembers():
            name = member.name[2:] if member.name.startswith("./") else member.name
            if (member.isfile() and "/" not in name and name.startswith("voiceover_")
                    and name.endswith(".py") and member.size <= MAX_FILE_BYTES):
                return tar.extractfile(member).read().decode("utf-8", "replace")
    return None


def main():
    try:
        text = voiceover_source(sys.argv[1]) if len(sys.argv) > 1 else None
        lines = lines_in(text) if text else None
    except Exception:
        lines = None
    print(json.dumps(lines))


if __name__ == "__main__":
    main()
