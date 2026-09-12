import { lemmaCandidates } from "./lemmatize.js";

const VIDEO_EXTS = ["mp4", "webm"];
const IMAGE_EXTS = ["png", "jpg", "jpeg", "gif", "svg"];
const probeCache = new Map();

function probeVideo(url) {
  if (probeCache.has(url)) return probeCache.get(url);
  const p = new Promise((resolve) => {
    const v = document.createElement("video");
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    v.onloadedmetadata = () => done(true);
    v.onerror = () => done(false);
    v.src = url;
    setTimeout(() => done(false), 1500);
  });
  probeCache.set(url, p);
  return p;
}

function probeImage(url) {
  if (probeCache.has(url)) return probeCache.get(url);
  const p = new Promise((resolve) => {
    const img = new Image();
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    img.onload = () => done(true);
    img.onerror = () => done(false);
    img.src = url;
    setTimeout(() => done(false), 1500);
  });
  probeCache.set(url, p);
  return p;
}

function captionDuration(text) {
  return Math.min(1400, Math.max(400, 300 + text.length * 40));
}

async function findAsset(baseDir, name) {
  for (const ext of VIDEO_EXTS) {
    const url = `${baseDir}/${name}.${ext}`;
    if (await probeVideo(url)) return { type: "video", src: url };
  }
  for (const ext of IMAGE_EXTS) {
    const url = `${baseDir}/${name}.${ext}`;
    if (await probeImage(url)) return { type: "image", src: url, duration: captionDuration(name) };
  }
  return null;
}

async function resolveFingerspelling(word, gloss) {
  const letters = word.replace(/[^a-zA-Z]/g, "").toUpperCase().split("");
  if (letters.length === 0) return null;

  const cues = [];
  for (const letter of letters) {
    const asset = await findAsset("assets/fingerspell", letter);
    if (asset) {
      cues.push({ ...asset, label: letter });
    } else {
      cues.push({ type: "caption", text: letter, label: letter, duration: 450, small: true });
    }
  }
  return { type: "group", cues, label: gloss, fingerspelled: true };
}

/**
 * Resolves one gloss token to a playable cue: a local sign video/image if
 * present under assets/signs/, otherwise fingerspelling (assets/fingerspell/
 * per-letter clips, falling back further to plain letter captions), or —
 * when fingerspelling is disabled — a single caption card for the word.
 */
export async function resolveWordCue(token, { fingerspellUnknown = true } = {}) {
  const { word, gloss } = token;
  if (!word) return null;

  for (const candidate of lemmaCandidates(word)) {
    const asset = await findAsset("assets/signs", candidate);
    if (asset) return { ...asset, label: gloss, tag: token.tag };
  }

  if (fingerspellUnknown) {
    const spelled = await resolveFingerspelling(word, gloss);
    if (spelled) return { ...spelled, tag: token.tag };
  }

  return {
    type: "caption",
    text: gloss,
    label: gloss,
    duration: captionDuration(gloss),
    tag: token.tag
  };
}

const MAX_PHRASE_WORDS = 3;

/**
 * Resolves a full gloss sequence to playable cues, preferring multi-word
 * sign phrases (e.g. "thank-you.mp4", "ice-cream.mp4") over signing
 * consecutive words individually — closer to natural ASL, where a single
 * concept is often one sign rather than a word-for-word gloss. Tries the
 * longest window first at each position, falling back to single-word
 * lookup (and fingerspelling) when no phrase asset exists.
 */
export async function resolveSentenceCues(glossTokens, options) {
  const cues = [];
  let i = 0;

  while (i < glossTokens.length) {
    let matched = false;

    for (let windowSize = Math.min(MAX_PHRASE_WORDS, glossTokens.length - i); windowSize > 1; windowSize--) {
      const windowTokens = glossTokens.slice(i, i + windowSize);
      const phraseSlug = windowTokens.map((t) => t.word).join("-");
      const asset = await findAsset("assets/signs", phraseSlug);
      if (asset) {
        const label = windowTokens.map((t) => t.gloss).join(" ");
        cues.push({ ...asset, label, tag: windowTokens[0].tag });
        i += windowSize;
        matched = true;
        break;
      }
    }

    if (!matched) {
      const cue = await resolveWordCue(glossTokens[i], options);
      if (cue) cues.push(cue);
      i += 1;
    }
  }

  return cues;
}
