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
  const TIMEOUT_MS = 20000;   // give up on a Scryfall request after 20 s
  const MAX_FUZZY = 200;      // one-at-a-time fuzzy lookups per run

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

  // fetch() with a timeout, so a stalled request can't hang the page.
  async function fetchTimed(url, opts) {
    const ctl = new AbortController();
    const timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
    try {
      return await fetch(url, Object.assign({}, opts, { signal: ctl.signal }));
    } catch (e) {
      if (e.name === "AbortError") throw new Error("Scryfall didn't answer within " + TIMEOUT_MS / 1000 + " seconds");
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
  async function scryCollection(ids) {
    const res = await fetchTimed("https://api.scryfall.com/cards/collection", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify({ identifiers: ids })
    });
    if (!res.ok) throw new Error("Scryfall answered " + res.status);
    return res.json();
  }
  async function scryFuzzy(name) {
    const res = await fetchTimed("https://api.scryfall.com/cards/named?fuzzy=" + encodeURIComponent(name), { headers: { "Accept": "application/json" } });
    return res.ok ? res.json() : null;
  }
  // ---- Set autocomplete (Default set, Set code fixes) ----
  // Scryfall's full set list, fetched once on first use and kept in memory for the page's lifetime.
  let setsPromise = null;
  function loadSets() {
    if (!setsPromise) {
      setsPromise = fetchTimed("https://api.scryfall.com/sets", { headers: { "Accept": "application/json" } })
        .then(function (res) { if (!res.ok) throw new Error("Scryfall answered " + res.status); return res.json(); })
        .then(function (j) {
          return (j.data || []).map(function (s) { return { code: s.code.toUpperCase(), name: s.name, released: s.released_at || "" }; });
        })
        .catch(function () { setsPromise = null; return []; });   // no suggestions; typing still works, retry next time
    }
    return setsPromise;
  }

  /**
   * Attach a set dropdown to an input. mode "whole": the field holds one set code.
   * mode "token": the field holds "A=B, C=D" pairs; only the entry under the caret is completed.
   */
  function attachSetAutocomplete(input, mode) {
    const list = document.createElement("ul");
    list.id = input.id + "-list";
    list.className = "ac-list";
    list.setAttribute("role", "listbox");
    list.hidden = true;
    input.parentNode.appendChild(list);
    input.setAttribute("role", "combobox");
    input.setAttribute("aria-autocomplete", "list");
    input.setAttribute("aria-controls", list.id);
    input.setAttribute("aria-expanded", "false");

    let items = [], active = -1, closeTimer = null;

    function query() {
      return mode === "token" ? C.tokenAt(input.value, input.selectionStart).text : input.value;
    }
    function close() {
      list.hidden = true; items = []; active = -1;
      input.setAttribute("aria-expanded", "false");
      input.removeAttribute("aria-activedescendant");
    }
    function highlight(i) {
      active = i;
      Array.prototype.forEach.call(list.children, function (li, k) { li.setAttribute("aria-selected", k === i ? "true" : "false"); });
      if (i >= 0) { input.setAttribute("aria-activedescendant", list.children[i].id); list.children[i].scrollIntoView({ block: "nearest" }); }
      else input.removeAttribute("aria-activedescendant");
    }
    function pick(i) {
      const s = items[i];
      if (!s) return;
      if (mode === "token") {
        const t = C.tokenAt(input.value, input.selectionStart);
        input.value = input.value.slice(0, t.start) + s.code + input.value.slice(t.end);
        const caret = t.start + s.code.length;
        input.setSelectionRange(caret, caret);
      } else {
        input.value = s.code;
      }
      close();
    }
    async function update() {
      const q = query();
      if (!q.trim()) { close(); return; }
      const sets = await loadSets();
      if (q !== query()) return;   // the user kept typing while the list loaded
      items = C.matchSets(sets, q, 12);
      if (!items.length) { close(); return; }
      list.textContent = "";
      items.forEach(function (s, k) {
        const li = document.createElement("li");
        li.id = list.id + "-" + k;
        li.setAttribute("role", "option");
        const code = document.createElement("b");
        code.textContent = s.code;
        const name = document.createElement("span");
        name.textContent = s.name + (s.released ? " · " + s.released.slice(0, 4) : "");
        li.appendChild(code); li.appendChild(name);
        li.addEventListener("mousedown", function (e) { e.preventDefault(); });   // keep focus in the input
        li.addEventListener("click", function () { pick(k); input.focus(); });
        list.appendChild(li);
      });
      list.hidden = false;
      input.setAttribute("aria-expanded", "true");
      highlight(-1);
    }

    input.addEventListener("input", update);
    input.addEventListener("focus", function () { loadSets(); });
    input.addEventListener("blur", function () { closeTimer = setTimeout(close, 150); });
    input.addEventListener("keydown", function (e) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (list.hidden) { update(); return; }
        e.preventDefault();
        const n = items.length;
        highlight(e.key === "ArrowDown" ? (active + 1) % n : (active <= 0 ? n - 1 : active - 1));
      } else if (e.key === "Enter" && !list.hidden && active >= 0) {
        e.preventDefault(); pick(active);
      } else if (e.key === "Escape" && !list.hidden) {
        e.preventDefault(); close();
      }
    });
    input.addEventListener("focus", function () { clearTimeout(closeTimer); });
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
    const text = $("input").value;
    const tooBig = C.checkInput(text);
    if (tooBig) { setStatus(tooBig); return; }
    const parsed = text.split(/\r?\n/).map(C.parseLine).filter(Boolean);
    skipped = parsed.filter(function (p) { return p.skip; });
    rows = parsed.filter(function (p) { return !p.skip; }).map(function (p) {
      // Lines that break a limit become red rows, so they're visible but never looked up or exported.
      if (p.error) return { qty: 0, name: p.raw, set: "", num: "", foil: false, raw: p.raw, status: "bad", note: p.error, _card: null, _invalid: true };
      return Object.assign({}, p, { wantSet: p.set ? (map[p.set] || p.set) : defSet, status: "idle", note: "" });
    });
    const valid = rows.filter(function (r) { return !r._invalid; });

    if (!useScryfall) {
      valid.forEach(function (r) {
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
      await resolvePass(valid, function (r) { return C.identifierFor(r, defSet, map); });
      valid.forEach(function (r) {
        if (r._card) applyCard(r, "ok", r.src === "tcgplayer" && r.variant ? "TCGplayer variant: " + r.variant : "");
      });

      // Pass 2: number not found -> same set, by name.
      let left = valid.filter(function (r) { return !r._card && r.wantSet && r.num; });
      if (left.length) {
        await sleep(COLLECTION_GAP_MS);
        await resolvePass(left, function (r) { return { name: r.name, set: r.wantSet.toLowerCase() }; });
        left.forEach(function (r) { if (r._card) applyCard(r, "warn", "Number " + r.num + " not found in " + r.wantSet + "; matched by name"); });
      }

      // Pass 3: not in that set -> Scryfall's default printing.
      left = valid.filter(function (r) { return !r._card; });
      if (left.length) {
        await sleep(COLLECTION_GAP_MS);
        await resolvePass(left, function (r) { return { name: r.name }; });
        left.forEach(function (r) {
          if (r._card) applyCard(r, "warn", "Not in " + (r.wantSet || "any given set") + "; used Scryfall's default printing (" + r._card.set.toUpperCase() + ")");
        });
      }

      // Pass 4: typos and partial names -> fuzzy, one at a time.
      left = valid.filter(function (r) { return !r._card; });
      left.slice(MAX_FUZZY).forEach(function (r) {
        r.status = "bad"; r.note = "Not found; skipped the name-correction lookup (limit " + MAX_FUZZY + " per run). Add by hand.";
      });
      for (const r of left.slice(0, MAX_FUZZY)) {
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

  // What the table shows. A repeated printing is flagged Check on top of whatever the lookup found;
  // the flag is recomputed on every render, so it clears once the Foil ticks differ.
  function applyDuplicateFlags() {
    const dup = C.duplicatePrintings(rows);
    rows.forEach(function (r, i) {
      r.shown = { status: r.status, note: r.note };
      if (dup[i] && r.status !== "bad") {
        const why = "Same printing on " + dup[i].lines + " lines, all marked " + (r.foil ? "foil" : "non-foil") +
          ". TCGplayer doesn't mark foils: if one copy is foil, tick Foil on that line.";
        r.shown = { status: "warn", note: why + (r.note && r.note !== "Not checked" ? " " + r.note : "") };
      }
    });
  }

  function render() {
    applyDuplicateFlags();
    // Lines with the same printing sit next to each other, so the foil copy is easy to find and tick.
    const view = C.reviewOrder(rows);
    $("rows").innerHTML = view.order.map(function (i) {
      const r = rows[i];
      return "<tr" + (view.grouped[i] ? " class=\"same-printing\"" : "") + ">" +
        "<td class=\"num\">" + r.qty + "</td>" +
        "<td>" + esc(r.name) + "</td>" +
        "<td class=\"mono\">" + esc(r.set || "—") + " · " + esc(r.num || "—") + "</td>" +
        "<td><input type=\"checkbox\" id=\"foil-" + i + "\" data-i=\"" + i + "\"" + (r.foil ? " checked" : "") + " aria-label=\"Foil: " + esc(r.name) + "\"></td>" +
        "<td><span class=\"pill " + r.shown.status + "\">" + LABEL[r.shown.status] + "</span></td>" +
        "<td class=\"note\">" + esc(r.shown.note) + "</td>" +
        "<td class=\"src\">" + esc(r.raw) + "</td>" +
        "</tr>";
    }).join("");
    $("rows").querySelectorAll("input[type=checkbox]").forEach(function (cb) {
      cb.addEventListener("change", function (e) {
        const i = +e.target.dataset.i;
        rows[i].foil = e.target.checked;
        render();                       // re-check repeated printings with the new foil tick
        $("foil-" + i).focus();
      });
    });
    writeOutput();
    summarize();
  }

  function summarize() {
    const sum = function (pred) { return rows.filter(pred).reduce(function (a, r) { return a + r.qty; }, 0); };
    const by = function (s) { return sum(function (r) { return r.shown.status === s; }); };
    const parts = ["<span class=\"pill idle\">" + rows.length + " lines · " + sum(function () { return true; }) + " cards</span>"];
    if (by("ok")) parts.push("<span class=\"pill ok\">" + by("ok") + " matched</span>");
    if (by("warn")) parts.push("<span class=\"pill warn\">" + by("warn") + " to check</span>");
    if (by("bad")) parts.push("<span class=\"pill bad\">" + by("bad") + " missing</span>");
    const rejected = rows.filter(function (r) { return r._invalid; }).length;
    if (rejected) parts.push("<span class=\"pill bad\">" + rejected + (rejected === 1 ? " line" : " lines") + " rejected</span>");
    if (by("idle")) parts.push("<span class=\"pill idle\">" + by("idle") + " unchecked</span>");
    parts.push("<span class=\"pill idle\">" + sum(function (r) { return r.foil; }) + " foil</span>");
    if (skipped.length) parts.push("<span class=\"pill idle\" title=\"" + esc(skipped.map(function (s) { return s.raw; }).join(" | ")) + "\">" + skipped.length + " header lines skipped</span>");
    $("summary").innerHTML = parts.join("");
  }

  function writeOutput() {
    $("output").value = rows.filter(function (r) { return r.status !== "bad" && r.set && r.num; }).map(C.formatLine).join("\n");
  }

  // Save the output as a .txt file. Chrome and Edge open a real "Save as" dialog;
  // other browsers (and pages without the File System Access API) download it instead.
  async function saveTxt() {
    const text = $("output").value;
    const status = $("copystatus");
    if (!text) { status.textContent = "Nothing to save yet. Press Convert first."; return; }
    const body = text + "\n";
    const fileName = "bindarr-import-" + new Date().toISOString().slice(0, 10) + ".txt";
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const handle = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: "Text file", accept: { "text/plain": [".txt"] } }] });
        const w = await handle.createWritable();
        await w.write(body);
        await w.close();
        status.textContent = "Saved " + handle.name + ".";
        return;
      } catch (e) {
        if (e.name === "AbortError") return;   // user cancelled the dialog
        // Anything else (e.g. blocked in an iframe): fall through to a plain download.
      }
    }
    const url = URL.createObjectURL(new Blob([body], { type: "text/plain;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    status.textContent = "Downloaded " + fileName + ".";
  }

  attachSetAutocomplete($("defset"), "whole");
  attachSetAutocomplete($("setmap"), "token");
  $("save").addEventListener("click", saveTxt);
  $("go").addEventListener("click", function () { convert($("usescry").checked); });
  $("copy").addEventListener("click", async function () {
    const ta = $("output");
    try { await navigator.clipboard.writeText(ta.value); $("copystatus").textContent = "Copied."; }
    catch (e) { ta.focus(); ta.select(); $("copystatus").textContent = "Selected. Press Ctrl+C to copy."; }
  });

  $("input").value = SAMPLE;
  convert(false).then(function () { setStatus("Sample converted without Scryfall. Paste your list and press Convert."); });
})();
