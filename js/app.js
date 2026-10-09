/* Bindarr Import Companion — page logic and Scryfall lookups. Needs js/core.js loaded first. */
(function () {
  "use strict";
  const C = window.BindarrCore;
  const $ = function (id) { return document.getElementById(id); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  // Scryfall asks for <= 2 requests/second on /cards/collection and ~10/second elsewhere.
  const COLLECTION_GAP_MS = 550;
  const NAMED_GAP_MS = 120;
  const BATCH = 75;

  const SAMPLE = [
    "2 Tranquil Cove [DFT] 267",
    "2 Zahur, Glory's Past (Borderless) [DFT] 370",
    "1 Forest (0289) [DFT] 289",
    "1 Spell Pierce [DFT] 64",
    "1 Spell Pierce [DFT] 64",
    "1 Skyseer's Chariot [PRE] 28",
    "1 Burnout Bashtronaut (First-Place Foil) [DFT] 455"
  ].join("\n");

  let rows = [];
  let skipped = [];

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function setStatus(text) { $("status").textContent = text; }

  async function scryCollection(ids) {
    const res = await fetch("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ identifiers: ids })
    });
    if (!res.ok) throw new Error("Scryfall answered " + res.status);
    return res.json();
  }
  async function scryFuzzy(name) {
    const res = await fetch("https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(name), { headers: { "Accept": "application/json" } });
    return res.ok ? res.json() : null;
  }
  async function resolvePass(list, idFn) {
    for (let i = 0; i < list.length; i += BATCH) {
      const chunk = list.slice(i, i + BATCH);
      const ids = chunk.map(idFn);
      setStatus("Checking Scryfall… " + Math.min(i + BATCH, list.length) + " of " + list.length);
      const data = await scryCollection(ids);
      chunk.forEach(function (r, k) {
        const card = (data.data || []).find(function (c) { return C.cardMatches(c, ids[k]); });
        if (card) r._card = card;
      });
      if (i + BATCH < list.length) await sleep(COLLECTION_GAP_MS);
    }
  }
  function applyCard(r, status, note) {
    const c = r._card;
    r.name = c.name; r.set = c.set.toUpperCase(); r.num = c.collector_number;
    r.status = status; r.note = note || "";
  }

  async function convert(useScryfall) {
    const defSet = $("defset").value.trim().toUpperCase();
    const map = C.parseSetMap($("setmap").value);
    const parsed = $("input").value.split(/\r?\n/).map(C.parseLine).filter(Boolean);
    skipped = parsed.filter(function (p) { return p.skip; });
    rows = parsed.filter(function (p) { return !p.skip; }).map(function (p) {
      return Object.assign({}, p, { wantSet: p.set ? (map[p.set] || p.set) : defSet, status: "idle", note: "" });
    });

    if (!useScryfall) {
      rows.forEach(function (r) {
        r.set = r.wantSet;
        if (!r.set || !r.num) { r.status = "bad"; r.note = "Needs a set and number. Turn on the Scryfall check."; }
        else { r.note = "Not checked"; }
      });
      render();
      return;
    }

    $("go").disabled = true;
    try {
      // Pass 1: exactly what the line asked for (set + number, or name in the given set).
      await resolvePass(rows, function (r) { return C.identifierFor(r, defSet, map); });
      rows.forEach(function (r) {
        if (r._card) applyCard(r, "ok", r.src === "tcgplayer" && r.variant ? "TCGplayer variant: " + r.variant : "");
      });

      // Pass 2: number not found -> same set, by name.
      let left = rows.filter(function (r) { return !r._card && r.wantSet && r.num; });
      if (left.length) {
        await sleep(COLLECTION_GAP_MS);
        await resolvePass(left, function (r) { return { name: r.name, set: r.wantSet.toLowerCase() }; });
        left.forEach(function (r) { if (r._card) applyCard(r, "warn", "Number " + r.num + " not found in " + r.wantSet + "; matched by name"); });
      }

      // Pass 3: not in that set -> Scryfall's default printing.
      left = rows.filter(function (r) { return !r._card; });
      if (left.length) {
        await sleep(COLLECTION_GAP_MS);
        await resolvePass(left, function (r) { return { name: r.name }; });
        left.forEach(function (r) {
          if (r._card) applyCard(r, "warn", "Not in " + (r.wantSet || "any given set") + "; used Scryfall's default printing (" + r._card.set.toUpperCase() + ")");
        });
      }

      // Pass 4: typos and partial names -> fuzzy, one at a time.
      left = rows.filter(function (r) { return !r._card; });
      for (const r of left) {
        setStatus("Fuzzy lookup: " + r.name);
        await sleep(NAMED_GAP_MS);
        const c = await scryFuzzy(r.name);
        if (c) { const was = r.name; r._card = c; applyCard(r, "warn", "Name corrected from \"" + was + "\" (fuzzy match)"); }
        else { r.status = "bad"; r.note = "Not found on Scryfall. Add by hand."; }
      }
      setStatus("Done.");
    } catch (e) {
      setStatus(e.message + ". Check your internet connection, or turn off the Scryfall check to convert the format only.");
    } finally {
      $("go").disabled = false;
    }
    render();
  }

  const LABEL = { ok: "Matched", warn: "Check", bad: "Missing", idle: "Unchecked" };

  function render() {
    $("rows").innerHTML = rows.map(function (r, i) {
      return "<tr>" +
        "<td class=\"num\">" + r.qty + "</td>" +
        "<td>" + esc(r.name) + "</td>" +
        "<td class=\"mono\">" + esc(r.set || "—") + " · " + esc(r.num || "—") + "</td>" +
        "<td><input type=\"checkbox\" id=\"foil-" + i + "\" data-i=\"" + i + "\"" + (r.foil ? " checked" : "") + " aria-label=\"Foil: " + esc(r.name) + "\"></td>" +
        "<td><span class=\"pill " + r.status + "\">" + LABEL[r.status] + "</span></td>" +
        "<td class=\"note\">" + esc(r.note) + "</td>" +
        "<td class=\"src\">" + esc(r.raw) + "</td>" +
        "</tr>";
    }).join("");
    $("rows").querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      cb.addEventListener("change", function (e) { rows[+e.target.dataset.i].foil = e.target.checked; writeOutput(); summarize(); });
    });
    writeOutput();
    summarize();
  }

  function summarize() {
    const sum = function (pred) { return rows.filter(pred).reduce(function (a, r) { return a + r.qty; }, 0); };
    const by = function (s) { return sum(function (r) { return r.status === s; }); };
    const parts = ["<span class=\"pill idle\">" + rows.length + " lines · " + sum(function () { return true; }) + " cards</span>"];
    if (by("ok")) parts.push("<span class=\"pill ok\">" + by("ok") + " matched</span>");
    if (by("warn")) parts.push("<span class=\"pill warn\">" + by("warn") + " to check</span>");
    if (by("bad")) parts.push("<span class=\"pill bad\">" + by("bad") + " missing</span>");
    if (by("idle")) parts.push("<span class=\"pill idle\">" + by("idle") + " unchecked</span>");
    parts.push("<span class=\"pill idle\">" + sum(function (r) { return r.foil; }) + " foil</span>");
    if (skipped.length) parts.push("<span class=\"pill idle\" title=\"" + esc(skipped.map(function (s) { return s.raw; }).join(" | ")) + "\">" + skipped.length + " header lines skipped</span>");
    $("summary").innerHTML = parts.join("");
  }

  function writeOutput() {
    $("output").value = rows.filter(function (r) { return r.status !== "bad" && r.set && r.num; }).map(C.formatLine).join("\n");
  }

  $("go").addEventListener("click", function () { convert($("usescry").checked); });
  $("copy").addEventListener("click", async function () {
    const ta = $("output");
    try { await navigator.clipboard.writeText(ta.value); $("copystatus").textContent = "Copied."; }
    catch (e) { ta.focus(); ta.select(); $("copystatus").textContent = "Selected. Press Ctrl+C to copy."; }
  });

  $("input").value = SAMPLE;
  convert(false).then(function () { setStatus("Sample converted without Scryfall. Paste your list and press Convert."); });
})();
