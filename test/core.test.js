// Run with: node --test   (Node 18+; no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/core.js");

test("TCGplayer line: brackets, variant text, collector number", () => {
  const r = C.parseLine("2 Zahur, Glory's Past (Borderless) [DFT] 370");
  assert.equal(r.qty, 2);
  assert.equal(r.name, "Zahur, Glory's Past");
  assert.equal(r.set, "DFT");
  assert.equal(r.num, "370");
  assert.equal(r.variant, "(Borderless)");
  assert.equal(r.src, "tcgplayer");
  assert.equal(r.foil, false);
});

test("TCGplayer basic land art number is dropped from the name", () => {
  const r = C.parseLine("1 Forest (0289) [DFT] 289");
  assert.equal(r.name, "Forest");
  assert.equal(r.num, "289");
});

test("TCGplayer First-Place Foil variant marks the card foil", () => {
  const r = C.parseLine("1 Plains (0507) (First-Place Foil) [DFT] 507");
  assert.equal(r.name, "Plains");
  assert.equal(r.foil, true);
});

test("ManaBox / Moxfield line with *F*", () => {
  const r = C.parseLine("1 Spell Pierce (DFT) 64 *F*");
  assert.deepEqual([r.name, r.set, r.num, r.foil, r.src], ["Spell Pierce", "DFT", "64", true, "setnum"]);
});

test("Plain decklist line and 1x form", () => {
  assert.equal(C.parseLine("1 Arcane Signet").name, "Arcane Signet");
  assert.equal(C.parseLine("1x Arcane Signet").qty, 1);
  assert.equal(C.parseLine("1 Arcane Signet").src, "plain");
});

test("Names with parentheses in a plain decklist are left alone", () => {
  // Plain lines never strip trailing text: only TCGplayer/set lines carry variant labels.
  assert.equal(C.parseLine("1 Who/What/When/Where/Why").name, "Who/What/When/Where/Why");
});

test("Headers and blank lines", () => {
  assert.equal(C.parseLine("   "), null);
  assert.equal(C.parseLine("Commander").skip, true);
  assert.equal(C.parseLine("SIDEBOARD:").skip, true);
});

test("formatLine round trip", () => {
  const r = C.parseLine("2 Zahur, Glory's Past (Borderless) [DFT] 370");
  assert.equal(C.formatLine(r), "2 Zahur, Glory's Past (DFT) 370");
  assert.equal(C.formatLine(C.parseLine("1 Spell Pierce (DFT) 64 *F*")), "1 Spell Pierce (DFT) 64 *F*");
});

test("identifierFor: set+number, default set, set map, name only", () => {
  const map = C.parseSetMap("PRE=PDFT, asdft=adft");
  assert.deepEqual(C.identifierFor(C.parseLine("1 Spell Pierce [DFT] 64"), "", map), { set: "dft", collector_number: "64" });
  assert.deepEqual(C.identifierFor(C.parseLine("1 Arcane Signet"), "EOC", map), { name: "Arcane Signet", set: "eoc" });
  assert.deepEqual(C.identifierFor(C.parseLine("1 Skyseer's Chariot [PRE] 28"), "", map), { set: "pdft", collector_number: "28" });
  assert.deepEqual(C.identifierFor(C.parseLine("1 Arcane Signet"), "", map), { name: "Arcane Signet" });
});

test("cardMatches handles double-faced names and set/number", () => {
  const dfc = { name: "Front Face // Back Face", set: "eoc", collector_number: "12", card_faces: [{ name: "Front Face" }, { name: "Back Face" }] };
  assert.equal(C.cardMatches(dfc, { name: "Front Face", set: "eoc" }), true);
  assert.equal(C.cardMatches(dfc, { set: "eoc", collector_number: "12" }), true);
  assert.equal(C.cardMatches(dfc, { set: "eoe", collector_number: "12" }), false);
});

test("quantity outside 1-999 is rejected, not parsed", () => {
  assert.match(C.parseLine("0 Sol Ring").error, /Quantity/);
  assert.match(C.parseLine("1000 Sol Ring").error, /Quantity/);
  assert.match(C.parseLine("99999999999999999999 Sol Ring").error, /Quantity/);
  assert.equal(C.parseLine("999 Sol Ring").qty, 999);
  assert.equal(C.parseLine("1x Sol Ring").qty, 1);
});

