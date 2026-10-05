// run: node --test scripts/details.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const d = require("./details.js");

const NOW = new Date(2026, 9, 2, 20).getTime(); // Oct 2 2026, 8 PM local
const secs = (daysAgo, hours = 0) => NOW / 1000 - daysAgo * 86400 - hours * 3600;

test("big number: performance when Medium+, official otherwise, with the confidence word", () => {
  const p = (label) => ({ perf: 2022, official: 2100, conf: { label } });
  assert.deepEqual(d.currentLevel(p("Medium")), { rating: 2022, source: "performance", label: "Medium" });
  assert.deepEqual(d.currentLevel(p("Low")), { rating: 2100, source: "official", label: "Low" });
  assert.equal(d.currentLevel({ perf: 1800, official: null, conf: { label: "Low" } }), null);
});

test("official line: real minus sign, or why the official is shown", () => {
  assert.equal(d.officialText({ rating: 2022, source: "performance" }, 2100), "official 2100 (−78)");
  assert.equal(d.officialText({ rating: 2150, source: "performance" }, 2100), "official 2100 (+50)");
  assert.equal(d.officialText({ rating: 2100, source: "official" }, 2100), "official rating · performance confidence too low");
});

test("inactive: only after 30 days, in months once it's a month", () => {
  assert.equal(d.inactiveText(secs(29), NOW), null);
  assert.equal(d.inactiveText(secs(45), NOW), "last played 1 month ago");
  assert.equal(d.inactiveText(secs(125), NOW), "last played 4 months ago");
  assert.equal(d.inactiveText(null, NOW), null);
});

test("today: a session that ended today, with how it compares to usual", () => {
  const s = { wdl: { w: 4, d: 1, l: 1 }, endTime: secs(0, 1), diff: 70.4 };
  assert.equal(d.todayText(s, NOW), "Today: 4W 1D 1L · 70 above your usual");
  assert.equal(d.todayText({ ...s, diff: -40 }, NOW), "Today: 4W 1D 1L · 40 below your usual");
  assert.equal(d.todayText({ ...s, diff: null }, NOW), "Today: 4W 1D 1L");
  assert.equal(d.todayText({ ...s, endTime: secs(1) }, NOW), null); // yesterday's session
  assert.equal(d.todayText(null, NOW), null);
});

test("shadow line from the 90-day window", () => {
  const w = { shadow: { now: 2165.2, change: 40.4 }, official: { now: 2100 }, flags: ["Still settling"] };
  assert.deepEqual(d.shadowLine(w), {
    text: "Shadow 2165 · +65 vs official · +40 in 90 days", level: "2165", rest: " · +65 vs official · +40 in 90 days", flags: ["Still settling"],
  });
  assert.equal(d.shadowLine({ shadow: { now: 1994, change: -33 }, official: { now: 2100 }, flags: [] }).text, "Shadow 1994 · −106 vs official · −33 in 90 days");
  assert.equal(d.shadowLine({ empty: true }), null);
  assert.equal(d.shadowLine(null), null);
});

test("parts for bold bits: today's record, shadow number", () => {
  const s = { wdl: { w: 4, d: 1, l: 1 }, endTime: secs(0, 1), diff: 70 };
  assert.deepEqual(d.todayParts(s, NOW), { wdl: "4W 1D 1L", rest: " · 70 above your usual" });
  const sh = d.shadowLine({ shadow: { now: 2165, change: 40 }, official: { now: 2100 }, flags: [] });
  assert.equal(sh.level + sh.rest, "2165 · +65 vs official · +40 in 90 days");
});

// --- Compare view ---

test("blend: under 5 games current performance only, then w = n / (n + 30)", () => {
  assert.equal(d.blendedGap(0, 136, 267), 267);
  assert.equal(d.blendedGap(4, 136, 267), 267);
  assert.equal(d.blendedGap(10, 136, 267), 234.25); // w = 0.25
  assert.ok(Math.abs(d.blendedGap(693, 136, 267) - 141) < 1, String(d.blendedGap(693, 136, 267)));
});

