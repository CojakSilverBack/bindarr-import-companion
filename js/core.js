/*
 * Bindarr Import Companion — parsing and formatting (no DOM, no network).
 * Works in the browser (window.BindarrCore) and in Node (require) for tests.
 */
(function (root) {
  "use strict";

  /** Upper bounds that keep a huge paste from freezing the page or flooding Scryfall. */
  const LIMITS = { maxChars: 500000, maxLines: 10000, maxLineLength: 300, maxQty: 999 };

  /** Whole-input check before parsing. Returns an error message, or "" when the input is within limits. */
  function checkInput(text) {
    const s = text || "";
    if (s.length > LIMITS.maxChars) return "The list is over " + LIMITS.maxChars.toLocaleString("en-US") + " characters. Split it into smaller lists.";
    const lines = s.replace(/\s+$/, "").split(/\r?\n/).length;
    if (lines > LIMITS.maxLines) return "The list has " + lines.toLocaleString("en-US") + " lines; the limit is " + LIMITS.maxLines.toLocaleString("en-US") + ". Split it into smaller lists.";
    return "";
  }

  /** "PRE=PDFT, ASDFT=ADFT" -> { PRE: "PDFT", ASDFT: "ADFT" } */
  function parseSetMap(text) {
    const map = {};
    (text || "").split(/[,;\n]/).forEach(function (pair) {
      const kv = pair.split("=");
      if (kv.length === 2 && kv[0].trim() && kv[1].trim()) {
        map[kv[0].trim().toUpperCase()] = kv[1].trim().toUpperCase();
      }
    });
    return map;
  }

  /**
   * Parse one line of a card list.
   * Returns null for blank lines, { skip: true, raw } for headers ("Commander", "Sideboard"),
   * { error, raw } for card lines that break a limit (too long, quantity outside 1-999),
   * otherwise { qty, name, set, num, foil, src, variant, raw }.
   *
   * Accepted shapes:
   *   TCGplayer app      2 Zahur, Glory's Past (Borderless) [DFT] 370
   *   ManaBox / Moxfield 1 Spell Pierce (DFT) 64 *F*
   *   Set only           1 Sol Ring (EOC)
   *   Plain decklist     1 Arcane Signet      (also "1x Arcane Signet")
   */
  function parseLine(rawLine) {
    const t = rawLine.trim();
    if (!t) return null;
    if (t.length > LIMITS.maxLineLength) {
      return { error: "Line is over " + LIMITS.maxLineLength + " characters", raw: t.slice(0, 80) + "…" };
    }
    const m = t.match(/^(\d+)x?\s+(.+)$/i);
    if (!m) return { skip: true, raw: t };

    const qty = m[1].length <= 4 ? parseInt(m[1], 10) : Infinity;
    if (!(qty >= 1 && qty <= LIMITS.maxQty)) {
      return { error: "Quantity must be 1 to " + LIMITS.maxQty, raw: t };
    }
    let rest = m[2].trim();
    let foil = false;
    if (/\s\*[FE]\*\s*$/i.test(rest)) {
      foil = true;
      rest = rest.replace(/\s\*[FE]\*\s*$/i, "").trim();
    }

    let name = rest, set = "", num = "", src = "plain", variant = "";
    let x = rest.match(/^(.*?)\s\[([A-Za-z0-9]+)\]\s+(\S+)$/);
    if (x) { name = x[1]; set = x[2]; num = x[3]; src = "tcgplayer"; }
    else if ((x = rest.match(/^(.*?)\s\(([A-Za-z0-9]{2,6})\)\s+(\S+)$/))) { name = x[1]; set = x[2]; num = x[3]; src = "setnum"; }
    else if ((x = rest.match(/^(.*?)\s\(([A-Za-z0-9]{2,6})\)$/))) { name = x[1]; set = x[2]; src = "setonly"; }

    // TCGplayer appends variant labels after the name: "(Borderless)", "(0289)", "(First-Place Foil)".
    const vm = name.match(/((?:\s\([^)]*\))+)$/);
    if (vm && src !== "plain") { variant = vm[1].trim(); name = name.slice(0, vm.index).trim(); }
    if (/foil/i.test(variant)) foil = true;

    return { qty: qty, name: name.trim(), set: set.toUpperCase(), num: num, foil: foil, src: src, variant: variant, raw: t };
  }

  /** Bindarr / ManaBox text line: "2 Zahur, Glory's Past (DFT) 370 *F*" */
  function formatLine(row) {
    return row.qty + " " + row.name + " (" + row.set + ") " + row.num + (row.foil ? " *F*" : "");
  }

  /** Scryfall /cards/collection identifier for a parsed row. */
  function identifierFor(row, defaultSet, setMap) {
    const map = setMap || {};
    const set = row.set ? (map[row.set] || row.set) : (defaultSet || "");
    if (set && row.num) return { set: set.toLowerCase(), collector_number: row.num };
    if (set) return { name: row.name, set: set.toLowerCase() };
    return { name: row.name };
  }

  /** Does a Scryfall card object answer this identifier? (Collection results are not positional.) */
  function cardMatches(card, id) {
    const names = [card.name].concat((card.card_faces || []).map(function (f) { return f.name; }))
      .map(function (n) { return (n || "").toLowerCase(); });
    if (id.collector_number) return card.set === id.set && card.collector_number === id.collector_number;
    const nameHit = names.indexOf((id.name || "").toLowerCase()) !== -1;
    return id.set ? (nameHit && card.set === id.set) : nameHit;
  }

  /**
   * Rank Scryfall sets for an autocomplete query. sets: [{ code, name, released }].
   * Order: exact code, code prefix, a word in the name starts with the query, name contains it;
   * newest first within each group.
   */
  function matchSets(sets, query, limit) {
    const q = (query || "").trim().toLowerCase();
    if (!q) return [];
    const hits = [];
    (sets || []).forEach(function (s) {
      const code = s.code.toLowerCase(), name = s.name.toLowerCase();
      let rank = -1;
      if (code === q) rank = 0;
      else if (code.indexOf(q) === 0) rank = 1;
      else if (name.indexOf(q) === 0 || name.indexOf(" " + q) !== -1) rank = 2;
      else if (name.indexOf(q) !== -1) rank = 3;
      if (rank !== -1) hits.push({ s: s, rank: rank });
    });
    hits.sort(function (a, b) {
      return a.rank - b.rank || (b.s.released || "").localeCompare(a.s.released || "") || a.s.name.localeCompare(b.s.name);
    });
    return hits.slice(0, limit || 12).map(function (h) { return h.s; });
  }

  /**
   * The entry under the caret in a "PRE=PDFT, ASDFT=ADFT" field: the text between the nearest
   * separators (, ; =). Returns { start, end, text } with surrounding spaces trimmed off.
   */
  function tokenAt(value, caret) {
    const v = value || "";
    const at = Math.max(0, Math.min(caret == null ? v.length : caret, v.length));
    let start = at, end = at;
    while (start > 0 && !/[,;=]/.test(v[start - 1])) start--;
    while (end < v.length && !/[,;=]/.test(v[end])) end++;
    while (start < end && v[start] === " ") start++;
    while (end > start && v[end - 1] === " ") end--;
    return { start: start, end: end, text: v.slice(start, end) };
  }

  /**
   * Same printing (set + collector number) on more than one line, with every copy marked the same way
   * for foil. TCGplayer exports don't mark foils, so a normal + foil pair arrives as two identical lines.
   * Returns an array parallel to rows: null, or { lines } (how many lines share that printing).
   * Rows with status "bad" or no set/number are ignored. Once the foil ticks differ, the group is not flagged.
   */
  function duplicatePrintings(rows) {
    const groups = {};
    rows.forEach(function (r, i) {
      if (r.status === "bad" || !r.set || !r.num) return;
      const key = r.set.toUpperCase() + "|" + String(r.num).toLowerCase();
      (groups[key] = groups[key] || []).push(i);
    });
    const out = rows.map(function () { return null; });
    Object.keys(groups).forEach(function (key) {
      const idx = groups[key];
      if (idx.length < 2) return;
      const foil = !!rows[idx[0]].foil;
      if (idx.some(function (i) { return !!rows[i].foil !== foil; })) return;
      idx.forEach(function (i) { out[i] = { lines: idx.length }; });
    });
    return out;
  }

  /**
   * Order for the review table: lines that share a printing (set + collector number) are pulled together,
   * at the position of the first one; everything else keeps its original order. Foil ticks are ignored,
   * so the order stays put while you tick. Returns { order: [row indexes], grouped: [bool per row] }.
   */
  function reviewOrder(rows) {
    const keyOf = function (r) { return r.status === "bad" || !r.set || !r.num ? null : r.set.toUpperCase() + "|" + String(r.num).toLowerCase(); };
    const members = {};
    rows.forEach(function (r, i) { const k = keyOf(r); if (k) (members[k] = members[k] || []).push(i); });
    const order = [], placed = {};
    const grouped = rows.map(function () { return false; });
    rows.forEach(function (r, i) {
      const k = keyOf(r);
      if (!k) { order.push(i); return; }
      if (placed[k]) return;
      placed[k] = true;
      members[k].forEach(function (j) { order.push(j); if (members[k].length > 1) grouped[j] = true; });
    });
    return { order: order, grouped: grouped };
  }

  /** "ECL, SPG ecl" -> ["ECL", "SPG"]: a list of set codes, upper-cased, duplicates dropped. */
  function parseSetList(text) {
    const out = [];
    (text || "").split(/[\s,;]+/).forEach(function (c) {
      const code = c.trim().toUpperCase();
      if (code && out.indexOf(code) === -1) out.push(code);
    });
    return out;
  }

  /**
   * Sets to try, in order, when a card isn't in `base`: base's parent set from Scryfall (and its parent,
   * up to 3 levels, e.g. ECC -> ECL), then the user's extra sets. `parents` maps CODE -> parent CODE.
   * Never includes base itself, and never repeats a set.
   */
  function relatedSets(base, parents, extra) {
    const b = (base || "").toUpperCase();
    const out = [];
    const add = function (c) { if (c && c !== b && out.indexOf(c) === -1) out.push(c); };
    let cur = b, depth = 0;
    while (cur && parents && parents[cur] && depth < 3) { cur = parents[cur]; add(cur); depth++; }
    (extra || []).forEach(add);
    return out;
  }

  const api = { LIMITS: LIMITS, parseSetList: parseSetList, relatedSets: relatedSets, duplicatePrintings: duplicatePrintings, reviewOrder: reviewOrder, checkInput: checkInput, matchSets: matchSets, tokenAt: tokenAt, parseSetMap: parseSetMap, parseLine: parseLine, formatLine: formatLine, identifierFor: identifierFor, cardMatches: cardMatches };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BindarrCore = api;
})(this);
