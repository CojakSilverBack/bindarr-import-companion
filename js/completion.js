/* Bindarr Import Companion — set completion page. Needs js/completion-core.js loaded first. */
(function () {
  "use strict";
  const C = window.BindarrCompletion;
  const $ = function (id) { return document.getElementById(id); };
  const sleep = function (ms) { return new Promise(function (r) { setTimeout(r, ms); }); };

  const TIMEOUT_MS = 20000;    // give up on a Scryfall request after 20 s
  const SEARCH_GAP_MS = 120;   // between Scryfall requests (Scryfall asks for 50-100 ms)
  const BLOCKS_WITHOUT_ASKING = 2;
  const PAGE_SIZE = 175;       // cards per Scryfall search page

  let report = null, reportInput = null, running = null;
  const sources = {};          // set code -> { from: "cache" | "scryfall" | "digital", fetchedAt }
  const openSets = {};         // which set sections are expanded

  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; });
  }
  function setStatus(t) { $("reportStatus").textContent = t; }

  // fetch() with a timeout and an optional outside abort (the Cancel button).
  async function fetchTimed(url, signal) {
    const ctl = new AbortController();
    const timer = setTimeout(function () { ctl.abort(); }, TIMEOUT_MS);
    const stop = function () { ctl.abort(); };
    if (signal) signal.addEventListener("abort", stop);
    try {
      return await fetch(url, { headers: { "Accept": "application/json" }, signal: ctl.signal });
    } catch (e) {
      if (signal && signal.aborted) throw new Error("Cancelled");
      if (e.name === "AbortError") throw new Error("Scryfall didn't answer within " + TIMEOUT_MS / 1000 + " seconds");
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", stop);
    }
  }
  function tooManyRequests() {
    return new Error("Scryfall asked us to slow down (429). Wait a minute, then try again");
  }

  // ---- Saved set data (IndexedDB, in this browser only) ----
  // One record per set: { code, cards, fetchedAt, cardCount }. If the browser blocks storage
  // (private windows, some settings), everything still works; sets just download each time.
  let dbPromise = null;
  function openDb() {
    if (!dbPromise) {
      dbPromise = new Promise(function (resolve) {
        try {
          const req = indexedDB.open("bindarr-companion", 1);
          req.onupgradeneeded = function () { req.result.createObjectStore("sets", { keyPath: "code" }); };
          req.onsuccess = function () { resolve(req.result); };
          req.onerror = function () { resolve(null); };
        } catch (e) { resolve(null); }
      });
    }
    return dbPromise;
  }
  async function dbRun(mode, fn) {
    const db = await openDb();
    if (!db) return null;
    return new Promise(function (resolve) {
      try {
        const tx = db.transaction("sets", mode);
        const req = fn(tx.objectStore("sets"));
        tx.oncomplete = function () { resolve(req ? req.result : null); };
        tx.onerror = tx.onabort = function () { resolve(null); };
      } catch (e) { resolve(null); }
    });
  }
  function cacheGet(code) { return dbRun("readonly", function (s) { return s.get(code); }); }
  function cachePut(entry) { return dbRun("readwrite", function (s) { s.put(entry); return null; }); }
  function cacheClear() { return dbRun("readwrite", function (s) { s.clear(); return null; }); }

  // ---- Scryfall ----
  let setIndexPromise = null;
  // Scryfall's set list (one request per page load): code -> { name, parent, cardCount, digital }.
  function loadSetIndex(signal) {
    if (!setIndexPromise) {
      setIndexPromise = fetchTimed("https://api.scryfall.com/sets", signal).then(function (res) {
        if (res.status === 429) throw tooManyRequests();
        if (!res.ok) throw new Error("Scryfall answered " + res.status + " for the set list");
        return res.json();
      }).then(function (j) {
        const idx = {};
        (j.data || []).forEach(function (s) {
          idx[s.code.toUpperCase()] = { name: s.name, parent: (s.parent_set_code || "").toUpperCase(), cardCount: s.card_count, digital: !!s.digital };
        });
        return idx;
      }).catch(function (e) { setIndexPromise = null; throw e; });
    }
    return setIndexPromise;
  }

  async function downloadSet(code, signal, onPage) {
    let url = "https://api.scryfall.com/cards/search?q=" + encodeURIComponent("set:" + code.toLowerCase() + " game:paper") + "&unique=prints&order=set";
    const cards = [];
    let page = 0;
    while (url) {
      page++;
      onPage(page);
      const res = await fetchTimed(url, signal);
      if (res.status === 404) break;             // no paper cards with that code
      if (res.status === 429) throw tooManyRequests();
      if (!res.ok) throw new Error("Scryfall answered " + res.status + " for set " + code);
      const j = await res.json();
      (j.data || []).forEach(function (c) { cards.push(C.trimScryfallCard(c)); });
      url = j.has_more ? j.next_page : null;
      await sleep(SEARCH_GAP_MS);
    }
    return cards;
  }

  function sourceNote(code) {
    const s = sources[code];
    if (!s) return "";
    if (s.from === "digital") return "Digital-only set, no paper cards";
    const when = new Date(s.fetchedAt).toLocaleDateString();
    return s.from === "cache" ? "Saved data from " + when : "Downloaded from Scryfall " + when;
  }

  // ---- Build ----
  async function buildReport() {
    if (running) return;
    const text = $("exportInput").value;
    if (text.length > C.EXPORT_LIMITS.maxChars || text.split("\n").length > C.EXPORT_LIMITS.maxLines) {
      setStatus("The export is over " + C.EXPORT_LIMITS.maxLines.toLocaleString("en-US") + " lines. Filter it by set or rarity in Bindarr first.");
      return;
    }
    const parsed = C.parseBindarrExport(text);
    if (parsed.missingColumns.length) {
      setStatus("That doesn't look like a Bindarr export. Missing columns: " + parsed.missingColumns.join(", ") + ".");
      return;
    }
    const codes = parsed.rows.map(function (r) { return r.set.toUpperCase(); }).filter(function (c, i, a) { return a.indexOf(c) === i; });
    if (!codes.length) { setStatus("No card rows found in the export."); return; }
    if (codes.length > C.EXPORT_LIMITS.maxSets) {
      setStatus("The export covers " + codes.length + " sets; the limit is " + C.EXPORT_LIMITS.maxSets + ". Filter it by set in Bindarr first.");
      return;
    }

    running = new AbortController();
    const signal = running.signal;
    $("buildReport").disabled = true;
    $("cancelReport").hidden = false;
    try {
      setStatus("Loading Scryfall's set list…");
      const index = await loadSetIndex(signal);
      const force = $("forceRefresh").checked;
      const now = Date.now();

      // Work out what has to be downloaded, and ask first if the export spans many blocks.
      const plan = [];
      for (const code of codes) {
        const info = index[code] || null;
        if (info && info.digital) { plan.push({ code: code, digital: true }); continue; }
        const entry = await cacheGet(code);
        const download = force || C.needsRefresh(entry, info ? info.cardCount : null, now);
        plan.push({ code: code, info: info, entry: entry, download: download });
      }
      const parents = {};
      Object.keys(index).forEach(function (k) { if (index[k].parent) parents[k] = index[k].parent; });
      const blocks = Object.keys(C.groupBlocks(codes, parents));
      const requests = plan.filter(function (p) { return p.download; }).reduce(function (n, p) {
        return n + Math.max(1, Math.ceil(((p.info && p.info.cardCount) || PAGE_SIZE) / PAGE_SIZE));
      }, 0);
      if (blocks.length > BLOCKS_WITHOUT_ASKING && requests > 0) {
        const ok = await confirmInline("This export covers " + blocks.length + " blocks (" + codes.length + " sets: " + codes.join(", ") +
          "). Building the report takes about " + requests + " Scryfall " + (requests === 1 ? "request" : "requests") + "; saved sets aren't downloaded again. Continue?");
        if (!ok) { setStatus("Cancelled. Filter the export to one or two blocks in Bindarr for a quicker report."); return; }
      }

      const bySet = {};
      let n = 0;
      for (const p of plan) {
        n++;
        const key = p.code.toLowerCase();
        if (p.digital) { bySet[key] = []; sources[p.code] = { from: "digital" }; continue; }
        if (!p.download) { bySet[key] = p.entry.cards; sources[p.code] = { from: "cache", fetchedAt: p.entry.fetchedAt }; continue; }
        try {
          const cards = await downloadSet(p.code, signal, function (page) {
            setStatus("Downloading " + p.code + " from Scryfall (set " + n + " of " + plan.length + ", page " + page + ")…");
          });
          const entry = { code: p.code, cards: cards, fetchedAt: Date.now(), cardCount: p.info ? p.info.cardCount : null };
          await cachePut(entry);
          bySet[key] = cards;
          sources[p.code] = { from: "scryfall", fetchedAt: entry.fetchedAt };
        } catch (e) {
          if (!p.entry || signal.aborted) throw e;
          // Scryfall failed but there's an older saved copy: use it rather than stopping.
          bySet[key] = p.entry.cards;
          sources[p.code] = { from: "cache", fetchedAt: p.entry.fetchedAt };
        }
      }
      reportInput = { parsed: parsed, bySet: bySet };
      report = C.buildCompletion(parsed, bySet, { includeCommon: $("incCommon").checked });
      setStatus("Done.");
      renderReport();
    } catch (e) {
      setStatus(e.message + ".");
    } finally {
      running = null;
      $("buildReport").disabled = false;
      $("cancelReport").hidden = true;
    }
  }

  // A yes/no question shown in the page (no pop-up), resolved by its two buttons.
  function confirmInline(message) {
    return new Promise(function (resolve) {
      $("confirmText").textContent = message;
      $("confirmBox").hidden = false;
      $("confirmYes").focus();
      const done = function (answer) {
        $("confirmBox").hidden = true;
        $("confirmYes").onclick = $("confirmNo").onclick = null;
        resolve(answer);
      };
      $("confirmYes").onclick = function () { done(true); };
      $("confirmNo").onclick = function () { done(false); };
      if (running) running.signal.addEventListener("abort", function () { done(false); });
    });
  }

  // ---- Report ----
  function pct(t) { return t.inSet ? Math.round(t.pct * 1000) / 10 + "%" : "—"; }
  function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }
  function tallyCells(t) { return "<td class=\"num\">" + t.inSet + "</td><td class=\"num\">" + t.owned + "</td><td class=\"num\">" + t.missing + "</td><td class=\"num\">" + pct(t) + "</td>"; }
  function tallyTable(set, field) {
    return "<div class=\"tablewrap\"><table class=\"rp\"><thead><tr><th>Rarity</th><th class=\"num\">In set</th><th class=\"num\">Owned</th><th class=\"num\">Missing</th><th class=\"num\">% complete</th></tr></thead><tbody>" +
      set.rarities.map(function (r) { return "<tr><td>" + esc(cap(r.rarity)) + "</td>" + tallyCells(r[field]) + "</tr>"; }).join("") +
      "<tr class=\"tot\"><td>Set total</td>" + tallyCells(set.total[field]) + "</tr></tbody></table></div>";
  }

  function renderReport() {
    if (!report) return;
    const mode = $("rpMode").value, missingOnly = $("rpMissing").checked;
    const t = report.totals;
    let html = "";

    html += "<h3>Across all sets</h3><div class=\"tablewrap\"><table class=\"rp\"><thead><tr><th>Set</th>" +
      "<th class=\"num\">Cards in set</th><th class=\"num\">Owned</th><th class=\"num\">Missing</th><th class=\"num\">%</th>" +
      "<th class=\"num\">Printings in set</th><th class=\"num\">Owned</th><th class=\"num\">Missing</th><th class=\"num\">%</th></tr></thead><tbody>" +
      report.sets.map(function (s) {
        return "<tr><td>" + esc(s.name) + " <span class=\"mono\">" + esc(s.code) + "</span></td>" + tallyCells(s.total.byCard) + tallyCells(s.total.byPrinting) + "</tr>";
      }).join("") +
      "<tr class=\"tot\"><td>Total</td>" + tallyCells(report.total.byCard) + tallyCells(report.total.byPrinting) + "</tr></tbody></table></div>";

    html += "<h3>Reconciliation</h3><div class=\"summary\">" +
      "<span class=\"pill idle\">" + t.copies + " copies</span><span class=\"pill idle\">" + t.foilCopies + " foil copies</span>" +
      "<span class=\"pill idle\">" + t.printings + " distinct printings</span><span class=\"pill idle\">" + t.sets + (t.sets === 1 ? " set" : " sets") + "</span>" +
      (report.unmatched.length ? "<span class=\"pill bad\">" + report.unmatched.length + (report.unmatched.length === 1 ? " row" : " rows") + " didn't match</span>" : "<span class=\"pill ok\">every row matched</span>") +
      (report.errors.length ? "<span class=\"pill bad\">" + report.errors.length + (report.errors.length === 1 ? " row" : " rows") + " couldn't be read</span>" : "") + "</div>";
    const odd = report.unmatched.map(function (r) { return { line: r.line, raw: r.raw, reason: "Set ID + Card Number not found on Scryfall" }; }).concat(report.errors);
    if (odd.length) {
      html += "<div class=\"tablewrap\"><table class=\"rp\"><thead><tr><th class=\"num\">Line</th><th>Why</th><th>Original line</th></tr></thead><tbody>" +
        odd.sort(function (a, b) { return a.line - b.line; }).map(function (o) {
          return "<tr><td class=\"num\">" + o.line + "</td><td class=\"note\">" + esc(o.reason) + "</td><td class=\"src\">" + esc(o.raw) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }

    html += report.sets.map(function (s) {
      const list = mode === "card" ? s.cards : s.printings;
      const shown = list.filter(function (x) { return !missingOnly || !x.owned; });
      const rowsHtml = shown.map(function (x) {
        const version = mode === "card" ? x.versionsOwned + " of " + x.versions + " versions" : x.label;
        return "<tr><td class=\"num mono\">" + esc(x.num) + "</td><td>" + esc(x.name) + "</td><td>" + esc(cap(x.rarity)) + "</td><td class=\"note\">" + esc(version) +
          "</td><td class=\"num\">" + x.normal + "</td><td class=\"num\">" + x.foil + "</td><td><span class=\"pill " + (x.owned ? "ok\">Owned" : "bad\">Missing") + "</span></td></tr>";
      }).join("");
      return "<details class=\"rpset\" data-code=\"" + esc(s.code) + "\"" + (openSets[s.code] ? " open" : "") + "><summary>" + esc(s.name) + " <span class=\"mono\">" + esc(s.code) + "</span> · " +
        pct(s.total.byCard) + " of cards, " + pct(s.total.byPrinting) + " of printings" + (s.found ? "" : " · <b>no paper cards on Scryfall</b>") +
        "<span class=\"asof\">" + esc(sourceNote(s.code)) + "</span></summary>" +
        "<div class=\"rpgrid\"><div><h4>By card (any version counts)</h4>" + tallyTable(s, "byCard") + "</div>" +
        "<div><h4>By printing</h4>" + tallyTable(s, "byPrinting") + "</div></div>" +
        "<div class=\"tablewrap\"><table class=\"rp\"><thead><tr><th class=\"num\">No.</th><th>Card</th><th>Rarity</th><th>Version</th><th class=\"num\">Normal</th><th class=\"num\">Foil</th><th>Status</th></tr></thead><tbody>" +
        (rowsHtml || "<tr><td colspan=\"7\" class=\"note\">Nothing missing.</td></tr>") + "</tbody></table></div></details>";
    }).join("");

    $("reportOut").innerHTML = html;
    $("reportOut").querySelectorAll("details.rpset").forEach(function (d) {
      d.addEventListener("toggle", function () { openSets[d.dataset.code] = d.open; });
    });
    $("missingOut").value = report.sets.map(function (s) { return C.missingLines(s, mode).join("\n"); }).filter(Boolean).join("\n");
    $("missingCount").textContent = $("missingOut").value ? $("missingOut").value.split("\n").length + (mode === "card" ? " cards" : " printings") : "";
    $("reportControls").hidden = false;
  }


  // ---- Copy and save ----
  async function copyText(ta, status) {
    try { await navigator.clipboard.writeText(ta.value); status.textContent = "Copied."; }
    catch (e) { ta.focus(); ta.select(); status.textContent = "Selected. Press Ctrl+C to copy."; }
  }

  // Chrome and Edge open a real "Save as" dialog; other browsers download the file.
  async function saveFile(text, baseName, ext, mime, status) {
    if (!text) { status.textContent = "Nothing missing to save."; return; }
    const fileName = baseName + "-" + new Date().toISOString().slice(0, 10) + "." + ext;
    if (typeof window.showSaveFilePicker === "function") {
      try {
        const accept = {}; accept[mime] = ["." + ext];
        const handle = await window.showSaveFilePicker({ suggestedName: fileName, types: [{ description: ext.toUpperCase() + " file", accept: accept }] });
        const w = await handle.createWritable();
        await w.write(text);
        await w.close();
        status.textContent = "Saved " + handle.name + ".";
        return;
      } catch (e) {
        if (e.name === "AbortError") return;
      }
    }
    const url = URL.createObjectURL(new Blob([text], { type: mime + ";charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    status.textContent = "Downloaded " + fileName + ".";
  }

  $("buildReport").addEventListener("click", buildReport);
  $("cancelReport").addEventListener("click", function () { if (running) running.abort(); });
  $("incCommon").addEventListener("change", function () {
    if (!reportInput) return;   // re-count from the data already loaded; no new Scryfall requests
    report = C.buildCompletion(reportInput.parsed, reportInput.bySet, { includeCommon: $("incCommon").checked });
    renderReport();
  });
  $("rpMode").addEventListener("change", renderReport);
  $("rpMissing").addEventListener("change", renderReport);
  $("copyMissing").addEventListener("click", function () { copyText($("missingOut"), $("missingStatus")); });
  $("saveMissingTxt").addEventListener("click", function () {
    const t = $("missingOut").value;
    saveFile(t ? t + "\n" : "", "bindarr-missing", "txt", "text/plain", $("missingStatus"));
  });
  $("saveMissingCsv").addEventListener("click", function () {
    if (!report) { $("missingStatus").textContent = "Build a report first."; return; }
    const lines = $("missingOut").value ? C.missingCsv(report.sets, $("rpMode").value) + "\r\n" : "";
    saveFile(lines, "bindarr-missing", "csv", "text/csv", $("missingStatus"));
  });
  $("clearCache").addEventListener("click", async function () {
    await cacheClear();
    Object.keys(sources).forEach(function (k) { delete sources[k]; });
    setStatus("Saved set data cleared. The next report downloads fresh data from Scryfall.");
  });
})();
