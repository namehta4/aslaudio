const TRANSFORMERS_URL = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0";
const ENGLISH_MODEL_ID = "onnx-community/whisper-tiny.en";
// Used only when a non-English spoken language is selected, to translate
// straight to English via Whisper's built-in translate task. Needs to be
// this much bigger than the English-only model — whisper-tiny's multilingual
// variant produced outright wrong translations for non-European-adjacent
// languages (e.g. Japanese) in testing; whisper-small was the smallest size
// that translated those correctly.
const MULTILINGUAL_MODEL_ID = "onnx-community/whisper-small";
const SAMPLE_RATE = 16000;

// Voice-activity detection tuning: chunks end at natural pauses instead of
// an arbitrary fixed-length timer, so words don't get sliced in half at
// chunk boundaries (which was hurting transcription accuracy) and short
// utterances get transcribed as soon as you pause (instead of always
// waiting out a fixed window, which was hurting latency).
const VAD_POLL_MS = 80;
const SILENCE_RMS_THRESHOLD = 0.02;
const SILENCE_HANGOVER_MS = 600; // sustained quiet before a chunk is considered finished
const MIN_CHUNK_MS = 800; // ignore silence before this much audio is captured (avoids over-segmenting on breaths)
const MAX_CHUNK_MS = 8000; // hard cap so continuous speech without pauses still gets flushed
const MIN_SPEECH_MS = 400; // a chunk needs at least this much above-threshold audio to be worth transcribing —
// otherwise it's silence/background noise, and feeding Whisper silence is exactly what causes it to
// hallucinate repeated filler text ("you you you", "thank you", ...), an artifact of its training data.
const MIN_CHUNK_BYTES = 1000;
const MIN_AUDIO_SECONDS = 0.3;

// Last-resort filter for known Whisper silence/noise hallucinations that
// slip past the speech-duration gate above (e.g. a loud mic pop with no
// real speech). These stock phrases come from its YouTube-caption training
// data ("thanks for watching", "subscribe", ...).
const HALLUCINATION_PHRASES = new Set([
  "you",
  "thank you",
  "thanks for watching",
  "thanks for watching!",
  "please subscribe",
  "subscribe",
  "bye",
  "bye-bye",
  "the end",
  "i'll see you next time",
  "see you next time"
]);

function isLikelyHallucination(text) {
  const normalized = text.trim().toLowerCase().replace(/[.!?]+$/, "");
  if (!normalized) return true;
  if (HALLUCINATION_PHRASES.has(normalized)) return true;

  const words = normalized.split(/\s+/);
  return words.length >= 3 && words.every((w) => w === words[0]);
}

/**
 * Detects the spoken language of an audio chunk using Whisper's own
 * language-token prediction, since transformers.js doesn't expose this
 * itself (it just hardcodes English when no language is given — see
 * https://github.com/huggingface/transformers.js/issues/302). Whisper is
 * trained to emit a `<|xx|>` language token as the very first output when
 * given only the start-of-transcript token, so a single cheap one-token
 * generation (skipping the pipeline's automatic language forcing by
 * supplying decoder_input_ids directly) reveals its own best guess.
 * Returns a 2-letter language code (e.g. "es", "ja"), which Whisper also
 * accepts directly as the `language` option for the real transcribe/
 * translate call.
 */
async function detectLanguage(transcriber, audio) {
  const { model, processor } = transcriber;
  const inputs = await processor(audio);
  const startTokenId = model.generation_config.decoder_start_token_id;

  const output = await model.generate({
    inputs: inputs.input_features,
    decoder_input_ids: [[startTokenId]],
    max_new_tokens: 1
  });

  const sequence = (output.sequences ?? output).tolist()[0];
  const predictedId = Number(sequence[sequence.length - 1]);

  for (const [token, id] of Object.entries(model.generation_config.lang_to_id)) {
    if (id === predictedId) return token.replace(/[<|>]/g, "");
  }
  return "en";
}

/**
 * Speech recognition that runs entirely in-browser via a local Whisper
 * model (transformers.js, WASM/WebGPU) — no server, no browser-vendor
 * SpeechRecognition API required. Works in Firefox/Safari, unlike
 * SpeechController.
 *
 * Recording is continuous: as soon as one chunk ends (on a detected pause),
 * the next chunk starts recording immediately, while the previous chunk is
 * transcribed concurrently in the background — so no audio is dropped
 * while Whisper is busy. Tradeoff vs. native SpeechRecognition: no live
 * word-by-word interim text, and a ~40MB model download on first use
 * (cached by the browser after that).
 */
