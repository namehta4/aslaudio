import { englishToGloss } from "./gloss.js";
import { resolveSentenceCues } from "./dictionary.js";
import { SignPlayer } from "./signPlayer.js";
import { SpeechController } from "./speech.js";
import { WhisperSpeechController } from "./whisperSpeech.js";

const el = (id) => document.getElementById(id);

const micButton = el("micButton");
const micStatus = el("micStatus");
const languageSelect = el("languageSelect");
const languageNote = el("languageNote");
const browserWarning = el("browserWarning");
const interimEl = el("interim");
const transcriptLog = el("transcriptLog");
const glossLog = el("glossLog");
const typeForm = el("typeForm");
const typeInput = el("typeInput");
const speedSlider = el("speedSlider");
const fingerspellToggle = el("fingerspellToggle");

const player = new SignPlayer({
  stageEl: document.querySelector(".stage"),
  queueEl: el("signQueue"),
  getSpeed: () => Number(speedSlider.value)
});

const SENTENCE_TYPE_LABEL = {
  statement: "",
  "yn-question": "🤨 Y/N-Q — raise eyebrows",
  "wh-question": "🤨 WH-Q — raise eyebrows, tilt head, sign order flips"
};

async function handleFinalSentence(text) {
  if (!text) return;

  const logRow = document.createElement("div");
  logRow.className = "log-row";
  logRow.textContent = text;
  transcriptLog.prepend(logRow);

  const { glossTokens, sentenceType } = englishToGloss(text);
  if (glossTokens.length === 0) return;

  const glossRow = document.createElement("div");
  glossRow.className = "log-row gloss-row";
  const badge = SENTENCE_TYPE_LABEL[sentenceType];
  glossRow.innerHTML = `<span class="gloss-tokens">${glossTokens
    .map((t) => `<span class="tag-${t.tag}">${t.gloss}</span>`)
    .join(" ")}</span>${badge ? `<span class="badge">${badge}</span>` : ""}`;
  glossLog.prepend(glossRow);

  const cues = await resolveSentenceCues(glossTokens, {
    fingerspellUnknown: fingerspellToggle.checked
  });
  player.enqueue(cues);
}

function syncMicUI(status) {
  micStatus.textContent = status;
  micStatus.classList.toggle("status-error", status.startsWith("error"));

  const active = status.startsWith("listening") || status === "requesting microphone access…";
  micButton.textContent = active ? "⏹ Stop Listening" : "🎤 Start Listening";
  micButton.classList.toggle("active", active);
}

function showBrowserWarning(message) {
  browserWarning.textContent = message;
  browserWarning.hidden = false;
}

function clearBrowserWarning() {
  browserWarning.textContent = "";
  browserWarning.hidden = true;
}

const speechCallbacks = {
  onInterim: (text) => {
    interimEl.textContent = text;
  },
  onFinal: (text) => {
    interimEl.textContent = "";
    handleFinalSentence(text);
  },
  onStatus: syncMicUI
};

// Prefer the browser's native SpeechRecognition (instant word-by-word
// results) for English, where available (Chrome/Edge/Safari). Any other
// spoken language — or English on a browser without native support
// (Firefox) — uses a local in-browser Whisper model instead, since
// translation always needs to go through Whisper's own translate task.
const nativeSpeech = new SpeechController(speechCallbacks);
const whisperSpeech = new WhisperSpeechController({
  ...speechCallbacks,
  getLanguage: () => languageSelect.value
});

let speech = null;

function pickEngine() {
  return languageSelect.value === "en" && nativeSpeech.supported ? nativeSpeech : whisperSpeech;
}

function updateLanguageNote() {
  if (languageSelect.value === "en") {
    languageNote.hidden = true;
    return;
  }
  const label = languageSelect.selectedOptions[0].textContent;
  languageNote.hidden = false;
  languageNote.textContent =
    `Translating ${label} → English via a local Whisper model (runs fully in-browser). ` +
    "Transcribes in a few seconds per chunk rather than live word-by-word, and downloads a " +
    "~500MB model the first time you click Start.";
}

function refreshBrowserWarnings() {
  clearBrowserWarning();
  micButton.disabled = false;

  if (!speech.supported) {
    micButton.disabled = true;
    showBrowserWarning(
      "🎤 button disabled: this browser supports neither native speech recognition nor the APIs " +
        "(microphone + WebAssembly) the local Whisper fallback needs. Try a modern version of Chrome, " +
        "Edge, Firefox, or Safari — or use the text box below, which works everywhere."
    );
    return;
  }

  if (!speech.secureContext) {
    showBrowserWarning(
      "Open this via ./run.sh (http://localhost), not a file:// URL — the microphone API requires it."
    );
    return;
  }

  if (speech === whisperSpeech && languageSelect.value === "en" && !nativeSpeech.supported) {
    showBrowserWarning(
      "This browser doesn't support native speech recognition, so ASL Audio is using a local " +
        "Whisper model instead (runs fully in-browser). It transcribes in a few seconds per chunk " +
        "rather than live word-by-word, and downloads a ~40MB model the first time you click Start."
    );
  }
}

languageSelect.addEventListener("change", () => {
  const wasListening = speech && speech.listening;
  if (wasListening) speech.stop();

  speech = pickEngine();
  updateLanguageNote();
  refreshBrowserWarnings();

  if (wasListening) speech.start();
});

speech = pickEngine();
updateLanguageNote();
refreshBrowserWarnings();

micButton.addEventListener("click", () => {
  if (speech.listening) {
    speech.stop();
  } else {
    speech.start();
  }
});

typeForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = typeInput.value.trim();
  if (!text) return;
  handleFinalSentence(text);
  typeInput.value = "";
});