test("over-long line is rejected and its raw text truncated", () => {
  const r = C.parseLine("1 " + "A".repeat(400));
  assert.match(r.error, /over 300 characters/);
  assert.ok(r.raw.length <= 81);
});

test("checkInput enforces character and line limits", () => {
  assert.equal(C.checkInput("1 Sol Ring\n1 Arcane Signet"), "");
  assert.equal(C.checkInput("1 Sol Ring\n".repeat(C.LIMITS.maxLines)), "");
  assert.match(C.checkInput("x".repeat(C.LIMITS.maxChars + 1)), /characters/);
  assert.match(C.checkInput("1 Sol Ring\n".repeat(C.LIMITS.maxLines + 1)), /lines/);
});

const SETS = [
  { code: "EOE", name: "Edge of Eternities", released: "2025-08-01" },
  { code: "EOC", name: "Edge of Eternities Commander", released: "2025-08-01" },
  { code: "TEOC", name: "Edge of Eternities Commander Tokens", released: "2025-08-01" },
  { code: "YEOE", name: "Alchemy: Edge of Eternities", released: "2025-08-26" },
  { code: "DFT", name: "Aetherdrift", released: "2025-02-14" },
  { code: "ADFT", name: "Aetherdrift Art Series", released: "2025-02-14" }
];

test("matchSets: exact code first, then code prefix", () => {
  assert.deepEqual(C.matchSets(SETS, "adft").map((s) => s.code), ["ADFT"]);
  assert.deepEqual(C.matchSets(SETS, "eo").map((s) => s.code), ["EOE", "EOC"]);
});

test("matchSets: name search, word starts before substring", () => {
  const codes = C.matchSets(SETS, "edge of").map((s) => s.code);
  assert.deepEqual(codes.slice().sort(), ["EOC", "EOE", "TEOC", "YEOE"]);
  assert.deepEqual(C.matchSets(SETS, "aether").map((s) => s.code).sort(), ["ADFT", "DFT"]);
  assert.deepEqual(C.matchSets(SETS, "  "), []);
});

test("tokenAt finds the entry under the caret in set code fixes", () => {
  const v = "PRE=PDFT, ASDFT=adf";
  assert.deepEqual(C.tokenAt(v, v.length), { start: 16, end: 19, text: "adf" });
  assert.equal(C.tokenAt(v, 2).text, "PRE");
  assert.equal(C.tokenAt("PRE=edge of", 11).text, "edge of");
});

test("duplicatePrintings flags a printing repeated with the same foil setting", () => {
  const rows = [
    { set: "RNA", num: "245", foil: false, status: "ok" },
    { set: "RNA", num: "245", foil: false, status: "ok" },
    { set: "RNA", num: "246", foil: false, status: "ok" }
  ];
  assert.deepEqual(C.duplicatePrintings(rows), [{ lines: 2 }, { lines: 2 }, null]);
});

test("duplicatePrintings clears once one copy is ticked foil, and ignores missing rows", () => {
  assert.deepEqual(C.duplicatePrintings([
    { set: "RNA", num: "245", foil: false, status: "ok" },
    { set: "rna", num: "245", foil: true, status: "ok" }
  ]), [null, null]);
  assert.deepEqual(C.duplicatePrintings([
    { set: "RNA", num: "245", foil: false, status: "ok" },
    { set: "RNA", num: "245", foil: false, status: "bad" }
  ]), [null, null]);
});

test("reviewOrder pulls lines with the same printing together, whatever their foil ticks", () => {
  const rows = [
    { set: "DFT", num: "64", foil: false, status: "ok" },   // Spell Pierce x2
    { set: "DFT", num: "267", foil: false, status: "ok" },
    { set: "", num: "", foil: false, status: "bad" },
    { set: "DFT", num: "64", foil: true, status: "ok" },    // Spell Pierce x1, ticked foil
    { set: "DFT", num: "370", foil: false, status: "ok" }
  ];
  const v = C.reviewOrder(rows);
  assert.deepEqual(v.order, [0, 3, 1, 2, 4]);
  assert.deepEqual(v.grouped, [true, false, false, true, false]);
});
