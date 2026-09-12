const CROSSFADE_MS = 150;
const VIDEO_READY_TIMEOUT_MS = 800;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Plays a queue of sign cues on two alternating, absolutely-positioned
 * "layers" so consecutive clips crossfade into each other instead of
 * cutting through a black flash — the next cue is prepared (loaded/primed)
 * on the hidden back layer, then the two layers swap visibility with a CSS
 * opacity transition.
 */
export class SignPlayer {
  constructor({ stageEl, queueEl, getSpeed }) {
    this.queueEl = queueEl;
    this.getSpeed = getSpeed || (() => 1);
    this.queue = [];
    this.playing = false;

    this.layers = Array.from(stageEl.querySelectorAll(".stage-layer")).map((el) => ({
      el,
      video: el.querySelector("video"),
      image: el.querySelector("img"),
      caption: el.querySelector(".caption")
    }));
    this.frontIndex = 0;
    for (const layer of this.layers) this._resetLayer(layer);
  }

  enqueue(cues) {
    this.queue.push(...cues);
    this._renderQueuePreview();
    if (!this.playing) this._loop();
  }

  clear() {
    this.queue = [];
    this._renderQueuePreview();
    this._clearStage();
  }

  async _loop() {
    this.playing = true;
    while (this.queue.length) {
      const cue = this.queue.shift();
      this._renderQueuePreview();
      await this._showCue(cue);
    }
    this.playing = false;
    this._clearStage();
  }

  async _showCue(cue) {
    if (cue.type === "group") {
      for (const sub of cue.cues) {
        await this._showCue(sub);
      }
      return;
    }

    const speed = this.getSpeed() || 1;
    const back = this.layers[1 - this.frontIndex];
    this._setLabel(cue.label);

    if (cue.type === "video") {
      await this._prepareVideo(back, cue.src, speed);
      this._swap(back);
      await new Promise((resolve) => {
        back.video.onended = resolve;
        setTimeout(resolve, 4000);
      });
      return;
    }

    if (cue.type === "image") {
      this._prepareImage(back, cue.src);
      this._swap(back);
      await delay((cue.duration || 600) / speed);
      return;
    }

    if (cue.type === "caption") {
      this._prepareCaption(back, cue.text, cue.small);
      this._swap(back);
      await delay((cue.duration || 600) / speed);
      return;
    }

    if (cue.type === "pause") {
      await delay((cue.duration || 150) / speed);
    }
  }

  _prepareVideo(layer, src, speed) {
    this._resetLayer(layer);
    layer.video.src = src;
    layer.video.hidden = false;
    layer.video.playbackRate = speed;
    return new Promise((resolve) => {
      let settled = false;
      const done = () => {
        if (settled) return;
        settled = true;
        layer.video.play().catch(() => {});
        resolve();
      };
      layer.video.oncanplay = done;
      layer.video.onerror = done;
      setTimeout(done, VIDEO_READY_TIMEOUT_MS);
    });
  }

  _prepareImage(layer, src) {
    this._resetLayer(layer);
    layer.image.src = src;
    layer.image.hidden = false;
  }

  _prepareCaption(layer, text, small) {
    this._resetLayer(layer);
    layer.caption.textContent = text;
    layer.caption.hidden = false;
    layer.caption.classList.toggle("small", !!small);
  }

  _swap(back) {
    const front = this.layers[this.frontIndex];
    back.el.classList.add("visible");
    front.el.classList.remove("visible");
    this.frontIndex = this.layers.indexOf(back);
  }

  _setLabel(label) {
    this.queueEl.dataset.current = label || "";
  }

  _resetLayer(layer) {
    layer.video.pause();
    layer.video.removeAttribute("src");
    layer.video.hidden = true;
    layer.image.removeAttribute("src");
    layer.image.hidden = true;
    layer.caption.textContent = "";
    layer.caption.hidden = true;
  }

  _clearStage() {
    for (const layer of this.layers) {
      layer.el.classList.remove("visible");
      this._resetLayer(layer);
    }
  }

  _renderQueuePreview() {
    const upcoming = this.queue.slice(0, 8).map((c) => c.label || "");
    this.queueEl.textContent = upcoming.join("  →  ");
  }
}
