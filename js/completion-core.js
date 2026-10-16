/*
 * Bindarr Import Companion — set completion logic (no DOM, no network).
 * Works in the browser (window.BindarrCompletion) and in Node (require) for tests.
 */
(function (root) {
  "use strict";


  const RARITY_ORDER = ["common", "uncommon", "rare", "mythic", "special", "bonus"];
  const EXPORT_LIMITS = { maxChars: 10000000, maxLines: 100000, maxSets: 60 };

  /** "Mythic" / "mythic rare" / "M" -> "mythic"; unknown values are lower-cased as they are. */
  function normRarity(r) {
    const s = String(r || "").trim().toLowerCase();
    if (s === "m" || s.indexOf("mythic") === 0) return "mythic";
    if (s === "r") return "rare";
    if (s === "u") return "uncommon";
    if (s === "c") return "common";
    return s;
  }

  function printingKey(set, num) { return String(set || "").toLowerCase() + "|" + String(num || "").trim().toLowerCase(); }

  /** Natural order for collector numbers: 2 < 10 < 10a < 28s < ★. */
  function compareNum(a, b) {
    const pa = String(a).match(/^(\d*)(.*)$/), pb = String(b).match(/^(\d*)(.*)$/);
    const na = pa[1] === "" ? Infinity : +pa[1], nb = pb[1] === "" ? Infinity : +pb[1];
    if (na !== nb) return na - nb;
    return pa[2] < pb[2] ? -1 : pa[2] > pb[2] ? 1 : 0;
  }

  /**
   * Parse a Bindarr collection export (tab-separated, header row first, one row per copy).
   * Returns { rows, errors, missingColumns }. rows: { set, num, name, setName, rarity, qty, foil, cardId, raw, line }.
   */
  function parseBindarrExport(text) {
    const lines = String(text || "").split(/\r?\n/);
    const head = (lines[0] || "").replace(/^﻿/, "").split("\t").map(function (h) { return h.trim(); });
    const col = {};
    head.forEach(function (h, i) { col[h] = i; });
    const missingColumns = ["Set ID", "Card Number", "Name", "Rarity", "Quantity", "Printing"].filter(function (c) { return !(c in col); });
    const out = { rows: [], errors: [], missingColumns: missingColumns };
    if (missingColumns.length) return out;
    for (let i = 1; i < lines.length; i++) {
      const raw = lines[i];
      if (!raw.trim()) continue;
      const f = raw.split("\t");
      const get = function (c) { return c in col ? (f[col[c]] || "").trim() : ""; };
      const qtyText = get("Quantity") || "1";
      const qty = /^\d{1,6}$/.test(qtyText) ? parseInt(qtyText, 10) : NaN;
      const set = get("Set ID").toLowerCase(), num = get("Card Number");
      if (!set || !num) { out.errors.push({ line: i + 1, raw: raw, reason: "No Set ID or Card Number" }); continue; }
      if (!(qty >= 1)) { out.errors.push({ line: i + 1, raw: raw, reason: "Quantity isn't a whole number of 1 or more" }); continue; }
      const printing = get("Printing");
      out.rows.push({
        set: set, num: num, name: get("Name"), setName: get("Set Name"), rarity: normRarity(get("Rarity")),
        qty: qty, foil: printing !== "" && printing.toLowerCase() !== "normal",
        cardId: get("Card ID").replace(/^mtg-/i, ""), raw: raw, line: i + 1
      });
    }
    return out;
  }

  /** Keep only what the report needs from a Scryfall card object. */
  function trimScryfallCard(c) {
    return {
      id: c.id, set: c.set, collector_number: c.collector_number, name: c.name, rarity: c.rarity,
      finishes: c.finishes || [], frame_effects: c.frame_effects || [], border_color: c.border_color || "",
      promo_types: c.promo_types || [], full_art: !!c.full_art
    };
  }

  const PROMO_LABELS = { serialized: "Serialized", promopack: "Promo pack", bundle: "Bundle", prerelease: "Prerelease",
    buyabox: "Buy-a-Box", datestamped: "Date-stamped", stamped: "Stamped", textured: "Textured foil",
    galaxyfoil: "Galaxy foil", surgefoil: "Surge foil", halofoil: "Halo foil", confettifoil: "Confetti foil",
    doublerainbow: "Double rainbow foil", gilded: "Gilded foil", neonink: "Neon ink", raisedfoil: "Raised foil",
    rainbowfoil: "Rainbow foil", ripplefoil: "Ripple foil", fracturefoil: "Fracture foil", manafoil: "Mana foil",
    silverfoil: "Silver foil", headliner: "Headliner" };

  const PROMO_IGNORE = ["boosterfun", "universesbeyond", "setpromo", "playtest"];

  /** Human label for a printing: "Borderless, Inverted frame, foil only", or "Regular". */
  function versionLabel(c) {
    const parts = [];
    const fe = c.frame_effects || [], pt = c.promo_types || [], fin = c.finishes || [];
    pt.forEach(function (p) {
      if (PROMO_IGNORE.indexOf(p) !== -1) return;
      parts.push(PROMO_LABELS[p] || p.charAt(0).toUpperCase() + p.slice(1));   // unknown types still show, e.g. "Silverscroll"
    });
    if (c.border_color === "borderless") parts.push("Borderless");
    if (fe.indexOf("extendedart") !== -1) parts.push("Extended art");
    if (fe.indexOf("showcase") !== -1) parts.push("Showcase");
    if (fe.indexOf("inverted") !== -1) parts.push("Inverted frame");
    if (fe.indexOf("etched") !== -1 || (fin.length === 1 && fin[0] === "etched")) parts.push("Etched");
    if (c.full_art && c.border_color !== "borderless") parts.push("Full art");
    const label = parts.length ? parts.join(", ") : "Regular";
    const foilOnly = fin.length && fin.indexOf("nonfoil") === -1;
    const nonfoilOnly = fin.length === 1 && fin[0] === "nonfoil";
    return label + (foilOnly ? " (foil only)" : nonfoilOnly ? " (nonfoil only)" : "");
  }

  /**
   * Build the completion report.
   *   parsed: parseBindarrExport() result
   *   cardsBySet: { setCode: [trimmed Scryfall cards] } for every Set ID in the export
   *   opts: { includeCommon }
   * Rarities reported: uncommon, rare, mythic, plus special and bonus when present; common only if asked.
   */
  function buildCompletion(parsed, cardsBySet, opts) {
    const includeCommon = !!(opts && opts.includeCommon);
    const wanted = function (r) { return r === "common" ? includeCommon : true; };
    const byKey = {}, byId = {};
    Object.keys(cardsBySet).forEach(function (code) {
      (cardsBySet[code] || []).forEach(function (c) {
        const k = printingKey(c.set, c.collector_number);
        byKey[k] = c;
        if (c.id) byId[c.id] = k;
      });
    });

    // Owned copies per printing, from the export.
    const owned = {}, unmatched = [];
    let copies = 0, foilCopies = 0;
    const exportPrintings = {}, exportSets = {}, setNames = {};
    parsed.rows.forEach(function (r) {
      copies += r.qty;
      if (r.foil) foilCopies += r.qty;
      exportPrintings[printingKey(r.set, r.num)] = true;
      exportSets[r.set] = true;
      if (r.setName && !setNames[r.set]) setNames[r.set] = r.setName;
      let k = printingKey(r.set, r.num);
      if (!byKey[k] && r.cardId && byId[r.cardId]) k = byId[r.cardId];   // fallback: Scryfall id
      if (!byKey[k]) { unmatched.push(r); return; }
      const o = owned[k] = owned[k] || { normal: 0, foil: 0 };
      if (r.foil) o.foil += r.qty; else o.normal += r.qty;
    });

    const sets = Object.keys(exportSets).map(function (code) {
      const cards = (cardsBySet[code] || []).filter(function (c) { return wanted(c.rarity); });
      const printings = cards.map(function (c) {
        const o = owned[printingKey(c.set, c.collector_number)] || { normal: 0, foil: 0 };
        return { set: c.set.toUpperCase(), num: c.collector_number, name: c.name, rarity: c.rarity,
          label: versionLabel(c), normal: o.normal, foil: o.foil, owned: o.normal + o.foil > 0 };
      }).sort(function (a, b) { return compareNum(a.num, b.num); });

      // By card: distinct name within the set and rarity; owned if any printing of it is.
      const cardMap = {};
      printings.forEach(function (p) {
        const k = p.rarity + "|" + p.name;
        const g = cardMap[k] = cardMap[k] || { set: p.set, num: p.num, name: p.name, rarity: p.rarity,
          versions: 0, versionsOwned: 0, normal: 0, foil: 0, owned: false, first: p };
        g.versions++; g.normal += p.normal; g.foil += p.foil;
        if (p.owned) { g.versionsOwned++; g.owned = true; }
      });
      const cardsList = Object.keys(cardMap).map(function (k) { return cardMap[k]; })
        .sort(function (a, b) { return compareNum(a.num, b.num); });

      const rarities = RARITY_ORDER.concat(printings.map(function (p) { return p.rarity; })
        .filter(function (r, i, a) { return RARITY_ORDER.indexOf(r) === -1 && a.indexOf(r) === i; }))
        .filter(function (r) { return printings.some(function (p) { return p.rarity === r; }); })
        .map(function (r) {
          const cs = cardsList.filter(function (c) { return c.rarity === r; });
          const ps = printings.filter(function (p) { return p.rarity === r; });
          return { rarity: r,
            byCard: tally(cs.length, cs.filter(function (c) { return c.owned; }).length),
            byPrinting: tally(ps.length, ps.filter(function (p) { return p.owned; }).length) };
        });
      const sum = function (f) { return rarities.reduce(function (a, x) { return a + x[f].inSet; }, 0); };
      const sumOwned = function (f) { return rarities.reduce(function (a, x) { return a + x[f].owned; }, 0); };
      return { code: code.toUpperCase(), name: setNames[code] || code.toUpperCase(), found: (cardsBySet[code] || []).length > 0,
        rarities: rarities, total: { byCard: tally(sum("byCard"), sumOwned("byCard")), byPrinting: tally(sum("byPrinting"), sumOwned("byPrinting")) },
        printings: printings, cards: cardsList };
    }).sort(function (a, b) { return a.name.localeCompare(b.name) || a.code.localeCompare(b.code); });

    const grand = function (f) {
      return tally(sets.reduce(function (a, s) { return a + s.total[f].inSet; }, 0), sets.reduce(function (a, s) { return a + s.total[f].owned; }, 0));
    };
    return {
      sets: sets, unmatched: unmatched, errors: parsed.errors,
      total: { byCard: grand("byCard"), byPrinting: grand("byPrinting") },
      totals: { copies: copies, foilCopies: foilCopies, printings: Object.keys(exportPrintings).length, sets: Object.keys(exportSets).length }
    };
  }

  function tally(inSet, owned) {
    return { inSet: inSet, owned: owned, missing: inSet - owned, pct: inSet ? owned / inSet : 0 };
  }

  /** Missing cards as Bindarr text lines. mode "card": one line per missing card (its lowest-numbered printing). */
  function missingLines(set, mode) {
    const list = mode === "card" ? set.cards.filter(function (c) { return !c.owned; }).map(function (c) { return c.first; })
      : set.printings.filter(function (p) { return !p.owned; });
    return list.map(function (p) { return "1 " + p.name + " (" + p.set + ") " + p.num; });
  }


  // ---- Blocks, cache freshness, CSV ----

  /** The top of a set's parent chain: TFRC -> FRC -> FRA. `parents` maps CODE -> parent CODE (upper-case). */
  function rootSet(code, parents) {
    let cur = String(code || "").toUpperCase(), depth = 0;
    while (parents && parents[cur] && depth < 5) { cur = parents[cur]; depth++; }
    return cur;
  }

  /** Group set codes into blocks by their root set: { FRA: ["FRA", "FRC", "TFRC"], ... }, in input order. */
  function groupBlocks(codes, parents) {
    const out = {};
    (codes || []).forEach(function (c) {
      const code = String(c).toUpperCase(), root = rootSet(code, parents);
      (out[root] = out[root] || []).push(code);
    });
    return out;
  }

  const CACHE_RULES = { minAgeMs: 24 * 3600 * 1000, maxAgeMs: 7 * 24 * 3600 * 1000 };

  /**
   * Should a cached set be downloaded again? entry: { fetchedAt (ms), cardCount } or null.
   * cardCountNow: Scryfall's current card_count for the set (from /sets), or null if unknown.
   * Never within 24 hours (Scryfall asks for at least that); always after 7 days; in between,
   * only when Scryfall's card count for the set has changed.
   */
  function needsRefresh(entry, cardCountNow, now) {
    if (!entry || !entry.fetchedAt) return true;
    const age = now - entry.fetchedAt;
    if (age < CACHE_RULES.minAgeMs) return false;
    if (age >= CACHE_RULES.maxAgeMs) return true;
    return cardCountNow != null && entry.cardCount != null && cardCountNow !== entry.cardCount;
  }

  function csvField(v) {
    const s = String(v == null ? "" : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  /** Missing cards as CSV (header row first). mode "card": one row per missing card, its lowest-numbered printing. */
  function missingCsv(sets, mode) {
    const rows = [["Set", "No.", "Name", "Rarity", "Version"]];
    sets.forEach(function (s) {
      const list = mode === "card" ? s.cards.filter(function (c) { return !c.owned; }).map(function (c) { return c.first; })
        : s.printings.filter(function (p) { return !p.owned; });
      list.forEach(function (p) { rows.push([p.set, p.num, p.name, p.rarity, p.label]); });
    });
    return rows.map(function (r) { return r.map(csvField).join(","); }).join("\r\n");
  }

  const api = { RARITY_ORDER: RARITY_ORDER, EXPORT_LIMITS: EXPORT_LIMITS, CACHE_RULES: CACHE_RULES,
    normRarity: normRarity, compareNum: compareNum, parseBindarrExport: parseBindarrExport,
    trimScryfallCard: trimScryfallCard, versionLabel: versionLabel, buildCompletion: buildCompletion,
    missingLines: missingLines, missingCsv: missingCsv, rootSet: rootSet, groupBlocks: groupBlocks, needsRefresh: needsRefresh };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.BindarrCompletion = api;
})(this);