test("win chance: E 69%, draws 4% -> 67 / 4 / 29, never below 0", () => {
  assert.deepEqual(d.winChance(0.69, 0.04), { win: 67, draw: 4, loss: 29 });
  assert.deepEqual(d.winChance(0.99, 0.1), { win: 94, draw: 10, loss: 0 });
});

test("anchor: higher confidence wins, a tie goes to the more recent rated game", () => {
  const f = (label, lastRatedT, perf = 1800) => ({ perf, error: 80, conf: { label }, lastRatedT });
  assert.equal(d.pickAnchor(f("Medium", 100), f("High", 50)), 1);
  assert.equal(d.pickAnchor(f("High", 50), f("Low", 100)), 0);
  assert.equal(d.pickAnchor(f("Medium", 100), f("Medium", 200)), 1);
  assert.equal(d.pickAnchor(f("Medium", 300), f("Medium", 200)), 0);
  assert.equal(d.pickAnchor(f("High", 1, null), f("Low", 2)), 1); // no performance: can't anchor
  assert.equal(d.pickAnchor({ perf: null }, { perf: null }), null);
  // the anchor's level is its field rating, the other is anchor -/+ G
  const m = d.matchupLevels([f("High", 1, 2052), f("Medium", 2, 1654)], { G: 136, error: 30 });
  assert.deepEqual(m.levels, [2052, 1916]);
  assert.equal(Math.round(m.error), 85); // sqrt(80^2 + 30^2)
  assert.deepEqual(d.matchupLevels([f("Low", 1, 2052), f("High", 2, 1654)], { G: 136, error: 30 }).levels, [1790, 1654]);
});

test("anchor uses performance without the games against each other (the field rating)", async () => {
  // you crush this one opponent but are ordinary against everyone else: the field rating
  // (and so the anchor) ignores the crushing
  const p = require("./performance.js");
  globalThis.applyRange = p.applyRange; globalThis.filterGames = p.filterGames;
  globalThis.performanceRating = p.performanceRating; globalThis.ratingError = p.ratingError;
  globalThis.confidence = p.confidence; globalThis.rateable = p.rateable;
  globalThis.stability = p.stability; globalThis.sessionPerformances = p.sessionPerformances;
  const g = (i, opponent, score) => ({ id: i, t: secs(0, i), timeClass: "bullet", rated: true, opponent, score, myPre: 2000, oppPre: 2000, rating: 2000 });
  const all = [...Array.from({ length: 20 }, (_, i) => g(i, "rival", 1)), ...Array.from({ length: 20 }, (_, i) => g(20 + i, `o${i}`, i % 2))];
  const field = d.fieldRating(all, { timeClass: "bullet", rated: "all" }, { type: "games", n: 20 }, NOW, "bullet", "rival");
  assert.equal(field.count, 20);
  assert.ok(Math.abs(field.perf - 2000) < 5, String(field.perf)); // 50% vs 2000s, the rival's games left out
});

test("score: 62% wins and 3% draws is 64% of points", () => {
  const games = [...Array(62).fill(1), ...Array(3).fill(0.5), ...Array(35).fill(0)].map((score, i) => ({ t: secs(1, i / 60), score, rated: false, oppPre: 1800 }));
  const f = d.form90(games, NOW);
  assert.equal(f.games, 100);
  const s = d.compareSummary({ names: ["You", "x"], perfs: [{ perf: 2000, form: f }, { perf: 1900, form: f }], h2h: null, gap: null });
  assert.equal(s.more.form[0], "You played 100 games and scored 64% of points");
  assert.equal(s.more.form[1], "x played 100 games and scored 64%");
});

