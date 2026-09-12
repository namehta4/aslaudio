# ASL Audio

Real-time pipeline that listens to your laptop's microphone, transcribes speech,
translates it into an ASL gloss approximation, and plays back the corresponding
signs (video clips if you provide them, otherwise fingerspelling or captions).

Runs entirely client-side as a static web app — no server, no build step, no
dependencies.

## How it works

1. **Speech recognition** — two engines, auto-selected in `js/app.js`:
   - `js/speech.js`: the browser's native Web Speech API (`SpeechRecognition`)
     — instant, continuous, word-by-word results. Supported in Chrome, Edge,
     and Safari; **not** supported in Firefox.
   - `js/whisperSpeech.js`: a fallback used automatically when the native API
     isn't available. Runs a local Whisper model (`onnx-community/whisper-tiny.en`
     via [transformers.js](https://github.com/huggingface/transformers.js),
     WASM or WebGPU) entirely in-browser — no server, works in Firefox.
     Chunks end at natural pauses (energy-based voice-activity detection),
     not a fixed timer, so words don't get sliced in half across chunk
     boundaries; recording continues uninterrupted while the previous chunk
     transcribes in the background, so nothing is missed while it's busy.
     Chunks with no detected speech (silence/background noise) are never
     sent to Whisper at all — feeding it silence is what causes the classic
     "you you you" / "thanks for watching" hallucinations (an artifact of
     its YouTube-caption training data); a small stock-phrase filter and
     `no_repeat_ngram_size` catch anything that slips through anyway.
     Tuning constants (silence threshold/hangover, min/max chunk length) are
     at the top of the file. Downloads a ~40MB model on first use (cached by
     the browser after that); no live word-by-word interim text like the
     native engine gives.

   **Other spoken languages**: the "Spoken language" dropdown lets you speak
   in ~25 languages other than English. Selecting one always routes through
   `whisperSpeech.js` (even in Chrome, since the native API can transcribe
   other languages but can't translate them) using Whisper's built-in
   *translate* task — it converts straight to English text in one step, no
   separate translation API needed. This needs a bigger multilingual model
   (`onnx-community/whisper-small`, ~500MB, loaded only when you pick a
   non-English language) — smaller multilingual models produced outright
   wrong translations for languages less close to English (Japanese, in
   testing) even though they were fine for Spanish, so don't downgrade this
   without re-testing on more than one language family.

   **Auto-detect**: transformers.js doesn't implement real language
   auto-detection itself — passing no language just hardcodes English
   ([known upstream gap](https://github.com/huggingface/transformers.js/issues/302),
   an attempted fix was closed unmerged). The "Auto-detect (any language)"
   option works around this by calling Whisper's model directly: it's
   trained to emit a `<|xx|>` language token as its very first output when
   given only the start-of-transcript token, so `detectLanguage()` in
   `js/whisperSpeech.js` runs one cheap single-token generation (bypassing
   the pipeline's automatic init-token forcing via `decoder_input_ids`) to
   read Whisper's own best guess before running the real translate call.
   Verified correct against real Spanish, Japanese, and English audio.
   Adds a bit of latency per chunk on top of the usual translate delay.
2. **English → ASL gloss** (`js/gloss.js`) — a rule-based translator that
   approximates common ASL-101 grammar points:
   - drops articles (`a`/`an`/`the`), fillers (`to` as an infinitive marker,
     `um`/`uh`), and the copula (`is`/`am`/`are`/...)
   - drops "do-support" auxiliaries (`do`/`does`/`did`)
   - moves time expressions (`today`, `later`, ...) to the front of the sentence
   - moves WH-words (`what`/`where`/`who`/...) to the end, flagging the sentence
     as a WH-question
   - flags yes/no questions and negation
3. **Sign lookup** (`js/dictionary.js`) — looks for a local video/image asset
   named after each gloss word's base form. If none exists, it falls back to
   fingerspelling the word letter-by-letter (again preferring local assets,
   falling back further to plain letter captions).
4. **Playback** (`js/signPlayer.js`) — queues and plays the resolved cues in
   real time as speech comes in, so translation keeps pace with speaking.

**This is a simplified educational approximation, not a certified
interpreter.** Real ASL also uses classifiers, spatial referencing, role
shifting, and non-manual (facial/body) grammar that a linear gloss stream
cannot represent. Treat the gloss/sentence-type badges as a teaching aid, not
ground truth.

Known gaps in the gloss rules, found by testing ~50 varied sentences (not
fixed — they'd need real parsing, not just more lexicon entries):
- A wh-word used to introduce a clause rather than ask a question ("**When**
  you arrive, call me") gets misread as a WH-question and reordered wrong —
  the rules can't tell subordinate-clause "when" from question "when"
  without checking for subject-aux inversion, which this system doesn't do.
- "**How many** people are coming" splits "how" to the sentence end but
  leaves "many" behind, breaking up the idiomatic pair.
- Negating a non-final clause ("I do not think I want it") always attaches
  NOT to the last verb, not necessarily the one actually being negated.
- Immediately repeated words from disfluent speech ("I I want...") aren't
  deduplicated.

## Running it

```bash
./run.sh
```

This starts a local server (needed because the Web Speech API requires a
secure context — it won't work over `file://`) and opens
`http://localhost:8000` in your default browser. Use **Chrome** for the best
Web Speech API support, and allow microphone access when prompted. Press
`Ctrl+C` to stop. Pass a different port with `./run.sh 8080` if 8000 is busy.

No mic? Use the text box in the UI to type sentences through the same
pipeline.

## Adding real sign clips

### Option A: fetch from ASLLVD (primary source, scripted)

`scripts/fetch_asllvd_signs.py` pulls clips from the
[ASLLVD](https://www.bu.edu/asllrp/av/dai-asllvd.html) (Boston University /
Rutgers ASL Linguistic Research Project) — ~2,700 signs, and this project's
primary sign source (see Option A2 for the WLASL backup, used only for
words ASLLVD doesn't have). Source videos are old MPEG-4 clips that
browsers can't play directly, so this script re-encodes each trimmed clip
to H.264 automatically.

ASLLVD data is for **research use only**: no commercial use, no
redistribution, attribution required. Read
[the terms of use](http://www.bu.edu/asllrp/signbank-terms.pdf) before using
it; this project doesn't grant you any additional rights to the videos.

```bash
brew install ffmpeg          # one-time
pip install imageio-ffmpeg   # alternative if you don't use Homebrew

# See which words are available (auto-downloads and caches the ~1.5MB
# glossing spreadsheet on first run):
python3 scripts/fetch_asllvd_signs.py --dry-run

# Fetch specific words:
python3 scripts/fetch_asllvd_signs.py --agree-license --words "hospital,fine,call"

# Fetch every sign ASLLVD has (~2,700 words) — as the primary source, pass
# --overwrite so it takes priority over any existing WLASL-sourced clip:
python3 scripts/fetch_asllvd_signs.py --agree-license --all --overwrite
```

Words that already have a clip are skipped by default; `--overwrite` makes
ASLLVD replace whatever's already there (e.g. a WLASL backup clip) instead.

### Option A2: fetch from WLASL (backup, fills ASLLVD gaps)

`scripts/fetch_wlasl_signs.py` pulls clips from the
[WLASL](https://github.com/dxli94/WLASL) research dataset — run this
*after* Option A to fill in words ASLLVD doesn't have (link rot in either
dataset means the two rarely overlap completely). It skips words that
already have a clip by default, so running it after ASLLVD naturally acts
as a backup rather than overwriting the primary source.

WLASL is distributed under the **Computational Use of Data Agreement
(C-UDA)** — academic/computational use only, no commercial use, and the
underlying video copyright belongs to the original uploaders. Read
`start_kit/C-UDA-1.0.pdf` in the WLASL repo before using it; this project
doesn't grant you any additional rights to the videos.

```bash
brew install yt-dlp                    # one-time, if you didn't already
pip install yt-dlp imageio-ffmpeg      # alternative if you don't use Homebrew

# Get WLASL_v0.3.json (after reading its license):
curl -L -o WLASL_v0.3.json \
  https://raw.githubusercontent.com/dxli94/WLASL/master/start_kit/WLASL_v0.3.json

# See which words are available without downloading anything:
python3 scripts/fetch_wlasl_signs.py --json WLASL_v0.3.json --dry-run

# Fetch every word WLASL has that doesn't already have a clip from ASLLVD:
python3 scripts/fetch_wlasl_signs.py --json WLASL_v0.3.json --agree-license --all

# Or fetch specific words only:
python3 scripts/fetch_wlasl_signs.py --json WLASL_v0.3.json --agree-license \
  --words "hello,thank,water,school"
```

Words not found in WLASL, or whose source video is unreachable, are simply
skipped and fall back to fingerspelling/captions in the app at runtime — no
manual cleanup needed. `scripts/wlasl_default_vocab.txt` is a smaller
curated word list if you don't want the full `--all` run.

### Option B: your own clips

Record your own (or source another properly licensed set — don't redistribute
clips you don't have rights to) and drop files into these folders; the app
picks them up automatically, no code changes needed:

- `assets/signs/<word>.mp4` (or `.webm`/`.png`/`.jpg`/`.gif`/`.svg`) — a clip
  for the word's base form, e.g. `assets/signs/hello.mp4`, `assets/signs/eat.mp4`.
  Lookup tries the word as spoken and simple singular/base-verb forms.
- `assets/fingerspell/<LETTER>.mp4` (or image) — one clip per uppercase
  letter, e.g. `assets/fingerspell/A.mp4`, used when a whole-word sign isn't
  found and fingerspelling is enabled. ASLLVD has all 26 manual-alphabet
  letters as their own glosses (`A`–`Z`) — `fetch_asllvd_signs.py --all`
  already fetches them into `assets/signs/` like any other word, so this
  directory just needs those same 26 files copied over and re-cased, e.g.:
  `for l in {a..z}; do cp assets/signs/$l.mp4 assets/fingerspell/${l^^}.mp4; done`

With no assets at all, the app still runs end-to-end and shows the gloss as
on-screen captions — useful for testing the recognition/translation pipeline
before you've sourced any sign footage.

## Project layout

```
index.html          UI shell
css/style.css        Styling
js/speech.js          Native Web Speech API wrapper (Chrome/Edge/Safari)
js/whisperSpeech.js    In-browser Whisper fallback (Firefox / no native support)
js/gloss.js           English -> ASL gloss rules
js/lexicon.js          Word lists used by the gloss rules
js/lemmatize.js        Lightweight stemmer for dictionary lookup
js/dictionary.js       Asset lookup + fingerspelling fallback
js/signPlayer.js       Playback queue / stage rendering
js/app.js              Wires everything to the DOM
scripts/fetch_wlasl_signs.py    Fetches real sign clips from WLASL into assets/signs/
scripts/wlasl_default_vocab.txt Default word list for the WLASL fetch script
scripts/fetch_asllvd_signs.py   Fetches real sign clips from ASLLVD into assets/signs/
assets/signs/          Word-level sign clips (you supply, or fetch via the scripts above)
assets/fingerspell/    Fingerspelling letter clips (you supply)
```
