import { LEXICON } from "./lexicon.js";

function expandContractions(text) {
  let out = text;
  for (const [contraction, expansion] of Object.entries(LEXICON.contractions)) {
    const re = new RegExp(`\\b${contraction.replace("'", "['’]")}\\b`, "gi");
    out = out.replace(re, expansion);
  }
  out = out.replace(/n['’]t\b/gi, " not");
  return out;
}

function tokenize(text) {
  return (text.match(/[a-zA-Z']+/g) || []).map((w) => w.toLowerCase());
}

/**
 * Simplified, rule-based English -> ASL gloss translation.
 * Approximates common ASL-101 teaching points: TIME-TOPIC-COMMENT ordering,
 * WH-word placed sentence-final, dropped copula/articles/do-support,
 * negation marked after the verb phrase. This is a pedagogical approximation,
 * not a substitute for a certified interpreter — real ASL also relies on
 * classifiers, spatial referencing, and non-manual (facial) grammar that
 * text gloss alone cannot represent.
 */
export function englishToGloss(sentenceText) {
  const hasQuestionMark = /\?\s*$/.test(sentenceText.trim());
  const expanded = expandContractions(sentenceText);
  const tokens = tokenize(expanded);

  if (tokens.length === 0) {
    return { glossTokens: [], sentenceType: "statement", raw: sentenceText };
  }

  const whIndex = tokens.findIndex((t) => LEXICON.whWords.includes(t));
  let sentenceType = "statement";
  if (whIndex !== -1) {
    sentenceType = "wh-question";
  } else if (hasQuestionMark || LEXICON.ynAuxiliaries.includes(tokens[0])) {
    sentenceType = "yn-question";
  }

  const timeTokens = [];
  const mainTokens = [];
  const negTokens = [];
  const whTokens = [];

  tokens.forEach((word, i) => {
    if (LEXICON.articles.includes(word) || LEXICON.fillers.includes(word)) return;

    if (LEXICON.whWords.includes(word)) {
      whTokens.push(word);
      return;
    }

    if (LEXICON.negations.includes(word)) {
      negTokens.push(word);
      return;
    }

    const nextWord = tokens[i + 1];
    const isDoSupport =
      ["do", "does", "did"].includes(word) &&
      (LEXICON.negations.includes(nextWord) || sentenceType !== "statement");
    const isSentenceInitialQuestionAux =
      i === 0 && sentenceType === "yn-question" && LEXICON.ynAuxiliaries.includes(word);
    if (isDoSupport || isSentenceInitialQuestionAux) return;

    if (LEXICON.copula.includes(word)) return;

    if (LEXICON.timeWords.includes(word)) {
      timeTokens.push(word);
      return;
    }

    mainTokens.push(word);
  });

  const ordered = [...timeTokens, ...mainTokens, ...negTokens, ...whTokens];
  const glossTokens = ordered.map((word) => ({
    word,
    gloss: word.toUpperCase(),
    tag: timeTokens.includes(word)
      ? "time"
      : negTokens.includes(word)
      ? "neg"
      : whTokens.includes(word)
      ? "wh"
      : "main"
  }));

  return { glossTokens, sentenceType, raw: sentenceText };
}