export class WhisperSpeechController {
  constructor({ onInterim, onFinal, onStatus, getLanguage }) {
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onStatus = onStatus || (() => {});
    this.getLanguage = getLanguage || (() => "en");
    this.listening = false;
    this.supported = !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.AudioContext);
    this.secureContext = window.isSecureContext !== false;
    this._transcribers = new Map();
    this._stream = null;
    this._vadCtx = null;
    this._analyser = null;
    this._transcriptionQueue = Promise.resolve();
  }

  _getTranscriber() {
    const isEnglish = this.getLanguage() === "en";
    const modelId = isEnglish ? ENGLISH_MODEL_ID : MULTILINGUAL_MODEL_ID;

    if (!this._transcribers.has(modelId)) {
      this.onStatus(
        isEnglish
          ? "loading local speech model… (first run only, ~40MB)"
          : "loading multilingual translation model… (first run only, ~500MB)"
      );
      const promise = import(TRANSFORMERS_URL).then(({ pipeline }) => {
        const device = navigator.gpu ? "webgpu" : "wasm";
        return pipeline("automatic-speech-recognition", modelId, { device });
      });
      this._transcribers.set(modelId, promise);
    }
    return this._transcribers.get(modelId);
  }

  async start() {
    if (!this.supported || this.listening) return;

    if (!this.secureContext) {
      this.onStatus(
        "error: microphone requires a secure context — open this via ./run.sh (http://localhost), not a file:// URL"
      );
      return;
    }

    this.listening = true;
    try {
      this._stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (err) {
      this.listening = false;
      this.onStatus(`error: ${err.message || err}`);
      return;
    }

    this._setUpVad();
    this._getTranscriber();
    this.onStatus("listening (local Whisper model)…");
    this._startChunk();
  }

  stop() {
    this.listening = false;
    if (this._vadCtx) {
      this._vadCtx.close();
      this._vadCtx = null;
      this._analyser = null;
    }
    if (this._stream) {
      this._stream.getTracks().forEach((track) => track.stop());
      this._stream = null;
    }
    this.onStatus("stopped");
  }

  _setUpVad() {
    this._vadCtx = new AudioContext();
    const source = this._vadCtx.createMediaStreamSource(this._stream);
    this._analyser = this._vadCtx.createAnalyser();
    this._analyser.fftSize = 1024;
    source.connect(this._analyser);
  }

  _currentRms() {
    const buffer = new Uint8Array(this._analyser.fftSize);
    this._analyser.getByteTimeDomainData(buffer);
    let sumSquares = 0;
    for (let i = 0; i < buffer.length; i++) {
      const normalized = (buffer[i] - 128) / 128;
      sumSquares += normalized * normalized;
    }
    return Math.sqrt(sumSquares / buffer.length);
  }

  _startChunk() {
    if (!this.listening || !this._stream) return;

    let recorder;
    try {
      recorder = new MediaRecorder(this._stream);
    } catch (err) {
      this.onStatus(`error: ${err.message || err}`);
      return;
    }

    const chunks = [];
    const startedAt = performance.now();
    let silenceStartedAt = null;
    let speechMs = 0;
    let settled = false;

    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size) chunks.push(event.data);
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(pollHandle);

      // Keep recording continuously — start the next chunk right away,
      // in parallel with transcribing this one, so we never miss audio.
      if (this.listening) this._startChunk();

      // Don't bother transcribing chunks that never had real speech in
      // them (silence/background noise) — sending Whisper near-silent
      // audio is what causes it to hallucinate repeated filler text.
      if (chunks.length && speechMs >= MIN_SPEECH_MS) {
        const blob = new Blob(chunks, { type: recorder.mimeType });
        this._enqueueTranscription(blob);
      }
    };

    recorder.onstop = finish;
    recorder.onerror = finish;
    recorder.start();

    const pollHandle = setInterval(() => {
      if (!this._analyser || recorder.state === "inactive") return;

      const elapsed = performance.now() - startedAt;
      const rms = this._currentRms();

      if (rms < SILENCE_RMS_THRESHOLD) {
        if (silenceStartedAt === null) silenceStartedAt = performance.now();
        const silenceElapsed = performance.now() - silenceStartedAt;
        if (elapsed >= MIN_CHUNK_MS && silenceElapsed >= SILENCE_HANGOVER_MS) {
          recorder.stop();
          return;
        }
      } else {
        silenceStartedAt = null;
        speechMs += VAD_POLL_MS;
      }

      if (elapsed >= MAX_CHUNK_MS) {
        recorder.stop();
      }
    }, VAD_POLL_MS);
  }

  _enqueueTranscription(blob) {
    this._transcriptionQueue = this._transcriptionQueue
      .then(() => this._transcribeBlob(blob))
      .catch((err) => this.onStatus(`error: ${err.message || err}`));
  }

  async _transcribeBlob(blob) {
    if (blob.size < MIN_CHUNK_BYTES) return;

    const audio = await this._decodeToFloat32(blob);
    if (audio.length / SAMPLE_RATE < MIN_AUDIO_SECONDS) return;

    let language = this.getLanguage();
    const transcriber = await this._getTranscriber();

    if (language === "auto") {
      language = await detectLanguage(transcriber, audio);
    }

    // no_repeat_ngram_size guards against Whisper getting stuck in a
    // repetition loop ("you you you you") on borderline/noisy audio.
    // For non-English input, Whisper's own translate task converts
    // straight to English — no separate translation API needed.
    const options = { no_repeat_ngram_size: 3 };
    if (language !== "en") {
      options.task = "translate";
      options.language = language;
    }

    const result = await transcriber(audio, options);
    const text = (result.text || "").trim();
    if (text && !isLikelyHallucination(text)) this.onFinal(text);
  }

  async _decodeToFloat32(blob) {
    const arrayBuffer = await blob.arrayBuffer();
    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE });
    try {
      const decoded = await audioCtx.decodeAudioData(arrayBuffer);
      if (decoded.numberOfChannels === 2) {
        const left = decoded.getChannelData(0);
        const right = decoded.getChannelData(1);
        const mono = new Float32Array(left.length);
        for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) / 2;
        return mono;
      }
      return decoded.getChannelData(0);
    } finally {
      audioCtx.close();
    }
  }
}
