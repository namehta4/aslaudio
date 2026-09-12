#!/usr/bin/env python3
"""
Fetch real ASL sign clips from the ASLLVD (American Sign Language Lexicon
Video Dataset, Boston University / Rutgers ASLLRP) and save them as
assets/signs/<word>.mp4 for the ASL Audio app. Complements
fetch_wlasl_signs.py — useful for words WLASL doesn't have.

ASLLVD data is for research use: no commercial use, no redistribution, and
attribution is required (see http://www.bu.edu/asllrp/signbank-terms.pdf).
This script will not download anything until you pass --agree-license.

Source videos are un-trimmed ~60s recording "scenes" containing many signs
back to back, referenced by (session, scene, start frame, end frame) in a
glossing spreadsheet published by BU. We stream + seek + trim + re-encode
each needed clip directly from the source URL (no full-file download
needed — the source server supports HTTP range requests) and re-encode to
H.264 because the originals are old MPEG-4 Part 2, which browsers can't
play natively.

Usage:
    # See which of your vocabulary words are available, no downloads yet:
    python3 scripts/fetch_asllvd_signs.py --dry-run

    # Actually fetch clips (requires ffmpeg on PATH):
    python3 scripts/fetch_asllvd_signs.py --agree-license

    # Only fetch specific words:
    python3 scripts/fetch_asllvd_signs.py --agree-license --words "hospital,fine,call"

    # Skip words that already have a clip (e.g. from WLASL) — this is the default;
    # pass --overwrite to re-fetch them from ASLLVD instead.
"""
import argparse
import random
import re
import shutil
import subprocess
import sys
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_XLSX_CACHE = Path(__file__).resolve().parent / "asllvd_glossing.xlsx"
DEFAULT_OUT_DIR = REPO_ROOT / "assets" / "signs"
XLSX_URL = "https://www.bu.edu/asllrp/dai-asllvd-BU_glossing_with_variations_HS_information-extended-urls-RU.xlsx"
VIDEO_BASE_URL = "http://csr.bu.edu/ftp/asl/asllvd/asl-data2/quicktime"

# Column positions in the glossing spreadsheet (Sheet1), verified against
# real data — the header row has ambiguous duplicate labels so we index by
# position rather than name.
COL_GLOSS = 3
COL_CONSULTANT = 2
COL_SESSION = 12
COL_SCENE = 13
COL_START = 14
COL_END = 15

# Concatenating clips from many different signers/backgrounds looks
# fragmented — sticking to one person as much as possible makes playback
# far more visually consistent. Liz alone covers 92% of our vocabulary,
# Liz+Brady together 98%, so we prefer them in this order and only fall
# back to other signers for the rare word neither of them has.
PREFERRED_SIGNERS = ["Liz", "Brady"]

# ASLLVD's raw gloss list includes many linguistic-annotation variants
# (e.g. "1p-help:i", "(y)bull", "(s)old+five_2") that the app's dictionary
# lookup can never match, alongside genuinely useful multi-word phrases
# (e.g. "thank you", "ice cream", "pay attention") that it now can. --all
# keeps plain words and simple word phrases, and drops annotation noise
# (digits, colons, parens, plus signs, underscores, hash marks).
PLAIN_WORD_RE = re.compile(r"^[a-z][a-z' -]*$")


def slug(word):
    return word.lower().strip().replace(" ", "-")

LICENSE_NOTICE = """\
ASLLVD data is provided by the ASL Linguistic Research Project (Boston
University / Rutgers) for RESEARCH USE ONLY: no commercial use, no
redistribution of the data, and attribution is required. See
http://www.bu.edu/asllrp/signbank-terms.pdf. Pass --agree-license once
you've read and agree to those terms.
"""


def load_vocab(words_arg, words_file_arg):
    if words_arg:
        return [w.strip().upper() for w in words_arg.split(",") if w.strip()]
    if words_file_arg:
        return [
            line.strip().upper()
            for line in Path(words_file_arg).read_text().splitlines()
            if line.strip() and not line.startswith("#")
        ]
    return None


