// Run with: node --test   (Node 18+; no dependencies)
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../js/completion-core.js");

// ---- Set completion ----

const EXPORT_HEADER = "Card ID\tName\tSet Name\tSet ID\tCard Number\tRarity\tQuantity\tCondition\tPrinting\tLanguage";
const exportRow = (id, name, setName, set, num, rarity, qty, printing) =>
  [id, name, setName, set, num, rarity, qty, "Near Mint", printing, "English"].join("\t");

test("parseBindarrExport: Quantity > 1, Holofoil as foil, bad rows reported", () => {
  const text = [
    EXPORT_HEADER,
    exportRow("mtg-aaa", "Transcendent Archaic", "Secrets of Strixhaven", "sos", "5", "Uncommon", "2", "Normal"),
    exportRow("mtg-aaa", "Transcendent Archaic", "Secrets of Strixhaven", "sos", "5", "Uncommon", "1", "Holofoil"),
    exportRow("", "Mystery", "Nowhere", "zzz", "999", "Rare", "1", "Etched"),
    exportRow("", "Broken", "Secrets of Strixhaven", "sos", "7", "Rare", "x", "Normal"),
    ""
  ].join("\r\n");
  const p = C.parseBindarrExport(text);
  assert.deepEqual(p.missingColumns, []);
  assert.equal(p.rows.length, 3);
  assert.equal(p.rows[0].qty, 2);
  assert.equal(p.rows[0].foil, false);
  assert.equal(p.rows[1].foil, true);
  assert.equal(p.rows[2].foil, true);            // Etched counts as foil
  assert.equal(p.rows[0].cardId, "aaa");
  assert.equal(p.rows[0].rarity, "uncommon");
  assert.equal(p.errors.length, 1);
  assert.equal(p.errors[0].line, 5);
  assert.deepEqual(C.parseBindarrExport("Name\tSet\n").missingColumns.length > 0, true);
});

// Small hand-made Scryfall fixture: one set, a rare with three versions, an uncommon, a common,
// a special and a bonus card.
const card = (num, name, rarity, extra) => Object.assign({ id: "id-" + num, set: "tst", collector_number: num, name: name, rarity: rarity,
  finishes: ["nonfoil", "foil"], frame_effects: [], border_color: "black", promo_types: [], full_art: false }, extra || {});
const FIXTURE = { tst: [
  card("1", "Alpha", "rare"),
  card("101", "Alpha", "rare", { border_color: "borderless" }),
  card("201", "Alpha", "rare", { frame_effects: ["extendedart"], finishes: ["foil"] }),
  card("2", "Beta", "uncommon"),
  card("3", "Gamma", "common"),
  card("4", "Delta", "special"),
  card("5", "Epsilon", "bonus")
] };

test("buildCompletion: by card counts any version, by printing counts each one", () => {
  const p = C.parseBindarrExport([EXPORT_HEADER,
    exportRow("", "Alpha", "Test Set", "tst", "101", "Rare", "1", "Normal"),
    exportRow("", "Alpha", "Test Set", "tst", "101", "Rare", "1", "Holofoil"),
    exportRow("", "Gamma", "Test Set", "tst", "3", "Common", "1", "Normal"),
    exportRow("mtg-id-2", "Beta", "Test Set", "tst", "2x", "Uncommon", "1", "Normal"),   // number wrong, id right
    exportRow("", "Nope", "Test Set", "tst", "77", "Rare", "1", "Normal")
  ].join("\n"));
  const rep = C.buildCompletion(p, FIXTURE, { includeCommon: false });
  const set = rep.sets[0];
  const rare = set.rarities.find((r) => r.rarity === "rare");
  assert.deepEqual([rare.byCard.inSet, rare.byCard.owned, rare.byCard.missing], [1, 1, 0]);
  assert.deepEqual([rare.byPrinting.inSet, rare.byPrinting.owned, rare.byPrinting.missing], [3, 1, 2]);
  const unc = set.rarities.find((r) => r.rarity === "uncommon");
  assert.equal(unc.byCard.owned, 1);                                   // matched through Card ID
  assert.equal(set.rarities.some((r) => r.rarity === "common"), false); // commons off by default
  assert.equal(rep.unmatched.length, 1);
  assert.equal(rep.unmatched[0].name, "Nope");
  assert.deepEqual(rep.totals, { copies: 5, foilCopies: 1, printings: 4, sets: 1 });
  const p101 = set.printings.find((x) => x.num === "101");
  assert.deepEqual([p101.normal, p101.foil, p101.label], [1, 1, "Borderless"]);
  assert.equal(set.printings.find((x) => x.num === "201").label, "Extended art (foil only)");
  assert.deepEqual(C.missingLines(set, "printing").slice(0, 2), ["1 Alpha (TST) 1", "1 Delta (TST) 4"]);
  assert.deepEqual(C.missingLines(set, "card"), ["1 Delta (TST) 4", "1 Epsilon (TST) 5"]);
  const withCommon = C.buildCompletion(p, FIXTURE, { includeCommon: true });
  assert.equal(withCommon.sets[0].rarities.find((r) => r.rarity === "common").byCard.owned, 1);
});

