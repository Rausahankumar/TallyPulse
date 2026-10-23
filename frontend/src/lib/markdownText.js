const LIST_ITEM_RE = /^\s*(?:\d+[.)]|[-*+])\s/;
const FENCE_RE = /^\s*(?:```|~~~)/;

// CommonMark reads an unindented line right after a list item as a "lazy continuation" of that item, so the
// engine's "Total: ..." line would be folded into the last row. Ending the list with a blank line there is a
// layout-only change: no character of the answer is added, removed or altered. Code fences are left alone.
export function separateListTrailers(text) {
  const out = [];
  let inFence = false;
  let prev = "";
  for (const line of text.split("\n")) {
    if (FENCE_RE.test(line)) inFence = !inFence;
    else if (!inFence && LIST_ITEM_RE.test(prev) && line.trim() && !/^\s/.test(line) && !LIST_ITEM_RE.test(line)) out.push("");
    out.push(line);
    prev = inFence ? "" : line;
  }
  return out.join("\n");
}
