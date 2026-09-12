export function lemmaCandidates(word) {
  const w = word.toLowerCase().replace(/[^a-z']/g, "");
  const candidates = [w];

  if (w.endsWith("'s")) {
    candidates.push(w.slice(0, -2));
  }
  if (w.endsWith("ies") && w.length > 4) {
    candidates.push(w.slice(0, -3) + "y");
  } else if (/(sh|ch|x|s|z)es$/.test(w) && w.length > 4) {
    candidates.push(w.slice(0, -2));
  } else if (w.endsWith("s") && !w.endsWith("ss") && w.length > 3) {
    candidates.push(w.slice(0, -1));
  }
  if (w.endsWith("ing") && w.length > 5) {
    candidates.push(w.slice(0, -3));
    candidates.push(w.slice(0, -3) + "e");
  }
  if (w.endsWith("ed") && w.length > 4) {
    candidates.push(w.slice(0, -2));
    candidates.push(w.slice(0, -1));
  }

  return [...new Set(candidates.filter(Boolean))];
}
