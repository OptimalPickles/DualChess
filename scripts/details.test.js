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

test("prediction: you or a username, h2h score and share", () => {
  const h2h = { total: 693, aWins: 491, draws: 30, bWins: 172 };
  assert.equal(d.predictionText("You", 0.69, h2h), "You're expected to score 69% · h2h 506–187 (73%)");
  assert.equal(d.predictionText("hikaru", 0.55, { total: 0 }), "hikaru is expected to score 55% · no h2h games yet");
  assert.equal(d.predictionText("You", 0.6, null, true), "You're expected to score 60% · h2h loading…");
  assert.equal(d.predictionText("You", 0.6, null, false), "You're expected to score 60%");
});

test("matchup and last 30 days, one line each", () => {
  assert.equal(d.matchupLine("me", "legendary9000", "me", { me: 1917.4, opp: 1781, error: 83 }), "When you play each other: You 1917 vs legendary9000 1781 (±83)");
  assert.equal(d.matchupLine("a", "b", "me", { me: 1500, opp: 1400, error: 90 }), "When a and b play each other: a 1500 vs b 1400 (±90)");
  assert.equal(d.last30Text({ total: 8, aWins: 5, draws: 1, bWins: 2 }), "Last 30 days: 5W 1D 2L (8 games, 5.5–2.5)");
  assert.equal(d.last30Text({ total: 0 }), "Last 30 days: no games");
});

test("parts for bold bits: today's record, shadow number, prediction %", () => {
  const s = { wdl: { w: 4, d: 1, l: 1 }, endTime: secs(0, 1), diff: 70 };
  assert.deepEqual(d.todayParts(s, NOW), { wdl: "4W 1D 1L", rest: " · 70 above your usual" });
  const sh = d.shadowLine({ shadow: { now: 2165, change: 40 }, official: { now: 2100 }, flags: [] });
  assert.equal(sh.level + sh.rest, "2165 · +65 vs official · +40 in 90 days");
  assert.deepEqual(d.predictionParts("You", 0.69, { total: 693, aWins: 491, draws: 30, bWins: 172 }), {
    lead: "You're expected to score ", pct: "69%", tail: " · h2h 506–187 (73%)",
  });
});

test("recent form: last 90 days only, percentages, peak from rated games, average opponent", () => {
  const g = (daysAgo, score, rated, rating, oppPre) => ({ t: secs(daysAgo), score, rated, rating, oppPre });
  const games = [g(1, 1, true, 2088, 2000), g(2, 0, false, 2050, 1950), g(3, 0.5, true, 2060, 1970), g(4, 1, false, 2100, 1980), g(120, 1, true, 2300, 2200)];
  assert.deepEqual(d.recentForm(games, NOW), { games: "4", wdl: "50 · 25 · 25%", peak: "2088", avgOpp: "1975" });
  assert.deepEqual(d.recentForm([], NOW), { games: "0", wdl: "—", peak: "—", avgOpp: "—" });
});

test("stability in a table cell", () => {
  assert.equal(d.stabilityShort({ stability: 1, ratio: 1.4, sessions: 4 }), "Stable (1.4)");
  assert.equal(d.stabilityShort({ stability: 0.5, ratio: 2.8 }), "Shifting (2.8)");
  assert.equal(d.stabilityShort({ reason: "few" }), "—");
});
