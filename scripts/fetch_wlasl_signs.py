#!/usr/bin/env python3
"""
Fetch a handful of real ASL sign clips from the WLASL dataset
(https://github.com/dxli94/WLASL) and save them as
assets/signs/<word>.mp4 for the ASL Audio app.

WLASL is distributed under the Computational Use of Data Agreement
(C-UDA): academic / computational use only, no commercial use, and you
must agree to its terms before using the dataset. This script will not
download anything until you pass --agree-license.

Usage:
    # 1. Get WLASL_v0.3.json (after reading the WLASL license):
    #    https://github.com/dxli94/WLASL/blob/master/start_kit/WLASL_v0.3.json
    #
    # 2. See which of your vocabulary words are available, no downloads yet:
    python3 scripts/fetch_wlasl_signs.py --json WLASL_v0.3.json --dry-run
    #
    # 3. Actually fetch clips (requires ffmpeg and yt-dlp on PATH):
    python3 scripts/fetch_wlasl_signs.py --json WLASL_v0.3.json --agree-license

Requires the `ffmpeg` and `yt-dlp` executables to be installed
(e.g. `brew install ffmpeg yt-dlp` on macOS).
"""
import argparse
import json
import random
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_VOCAB_FILE = Path(__file__).resolve().parent / "wlasl_default_vocab.txt"
DEFAULT_OUT_DIR = REPO_ROOT / "assets" / "signs"

USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"

# A few WLASL glosses aren't plain words. --all keeps single words and
# simple multi-word phrases (e.g. "thank you", which the app's dictionary
# can look up as a combined sign), dropping only stray annotation noise.
PLAIN_WORD_RE = re.compile(r"^[a-z][a-z' -]*$")


def slug(word):
    return word.lower().strip().replace(" ", "-")

LICENSE_NOTICE = """\
WLASL is distributed under the Computational Use of Data Agreement (C-UDA):
academic / computational use only, no commercial use. Underlying video
copyright belongs to the original uploaders/sources. Read start_kit/C-UDA-1.0.pdf
in the WLASL repo before proceeding. Pass --agree-license once you have.
"""


def load_vocab(words_arg, words_file_arg):
    if words_arg:
        return [w.strip().lower() for w in words_arg.split(",") if w.strip()]
    path = Path(words_file_arg) if words_file_arg else DEFAULT_VOCAB_FILE
    return [
        line.strip().lower()
        for line in path.read_text().splitlines()
        if line.strip() and not line.startswith("#")
    ]


def find_tool(name, override):
    if override:
        return override
    found = shutil.which(name)
    if found:
        return found
    if name == "ffmpeg":
        try:
            import imageio_ffmpeg

            return imageio_ffmpeg.get_ffmpeg_exe()
        except ImportError:
            pass
    return None


def classify_url(url):
    if "aslpro" in url:
        return "aslpro"
    if "youtube.com" in url or "youtu.be" in url:
        return "youtube"
    return "direct"


def frame_to_seconds(frame, fps):
    return max(0.0, (frame - 1) / fps)


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def fetch_direct(url, dest_mp4, ffmpeg, start_s, end_s):
    with tempfile.NamedTemporaryFile(suffix=".raw", delete=False) as tmp:
        raw_path = Path(tmp.name)
    try:
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        with urllib.request.urlopen(req, timeout=30) as resp, open(raw_path, "wb") as f:
            shutil.copyfileobj(resp, f)

        cmd = [ffmpeg, "-y", "-v", "error", "-i", str(raw_path)]
        if start_s:
            cmd += ["-ss", f"{start_s:.3f}"]
        if end_s is not None:
            duration = max(0.1, end_s - (start_s or 0))
            cmd += ["-t", f"{duration:.3f}"]
        cmd += ["-c", "copy", "-movflags", "+faststart", str(dest_mp4)]
        result = run(cmd)
        if result.returncode != 0 or not dest_mp4.exists() or dest_mp4.stat().st_size == 0:
            return False, result.stderr.strip()[:300]
        return True, None
    finally:
        raw_path.unlink(missing_ok=True)


def fetch_youtube(url, dest_mp4, ffmpeg, yt_dlp, start_s, end_s):
    if end_s is None:
        return False, "open-ended youtube clip (no frame_end) skipped to avoid full-video download"

    with tempfile.TemporaryDirectory() as tmpdir:
        out_template = str(Path(tmpdir) / "clip.%(ext)s")
        cmd = [
            *yt_dlp,
            "--ffmpeg-location", ffmpeg,
            "--download-sections", f"*{start_s:.3f}-{end_s:.3f}",
            "-f", "mp4/best",
            "-o", out_template,
            url,
        ]
        result = run(cmd, timeout=90)
        candidates = list(Path(tmpdir).glob("clip.*"))
        if result.returncode != 0 or not candidates:
            return False, result.stderr.strip()[-300:]

        cmd = [
            ffmpeg, "-y", "-v", "error", "-i", str(candidates[0]),
            "-c", "copy", "-movflags", "+faststart", str(dest_mp4),
        ]
        result = run(cmd)
        if result.returncode != 0 or not dest_mp4.exists() or dest_mp4.stat().st_size == 0:
            return False, result.stderr.strip()[:300]
        return True, None


