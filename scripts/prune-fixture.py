#!/usr/bin/env python3
"""Prune a rustdoc JSON file for use as a committed test fixture.

Keeps every `index` entry, drops `paths` entries whose id is not referenced
anywhere in the index (rustdoc lists all of std there), and strips span
filenames down to the crate-relative path so fixtures are machine-independent.
"""
import json
import sys

src, dst = sys.argv[1], sys.argv[2]
data = json.load(open(src))
refs = set()


def walk(node):
    if isinstance(node, dict):
        for v in node.values():
            walk(v)
    elif isinstance(node, list):
        for v in node:
            walk(v)
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