test("4 games together: no 'Against each other', win chance from current performance only", () => {
  const form = { games: 50, score: 0.5, drawRate: 0.04, avgOpp: 1800 };
  const perfs = [{ perf: 2022, official: 2100, conf: { label: "Medium" }, form }, { perf: 1890, official: 1980, conf: { label: "High" }, form }];
  const h2h = { total: 4, aWins: 3, draws: 0, bWins: 1, last30: { total: 2, aWins: 1, draws: 0, bWins: 1 } };
  const s = d.compareSummary({ names: ["You", "opponent123"], perfs, h2h, gap: { G: 400, error: 200 } });
  assert.equal(s.against, null);
  assert.equal(s.basedOn, "Based on current performance");
  assert.equal(s.lead.join(""), "You lead by +120 official · +132 performance");
  assert.deepEqual(s.leadSides, ["y", "y"]);
  // gap 132 -> E 68.2%: 66 / 4 / 30
  assert.equal(s.win, "Win chance: You 66% · draw 4% · opponent123 30%");
  assert.equal(s.more.against, "Last 30 days: 1–1 for you (2 games)");
});

test("lots of games together: the against section and a blended win chance", () => {
  const form = (score, drawRate) => ({ games: 100, score, drawRate, avgOpp: 1800 });
  const perfs = [
    { perf: 2022, official: 2100, conf: { label: "Medium" }, lastRatedT: 5, field: { perf: 2052, error: 83, conf: { label: "Medium" } }, form: form(0.64, 0.03), stability: { stability: 0.5, ratio: 2.8 } },
    { perf: 1755, official: 1699, conf: { label: "Medium" }, lastRatedT: 9, field: { perf: 1654, error: 80, conf: { label: "Medium" } }, form: form(0.42, 0.05), stability: { stability: 1, ratio: 1.4 } },
  ];
  const h2h = { total: 693, aWins: 491, draws: 30, bWins: 172, last30: { total: 8, aWins: 5, draws: 1, bWins: 2 } };
  const s = d.compareSummary({ names: ["You", "legendary9000"], perfs, h2h, gap: { G: 136, error: 30 } });
  assert.equal(s.against.title, "Against each other · 693 games");
  // same confidence, legendary9000 played rated more recently: they anchor. 1654 + 136
  assert.equal(s.against.levels.join(""), "You play at 1790 vs 1654 (±85)");
  assert.deepEqual(s.against.levels.filter((_, i) => i % 2), ["1790", "1654"]); // the bold parts
  // gap 141 -> E 69%
  assert.equal(s.against.scored.join(""), "You've scored 73% · expected 69%");
  assert.deepEqual(s.chance, { win: 67, draw: 4, loss: 29 });
  assert.equal(s.win, "Win chance: You 67% · draw 4% · legendary9000 29%");
  assert.equal(s.basedOn, "Based on current performance and 693 games together");
  assert.deepEqual(s.more.consistency, ["Your results swing more than luck explains", "legendary9000 is steady"]);
  assert.equal(s.more.against, "Last 30 days: 5.5–2.5 for you (8 games)");
  assert.equal(s.more.form[2], "Average opponent: 1800 for you, 1800 for them");
});

test("lead line: one leader, two leaders, level", () => {
  const n = ["You", "x"];
  assert.equal(d.leadParts(n, d.leadOf(n, 2100, 1687), d.leadOf(n, 2009, 1716)).join(""), "You lead by +413 official · +293 performance");
  assert.equal(d.leadParts(n, d.leadOf(n, 2100, 2060), d.leadOf(n, 1990, 2002)).join(""), "You lead by +40 official · x +12 performance");
  assert.equal(d.leadParts(n, d.leadOf(n, 1900, 2000), d.leadOf(n, 1950, 2000)).join(""), "x leads by +100 official · +50 performance");
  assert.equal(d.leadParts(n, d.leadOf(n, 2000, 2000), d.leadOf(n, 1900, 2000)).join(""), "Level on official · x +100 performance");
  assert.equal(d.leadParts(n, d.leadOf(n, 2000, null), d.leadOf(n, 1990, 2002)).join(""), "x leads by +12 performance");
  // odd parts are the bold numbers
  assert.deepEqual(d.leadParts(n, d.leadOf(n, 2100, 1687), d.leadOf(n, 2009, 1716)).filter((_, i) => i % 2), ["+413", "+293"]);
});