test("buildCompletion: special and bonus rarities get their own rows", () => {
  const rep = C.buildCompletion(C.parseBindarrExport(EXPORT_HEADER + "\n" +
    exportRow("", "Delta", "Test Set", "tst", "4", "Special", "1", "Normal")), FIXTURE, {});
  const rs = rep.sets[0].rarities.map((r) => r.rarity);
  assert.deepEqual(rs, ["uncommon", "rare", "special", "bonus"]);
  const special = rep.sets[0].rarities.find((r) => r.rarity === "special");
  assert.deepEqual([special.byCard.inSet, special.byCard.owned], [1, 1]);
  assert.deepEqual([rep.sets[0].total.byCard.inSet, rep.sets[0].total.byCard.owned], [4, 1]);
});

test("versionLabel names unknown promo types instead of dropping them", () => {
  assert.equal(C.versionLabel(card("9", "X", "rare", { promo_types: ["silverscroll", "boosterfun"], border_color: "borderless", frame_effects: ["showcase"], finishes: ["foil"] })),
    "Silverscroll, Borderless, Showcase (foil only)");
  assert.equal(C.versionLabel(card("9", "X", "rare")), "Regular");
});

test("rootSet and groupBlocks follow Scryfall's parent chain", () => {
  const parents = { FRC: "FRA", TFRC: "FRC", PFRA: "FRA", TFRA: "FRA", SOA: "SOS" };
  assert.equal(C.rootSet("tfrc", parents), "FRA");
  assert.equal(C.rootSet("FRA", parents), "FRA");
  assert.deepEqual(C.groupBlocks(["fra", "frc", "sos", "soa", "mh3"], parents),
    { FRA: ["FRA", "FRC"], SOS: ["SOS", "SOA"], MH3: ["MH3"] });
});

test("needsRefresh: never within 24 h, card-count change after that, always after 7 days", () => {
  const H = 3600 * 1000, now = 1000 * H;
  assert.equal(C.needsRefresh(null, 300, now), true);
  assert.equal(C.needsRefresh({ fetchedAt: now - 2 * H, cardCount: 300 }, 999, now), false);  // < 24 h, even if changed
  assert.equal(C.needsRefresh({ fetchedAt: now - 48 * H, cardCount: 300 }, 300, now), false);
  assert.equal(C.needsRefresh({ fetchedAt: now - 48 * H, cardCount: 300 }, 305, now), true);
  assert.equal(C.needsRefresh({ fetchedAt: now - 48 * H, cardCount: 300 }, null, now), false);
  assert.equal(C.needsRefresh({ fetchedAt: now - 8 * 24 * H, cardCount: 300 }, 300, now), true);
});

test("missingCsv quotes commas and quotes", () => {
  const rep = C.buildCompletion(C.parseBindarrExport(EXPORT_HEADER), FIXTURE, {});
  // The export has no TST rows, so the report has no sets; build one by hand instead.
  assert.equal(rep.sets.length, 0);
  const set = { cards: [], printings: [{ set: "TST", num: "1", name: 'Emeritus of Truce // Swords, "Plowshares"', rarity: "mythic", label: "Regular", owned: false }] };
  assert.equal(C.missingCsv([set], "printing"),
    'Set,No.,Name,Rarity,Version\r\nTST,1,"Emeritus of Truce // Swords, ""Plowshares""",mythic,Regular');
});
