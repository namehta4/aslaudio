const FATAL_ERRORS = new Set(["not-allowed", "service-not-allowed", "audio-capture"]);

export class SpeechController {
  constructor({ onInterim, onFinal, onStatus }) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    this.supported = !!SpeechRecognition;
    this.secureContext = window.isSecureContext !== false;
    this.onInterim = onInterim || (() => {});
    this.onFinal = onFinal || (() => {});
    this.onStatus = onStatus || (() => {});
    this.listening = false;
    this.pendingErrorStatus = null;

    if (!this.supported) return;

    this.recognition = new SpeechRecognition();
    this.recognition.continuous = true;
    this.recognition.interimResults = true;
    this.recognition.lang = "en-US";

    this.recognition.onresult = (event) => {
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          this.onFinal(text.trim());
        } else {
          interim += text;
        }
      }
      if (interim) this.onInterim(interim.trim());
    };

    this.recognition.onerror = (event) => {
      if (FATAL_ERRORS.has(event.error)) {
        this.listening = false;
        this.pendingErrorStatus = describeError(event.error);
      } else if (event.error !== "no-speech" && event.error !== "aborted") {
        this.pendingErrorStatus = describeError(event.error);
      }
    };

    this.recognition.onend = () => {
      if (this.pendingErrorStatus) {
        this.onStatus(this.pendingErrorStatus);
        this.pendingErrorStatus = null;
        return;
      }
      if (this.listening) {
        try {
          this.recognition.start();
        } catch {
          // already starting; browser will fire another onend shortly
        }
      } else {
        this.onStatus("stopped");
      }
    };
  }

  start() {
    if (!this.supported || this.listening) return;

    if (!this.secureContext) {
      this.onStatus(
        "error: microphone requires a secure context — open this via ./run.sh (http://localhost), not a file:// URL"
      );
      return;
    }

    this.listening = true;
    this.onStatus("requesting microphone access…");
    try {
      this.recognition.start();
    } catch (err) {
      this.listening = false;
      this.onStatus(`error: ${err.message || err}`);
    }
  }

  stop() {
    if (!this.supported) return;
    this.listening = false;
    this.recognition.stop();
  }
}

function describeError(code) {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
      return "error: microphone permission denied — check the mic icon in your browser's address bar";
    case "audio-capture":
      return "error: no microphone found";
    case "network":
      return "error: network error reaching the speech recognition service";
    default:
      return `error: ${code}`;
  }
}
