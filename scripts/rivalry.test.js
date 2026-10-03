// run: node --test scripts/rivalry.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const rv = require("./rivalry.js");

const at = (y, m, d) => new Date(y, m - 1, d, 12).getTime() / 1000;
let id = 1;
const game = (t, myPre, oppPre, score, opts = {}) => ({
  id: id++, t, timeClass: "bullet", rated: true, rating: myPre + 8, oppRating: oppPre - 8, myPre, oppPre, score, ...opts,
});

test("rows: pre-game ratings, gap, expected, oldest first, unrateable games left out", () => {
  const games = [
    game(at(2025, 10, 2), 2032, 1944, 1),
    game(at(2025, 10, 1), 2000, 2000, 0),
    game(at(2025, 10, 3), null, null, 1), // a first rated game: no rating before it
  ];
  const rows = rv.h2hRows(games);
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].me, rows[0].opp, rows[0].gap, rows[0].expected, rows[0].actual], [2000, 2000, 0, 0.5, 0]);
  assert.deepEqual([rows[1].me, rows[1].opp, rows[1].gap], [2032, 1944, 88]); // myPre, not the recorded post-game 2040
  assert.ok(Math.abs(rows[1].expected - 0.624) < 0.001);
});

test("monthly table: games, average gap, expected and actual %, newest month first", () => {
  const rows = rv.h2hRows([
    game(at(2025, 9, 5), 2000, 1900, 1),
    game(at(2025, 9, 6), 2000, 1900, 0),
    game(at(2025, 10, 1), 2000, 2100, 1),
  ]);
  const table = rv.h2hMonthly(rows);
  assert.deepEqual(table.map((m) => [m.month, m.games, m.avgGap]), [["2025-10", 1, -100], ["2025-09", 2, 100]]);
  assert.equal(table[1].actualPct, 50);
  assert.ok(Math.abs(table[1].expectedPct - 64.0) < 0.1);
});

test("rivalry features need 30+ games in the filtered head-to-head", () => {
  const games = (n) => Array.from({ length: n }, (_, i) => game(at(2025, 10, 1) + i * 60, 2000, 2000, 1));
  assert.equal(rv.isRivalry(games(29)), false);
  assert.equal(rv.isRivalry(games(30)), true);
});

// --- 6.3 ---

const NOW = new Date(2026, 9, 1, 12).getTime();
const nowS = NOW / 1000;

// test 12
test("field me 2050±50, opponent 1728±118, h2h 73% -> me about 2027, opponent about 1854", () => {
  // 73 wins and 27 losses, all played just now (so every weight is 1)
  const games = Array.from({ length: 100 }, (_, i) => ({ t: nowS, score: i < 73 ? 1 : 0 }));
  const gap = rv.matchupGap(games, NOW);
  assert.ok(Math.abs(gap.G - 172.8) < 0.1, String(gap.G));
  const m = rv.blendMatchup({ rating: 2050, error: 50 }, { rating: 1728, error: 118 }, gap);
  assert.ok(Math.abs(m.me - 2027) < 1, String(m.me));
  assert.ok(Math.abs(m.opp - 1854) < 1, String(m.opp));
  assert.deepEqual(m.anchors, { me: true, opp: true });
});

// test 13
test("two eras: opponent +100 and I score 45% -> +18; me +400 and I score 82.5% -> -51", () => {
  const era = (n, wins, gap) => Array.from({ length: n }, (_, i) => ({ actual: i < wins ? 1 : 0, expected: 1 / (1 + Math.pow(10, -gap / 400)) }));
  assert.equal(Math.round(rv.vsExpected(era(200, 90, -100)).diff), 18);
  assert.equal(Math.round(rv.vsExpected(era(608, 502, 400)).diff), -51);
});

test("gap: recent games count more, 100% / 0% capped at ±600, and an error", () => {
  // 30 old losses (a year ago) and 30 recent wins: the recent ones dominate
  const games = [
    ...Array.from({ length: 30 }, () => ({ t: nowS - 365 * 86400, score: 0 })),
    ...Array.from({ length: 30 }, () => ({ t: nowS, score: 1 })),
  ];
  assert.ok(rv.matchupGap(games, NOW).G > 400);
  assert.equal(rv.matchupGap(games.slice(30), NOW).G, 600);
  assert.equal(rv.matchupGap(games.slice(0, 30), NOW).G, -600);
  const even = Array.from({ length: 40 }, (_, i) => ({ t: nowS, score: i % 2 }));
  const g = rv.matchupGap(even, NOW);
  assert.ok(Math.abs(g.G) < 0.1);
  assert.ok(Math.abs(g.error - 400 / (Math.LN10 * Math.sqrt(40 * 0.25))) < 0.01); // ~55
});

test("blend: one anchor alone, none -> null", () => {
  const gap = { G: 100, error: 30 };
  const onlyMe = rv.blendMatchup({ rating: 2000, error: 40 }, null, gap);
  assert.deepEqual([onlyMe.me, onlyMe.opp], [2000, 1900]);
  assert.ok(Math.abs(onlyMe.error - 50) < 1e-9); // sqrt(40^2 + 30^2)
  const onlyThem = rv.blendMatchup(null, { rating: 1800, error: 40 }, gap);
  assert.deepEqual([onlyThem.me, onlyThem.opp], [1900, 1800]);
  assert.equal(rv.blendMatchup(null, null, gap), null);
});