def fetch_one_word(word, entry, out_dir, ffmpeg, yt_dlp, max_attempts, overwrite):
    dest = out_dir / f"{slug(word)}.mp4"
    if dest.exists() and not overwrite:
        return "skipped (already exists)"

    instances = entry["instances"][:max_attempts]
    last_error = "no instances available"

    for inst in instances:
        url = inst["url"]
        kind = classify_url(url)
        fps = inst.get("fps", 25)
        start_s = frame_to_seconds(inst["frame_start"], fps)
        frame_end = inst.get("frame_end", -1)
        end_s = frame_end / fps if frame_end and frame_end > 0 else None

        if kind == "aslpro":
            last_error = "aslpro (.swf) source unsupported"
            continue

        try:
            if kind == "youtube":
                ok, err = fetch_youtube(url, dest, ffmpeg, yt_dlp, start_s, end_s)
            else:
                ok, err = fetch_direct(url, dest, ffmpeg, start_s, end_s)
        except Exception as exc:  # network/subprocess failures shouldn't abort the batch
            ok, err = False, str(exc)[:300]

        if ok:
            return "fetched"
        last_error = err or "unknown failure"
        time.sleep(random.uniform(0.4, 0.9))

    return f"failed ({last_error})"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", required=True, help="Path to WLASL_v0.3.json")
    parser.add_argument("--words", help="Comma-separated list of words to fetch")
    parser.add_argument("--words-file", help="Path to a newline-separated word list (default: bundled common vocab)")
    parser.add_argument("--all", action="store_true", help="Fetch every gloss in the WLASL JSON, ignoring --words/--words-file")
    parser.add_argument("--out", default=str(DEFAULT_OUT_DIR), help="Output directory (default: assets/signs)")
    parser.add_argument("--agree-license", action="store_true", help="Confirm you have read and agree to WLASL's C-UDA license")
    parser.add_argument("--dry-run", action="store_true", help="Only report which words have usable instances; no downloads")
    parser.add_argument("--max-instance-attempts", type=int, default=5, help="How many source instances to try per word before giving up")
    parser.add_argument("--overwrite", action="store_true", help="Re-fetch words that already have a clip")
    parser.add_argument("--ffmpeg", help="Path to ffmpeg executable (auto-detected by default)")
    parser.add_argument("--yt-dlp", help="Path to yt-dlp executable (auto-detected by default)")
    args = parser.parse_args()

    print(LICENSE_NOTICE)
    if not args.dry_run and not args.agree_license:
        print("Refusing to download without --agree-license. Use --dry-run to preview matches first.")
        sys.exit(1)

    data = json.loads(Path(args.json).read_text())
    by_gloss = {entry["gloss"]: entry for entry in data}

    if args.all:
        vocab = sorted(g for g in by_gloss.keys() if PLAIN_WORD_RE.match(g.lower()))
        print(f"{len(vocab)}/{len(by_gloss)} glosses look like plain words/phrases (rest skipped).")
    else:
        vocab = load_vocab(args.words, args.words_file)

    matched = [w for w in vocab if w in by_gloss]
    unmatched = [w for w in vocab if w not in by_gloss]
    print(f"{len(matched)}/{len(vocab)} requested words found in WLASL gloss list.")
    if unmatched:
        print("Not found in WLASL:", ", ".join(unmatched))

    if args.dry_run:
        return

    ffmpeg = find_tool("ffmpeg", args.ffmpeg)
    if not ffmpeg:
        print("ffmpeg not found. Install it (e.g. `brew install ffmpeg`) or pass --ffmpeg.")
        sys.exit(1)

    yt_dlp_bin = find_tool("yt-dlp", args.yt_dlp)
    yt_dlp_cmd = [yt_dlp_bin] if yt_dlp_bin else [sys.executable, "-m", "yt_dlp"]
    check = run([*yt_dlp_cmd, "--version"])
    if check.returncode != 0:
        print("yt-dlp not found. Install it (e.g. `brew install yt-dlp` or `pip install yt-dlp`) or pass --yt-dlp.")
        sys.exit(1)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    results = {}
    for word in matched:
        status = fetch_one_word(word, by_gloss[word], out_dir, ffmpeg, yt_dlp_cmd, args.max_instance_attempts, args.overwrite)
        results[word] = status
        print(f"{word:20s} {status}")
        time.sleep(random.uniform(0.3, 0.7))

    fetched = sum(1 for s in results.values() if s == "fetched")
    failed = [w for w, s in results.items() if s.startswith("failed")]
    print(f"\nDone. {fetched}/{len(matched)} clips saved to {out_dir}.")
    if failed:
        print("Failed (will fall back to fingerspelling in the app):", ", ".join(failed))


if __name__ == "__main__":
    main()
