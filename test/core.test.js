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
