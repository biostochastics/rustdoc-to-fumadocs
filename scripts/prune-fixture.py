#!/usr/bin/env python3
"""Prune a rustdoc JSON file for use as a committed test fixture.

Keeps every `index` entry, drops `paths` entries whose id is not referenced
anywhere in the index (rustdoc lists all of std there), and strips span
filenames down to the crate-relative path so fixtures are machine-independent.
"""
import json
import sys
import re
from pathlib import Path

src, dst = sys.argv[1], sys.argv[2]
with open(src) as source:
    data = json.load(source)
version = re.search(r"\.v(\d+)\.json$", Path(dst).name)
if version and int(version[1]) != data["format_version"]:
    sys.exit(f"Expected format {version[1]} but rustdoc emitted {data['format_version']}")
refs = set()


def walk(node):
    if isinstance(node, dict):
        for v in node.values():
            walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)
    elif isinstance(node, str) and node in data["paths"]:
        refs.add(node)
    elif isinstance(node, int) and not isinstance(node, bool):
        refs.add(str(node))


walk(data["index"])
data["paths"] = {k: v for k, v in data["paths"].items() if k in refs or k in data["index"]}
used_crates = {str(v["crate_id"]) for v in data["paths"].values()}
data["external_crates"] = {
    k: {kk: vv for kk, vv in v.items() if kk != "path"}
    for k, v in data["external_crates"].items()
    if k in used_crates
}
for item in data["index"].values():
    span = item.get("span")
    if span and "/" in span["filename"] and span["filename"].startswith("/"):
        span["filename"] = span["filename"].rsplit("/src/", 1)[-1]
with open(dst, "w") as f:
    json.dump(data, f, sort_keys=True, separators=(",", ":"))
    f.write("\n")
