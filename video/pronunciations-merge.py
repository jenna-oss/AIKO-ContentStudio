#!/usr/bin/env python3
"""Fold the pronunciation fixes an edit made into the shared list.

Usage: pronunciations-merge.py <repo list> <list from a run> [<list from a run> ...]

An edit run's agent adds to video/remotion/pronunciations.json so its own
recording uses the fix, and the render job puts its copy in the artifact.
That agent took a request typed into the app and has a shell, so its copy is
data: only additions and changes are taken, each must look like a word and
how to say it, and there is a cap per run. Entries it removed stay. Nothing
in the file is executed.

Prints one line per entry taken. Exits 0 whether or not anything changed.
"""
import json
import re
import sys
from pathlib import Path

WORD = re.compile(r"^[a-z][a-z'-]{0,39}$")
SPOKEN = re.compile(r"^[a-z][a-z' -]{0,59}$")
MAX_CHANGES = 12


def main():
    repo_path, *run_paths = sys.argv[1:]
    repo = json.loads(Path(repo_path).read_text(encoding="utf-8"))
    words = repo["words"]
    taken = 0
    for path in run_paths:
        try:
            theirs = json.loads(Path(path).read_text(encoding="utf-8")).get("words", {})
        except (OSError, ValueError, AttributeError) as e:
            print(f"::warning::Skipped {path}: {e}")
            continue
        if not isinstance(theirs, dict):
            continue
        for word, said in theirs.items():
            if not isinstance(word, str) or not isinstance(said, str):
                continue
            word, said = word.strip().lower(), " ".join(said.split()).lower()
            if words.get(word) == said:
                continue
            if not WORD.match(word) or not SPOKEN.match(said) or said.count("-") > 2:
                print(f"::warning::Not taken, doesn't look like a word and how to say it: {word!r} -> {said!r}")
                continue
            if taken >= MAX_CHANGES:
                print(f"::warning::Not taken, over {MAX_CHANGES} changes in one run: {word!r}")
                continue
            print(f"{word} -> {said}" + (f" (was {words[word]})" if word in words else ""))
            words[word] = said
            taken += 1
    repo["words"] = dict(sorted(words.items()))
    Path(repo_path).write_text(json.dumps(repo, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
