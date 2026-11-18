#!/usr/bin/env python3
"""Benchmark a built converter on rustdoc JSON files or Cargo workspaces.

Print one JSON record per measured child process. Run from any directory after
npm run build. All published pages go into temporary directories.
"""

import argparse
import json
import os
from pathlib import Path
import random
import subprocess
import sys
import tempfile
import time


def measure(command):
    # File-backed streams avoid pipe backpressure and allow wait4 to reap the
    # exact child whose peak RSS we report, even after a previous larger run.
    with tempfile.TemporaryFile("w+", encoding="utf-8") as stdout, tempfile.TemporaryFile(
        "w+", encoding="utf-8"
    ) as stderr:
        start = time.perf_counter_ns()
        with subprocess.Popen(command, stdout=stdout, stderr=stderr) as child:
            peak_mib = None
            if hasattr(os, "wait4"):
                _, status, usage = os.wait4(child.pid, 0)
                child.returncode = os.waitstatus_to_exitcode(status)
                if sys.platform == "darwin":
                    peak_mib = usage.ru_maxrss / (1024 * 1024)
                elif sys.platform.startswith("linux"):
                    peak_mib = usage.ru_maxrss / 1024
            else:
                child.wait()
            elapsed_ms = (time.perf_counter_ns() - start) / 1_000_000
            stdout.seek(0)
            output = stdout.read()
            if child.returncode:
                stderr.seek(0)
                raise RuntimeError(
                    f"{command} exited {child.returncode}\n{stderr.read()}\n{output}"
                )
    return output, {"wall_ms": round(elapsed_ms, 3), "peak_rss_mib": peak_mib}


def benchmark(input_path, args, trial):
    selection = "--workspace" if input_path.is_dir() else "--input"
    command = [
        args.node,
        str(args.cli.resolve()),
        selection,
        str(input_path.resolve()),
        "--group-by",
        args.group_by,
    ]
    with tempfile.TemporaryDirectory(prefix="rustdoc-benchmark-") as output_dir:
        output = Path(output_dir) / "pages"
        base = [*command, "--output", str(output)]
        summary, timing = measure([*base, "--json"])
        preview = json.loads(summary)
        if preview.get("status") != "complete" or not preview.get("files"):
            raise RuntimeError(f"Incomplete benchmark input {input_path}: {preview}")
        stats = preview["stats"]
        samples = [("preview", timing)]
        for mode in ("fresh", "unchanged"):
            _, timing = measure(base)
            samples.append((mode, timing))
        for page in preview["files"]:
            if (output / page["path"]).stat().st_size != page["size"]:
                raise RuntimeError(f"Published size differs for {page['path']}")
        if trial > 0:
            for mode, timing in samples:
                record = {
                    "input": str(input_path),
                    "group_by": args.group_by,
                    "trial": trial,
                    "mode": mode,
                    **stats,
                    **timing,
                }
                print(json.dumps(record), flush=True)


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("inputs", nargs="+", type=Path, help="Rustdoc JSON or workspace directory")
    parser.add_argument("--runs", type=int, default=5)
    parser.add_argument("--warmups", type=int, default=1)
    parser.add_argument("--group-by", choices=["module", "flat", "kind"], default="module")
    parser.add_argument("--node", default="node")
    parser.add_argument("--cli", type=Path, default=root / "dist" / "cli.js")
    args = parser.parse_args()
    if args.runs < 1 or args.warmups < 0:
        parser.error("--runs must be positive and --warmups must be nonnegative")
    rng = random.Random(816)
    for trial in range(1 - args.warmups, args.runs + 1):
        inputs = list(args.inputs)
        rng.shuffle(inputs)
        for path in inputs:
            benchmark(path, args, trial)


if __name__ == "__main__":
    main()