def download_xlsx(cache_path):
    if cache_path.exists():
        return cache_path
    print(f"Downloading ASLLVD glossing spreadsheet to {cache_path}...")
    req = urllib.request.Request(XLSX_URL, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp, open(cache_path, "wb") as f:
        shutil.copyfileobj(resp, f)
    return cache_path


def parse_gloss_index(xlsx_path):
    import openpyxl

    wb = openpyxl.load_workbook(xlsx_path, read_only=True, data_only=True)
    ws = wb["Sheet1"]

    rows = ws.iter_rows(values_only=True)
    header = next(rows)
    if header[COL_SESSION] != "Session" or header[COL_SCENE] != "Scene":
        print("warning: spreadsheet column layout looks different than expected; results may be wrong")

    by_gloss = {}
    for row in rows:
        if len(row) <= COL_END:
            continue
        gloss, consultant, session, scene, start, end = (
            row[COL_GLOSS], row[COL_CONSULTANT], row[COL_SESSION], row[COL_SCENE], row[COL_START], row[COL_END]
        )
        if not gloss or gloss == "============" or not session:
            continue
        if not all(isinstance(v, (int, float)) for v in (scene, start, end)):
            continue
        by_gloss.setdefault(gloss.strip().upper(), []).append(
            {"consultant": consultant, "session": session, "scene": scene, "start": int(start), "end": int(end)}
        )

    def signer_rank(instance):
        consultant = instance.get("consultant")
        return PREFERRED_SIGNERS.index(consultant) if consultant in PREFERRED_SIGNERS else len(PREFERRED_SIGNERS)

    for instances in by_gloss.values():
        instances.sort(key=signer_rank)

    return by_gloss


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


def run(cmd, **kwargs):
    return subprocess.run(cmd, capture_output=True, text=True, **kwargs)


def probe_fps(url, ffmpeg, timeout=30):
    result = run([ffmpeg, "-i", url], timeout=timeout)
    text = result.stderr
    for token in text.split(","):
        token = token.strip()
        if token.endswith("fps"):
            try:
                return float(token.split()[0])
            except ValueError:
                continue
    return None


def fetch_instance(instance, dest_mp4, ffmpeg, fps_cache):
    session, scene = instance["session"], instance["scene"]
    url = f"{VIDEO_BASE_URL}/{session}/scene{scene}-camera1.mov"

    cache_key = (session, scene)
    if cache_key not in fps_cache:
        fps_cache[cache_key] = probe_fps(url, ffmpeg)
    fps = fps_cache[cache_key]
    if not fps:
        return False, "could not determine source fps"

    start_s = max(0.0, (instance["start"] - 1) / fps)
    end_s = instance["end"] / fps
    duration = end_s - start_s
    if duration <= 0.05:
        return False, "degenerate frame range"

    cmd = [
        ffmpeg, "-y", "-v", "error",
        "-ss", f"{start_s:.3f}", "-i", url, "-t", f"{duration:.3f}",
        "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
        str(dest_mp4),
    ]
    result = run(cmd, timeout=60)
    if result.returncode != 0 or not dest_mp4.exists() or dest_mp4.stat().st_size == 0:
        return False, (result.stderr or "unknown ffmpeg error").strip()[:300]
    return True, None


def fetch_one_word(word, instances, out_dir, ffmpeg, max_attempts, overwrite, fps_cache):
    dest = out_dir / f"{slug(word)}.mp4"
    if dest.exists() and not overwrite:
        return "skipped (already exists)"

    last_error = "no instances available"
    for instance in instances[:max_attempts]:
        try:
            ok, err = fetch_instance(instance, dest, ffmpeg, fps_cache)
        except Exception as exc:
            ok, err = False, str(exc)[:300]
        if ok:
            return "fetched"
        last_error = err or "unknown failure"
        time.sleep(random.uniform(0.2, 0.5))

    return f"failed ({last_error})"


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--words", help="Comma-separated list of words to fetch")
    parser.add_argument("--words-file", help="Path to a newline-separated word list")
    parser.add_argument("--all", action="store_true", help="Fetch every gloss in the spreadsheet, ignoring --words/--words-file")
    parser.add_argument("--xlsx", help="Path to the ASLLVD glossing spreadsheet (auto-downloaded and cached by default)")
    parser.add_argument("--out", default=str(DEFAULT_OUT_DIR), help="Output directory (default: assets/signs)")
    parser.add_argument("--agree-license", action="store_true", help="Confirm you have read and agree to ASLLVD's terms of use")
    parser.add_argument("--dry-run", action="store_true", help="Only report which words are available; no downloads")
    parser.add_argument("--max-instance-attempts", type=int, default=3, help="How many signer instances to try per word before giving up")
    parser.add_argument("--overwrite", action="store_true", help="Re-fetch words that already have a clip (e.g. from WLASL)")
    parser.add_argument("--ffmpeg", help="Path to ffmpeg executable (auto-detected by default)")
    args = parser.parse_args()

    print(LICENSE_NOTICE)
    if not args.dry_run and not args.agree_license:
        print("Refusing to download without --agree-license. Use --dry-run to preview matches first.")
        sys.exit(1)

    xlsx_path = Path(args.xlsx) if args.xlsx else download_xlsx(DEFAULT_XLSX_CACHE)
    by_gloss = parse_gloss_index(xlsx_path)
    print(f"{len(by_gloss)} distinct signs available in ASLLVD.")

    if args.all:
        vocab = sorted(g for g in by_gloss.keys() if PLAIN_WORD_RE.match(g.lower()))
        print(f"{len(vocab)}/{len(by_gloss)} glosses look like plain words (rest are annotation variants, skipped).")
    else:
        vocab = load_vocab(args.words, args.words_file)
        if vocab is None:
            print("Pass --words, --words-file, or --all.")
            sys.exit(1)

    matched = [w for w in vocab if w in by_gloss]
    unmatched = [w for w in vocab if w not in by_gloss]
    print(f"{len(matched)}/{len(vocab)} requested words found in ASLLVD.")
    if unmatched:
        print("Not found in ASLLVD:", ", ".join(unmatched))

    if args.dry_run:
        return

    ffmpeg = find_tool("ffmpeg", args.ffmpeg)
    if not ffmpeg:
        print("ffmpeg not found. Install it (e.g. `brew install ffmpeg`) or pass --ffmpeg.")
        sys.exit(1)

    out_dir = Path(args.out)
    out_dir.mkdir(parents=True, exist_ok=True)

    fps_cache = {}
    results = {}
    for word in matched:
        status = fetch_one_word(word, by_gloss[word], out_dir, ffmpeg, args.max_instance_attempts, args.overwrite, fps_cache)
        results[word] = status
        print(f"{word.lower():20s} {status}")
        time.sleep(random.uniform(0.2, 0.4))

    fetched = sum(1 for s in results.values() if s == "fetched")
    failed = [w for w, s in results.items() if s.startswith("failed")]
    print(f"\nDone. {fetched}/{len(matched)} clips saved to {out_dir}.")
    if failed:
        print("Failed (will fall back to fingerspelling in the app):", ", ".join(w.lower() for w in failed))


if __name__ == "__main__":
    main()
