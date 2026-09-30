// run: node --test scripts/performance.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const p = require("./performance.js");

const NOW = Date.UTC(2026, 8, 30, 12, 0); // fixed so ages don't drift
const NOW_S = NOW / 1000;
const DAY = 86400;

// already-summarized game, from the player's side
const game = (oppRating, score, extra = {}) => ({
  oppRating,
  score,
  endTime: NOW_S - 60,
  timeClass: "bullet",
  rated: true,
  rules: "chess",
  ...extra,
});

// n games at 50% vs equal opponents
const evenGames = (n, extra = {}) =>
  Array.from({ length: n }, (_, i) => game(1500, i % 2, extra));

const near = (actual, expected, tolerance, label) =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${label}: expected ~${expected}, got ${actual}`
  );

// --- performance rating ---

test("3/4 vs 2000, 2050, 2150, 2200 -> 2300", () => {
  const games = [game(2000, 1), game(2050, 1), game(2150, 1), game(2200, 0)];
  assert.equal(p.performanceRating(games), 2300);
});

test("all wins -> best opponent + 400", () => {
  assert.equal(p.performanceRating([game(1900, 1), game(2000, 1)]), 2400);
});

test("all losses -> worst opponent - 400", () => {
  assert.equal(p.performanceRating([game(1900, 0), game(2000, 0)]), 1500);
});

test("single draw vs 1800 -> 1800", () => {
  assert.equal(p.performanceRating([game(1800, 0.5)]), 1800);
});

test("no games -> null", () => {
  assert.equal(p.performanceRating([]), null);
});

// --- error ---

test("8 games at 50% vs equal -> error 123", () => {
  assert.equal(Math.round(p.ratingError(evenGames(8), 1500)), 123);
});

test("20 games at 50% vs equal -> error 78", () => {
  assert.equal(Math.round(p.ratingError(evenGames(20), 1500)), 78);
});

// --- confidence (no stability) ---

test("bullet, 8 games all today -> Medium (~0.49)", () => {
  const c = p.confidence(evenGames(8), 1500, NOW, "bullet");
  near(c.value, 0.49, 0.01, "confidence");
  assert.equal(c.label, "Medium");
});

test("bullet, 8 games one per day over the last week -> Low (~0.25)", () => {
  const games = evenGames(8).map((g, i) => ({ ...g, endTime: NOW_S - i * DAY }));
  const c = p.confidence(games, 1500, NOW, "bullet");
  near(c.value, 0.25, 0.01, "confidence");
  assert.equal(c.label, "Low");
});

test("bullet, 20 games all today -> High", () => {
  const c = p.confidence(evenGames(20), 1500, NOW, "bullet");
  assert.equal(c.label, "High");
});

// --- filtering + sessions ---

test("chess960 and other time classes are filtered out", () => {
  const games = [
    game(1500, 1, { endTime: NOW_S - 100 }),
    game(1500, 1, { endTime: NOW_S - 200, rules: "chess960" }),
    game(1500, 1, { endTime: NOW_S - 300, timeClass: "blitz" }),
    game(1500, 1, { endTime: NOW_S - 400, rated: false }),
  ];
  assert.equal(p.filterGames(games, { timeClass: "bullet" }).length, 2);
  assert.equal(p.filterGames(games, { timeClass: "bullet", rated: "rated" }).length, 1);
  assert.equal(p.filterGames(games, { timeClass: "bullet", rated: "unrated" }).length, 1);
});

test("sessions split on a gap of more than 30 minutes", () => {
  const at = (minsAgo) => game(1500, 1, { endTime: NOW_S - minsAgo * 60 });
  // gaps: 10 min, 30 min (same session), 31 min (new session)
  const sessions = p.splitSessions([at(71), at(0), at(40), at(10)]);
  assert.deepEqual(
    sessions.map((s) => s.map((g) => (NOW_S - g.endTime) / 60)),
    [[0, 10, 40], [71]]
  );
});

// --- stability ---

const sessionsOf = (...pairs) => pairs.map(([perf, error]) => ({ perf, error }));

test("sessions 2060±90, 2030±85, 2080±100, 2040±95 -> ratio ~0.06, stability 1", () => {
  const st = p.stability(sessionsOf([2060, 90], [2030, 85], [2080, 100], [2040, 95]));
  near(st.ratio, 0.06, 0.005, "ratio");
  assert.equal(st.stability, 1);
  assert.equal(st.sessions, 4);
});

test("sessions 2250, 2000, 1850, 2100 all ±90 -> ratio ~3.5, stability 0", () => {
  const st = p.stability(sessionsOf([2250, 90], [2000, 90], [1850, 90], [2100, 90]));
  near(st.ratio, 3.5, 0.01, "ratio");
  assert.equal(st.stability, 0);
  assert.equal(st.mu, 2050);
});

test("fewer than 3 qualifying sessions -> stability 0", () => {
  const st = p.stability(sessionsOf([2000, 90], [2100, 90]));
  assert.equal(st.stability, 0);
  assert.equal(st.reason, "not enough sessions");
});

test("20 bullet games 10 days ago, error 78: stability 0 -> Low (~0.08), 1 -> Medium (~0.43)", () => {
  const games = evenGames(20).map((g) => ({ ...g, endTime: NOW_S - 10 * DAY }));
  assert.equal(Math.round(p.ratingError(games, 1500)), 78);

  const unstable = p.confidence(games, 1500, NOW, "bullet", 0);
  near(unstable.value, 0.08, 0.01, "stability 0");
  assert.equal(unstable.label, "Low");

  const stable = p.confidence(games, 1500, NOW, "bullet", 1);
  near(stable.value, 0.43, 0.01, "stability 1");
  assert.equal(stable.label, "Medium");
  assert.equal(stable.halfLife, 12);
});

// --- smaller helpers that had no tests yet ---

test("sessionPerformances keeps 5+ game sessions and can drop an opponent", () => {
  // one session: 3 games vs "friend", 3 vs others, 5 min apart
  const games = Array.from({ length: 6 }, (_, i) =>
    game(1500, i % 2, { endTime: NOW_S - i * 300, opponent: i < 3 ? "friend" : "other" })
  );
  assert.equal(p.sessionPerformances(games, { timeClass: "bullet" }, NOW).length, 1);
  // without friend's 3 games only 3 are left, under 5
  assert.equal(p.sessionPerformances(games, { timeClass: "bullet" }, NOW, "Friend").length, 0);
});

test("session line: 3+ games, within 12h, never daily", () => {
  const ago = (hours, n = 3) =>
    Array.from({ length: n }, (_, i) => ({ endTime: NOW_S - hours * 3600 - i * 300 }));
  assert.equal(p.showSession(ago(1), "blitz", NOW), true);
  assert.equal(p.showSession(ago(1, 2), "blitz", NOW), false);
  assert.equal(p.showSession(ago(13), "blitz", NOW), false);
  assert.equal(p.showSession(ago(1), "daily", NOW), false);
});

test("time control -> time class", () => {
  assert.equal(p.classifyTimeControl("60"), "bullet");
  assert.equal(p.classifyTimeControl("60+1"), "bullet"); // 60 + 40 = 100s
  assert.equal(p.classifyTimeControl("180"), "blitz");
  assert.equal(p.classifyTimeControl("180+2"), "blitz"); // 260s
  assert.equal(p.classifyTimeControl("600"), "rapid");
  assert.equal(p.classifyTimeControl("1/86400"), "daily");
  assert.equal(p.classifyTimeControl(""), null);
});

test("summarizeForPlayer scores from that player's side", () => {
  const raw = {
    white: { username: "Me", result: "win", rating: 1500 },
    black: { username: "Friend", result: "resigned", rating: 1620 },
    end_time: 123, time_class: "blitz", rated: true, rules: "chess", url: "u",
  };
  assert.equal(p.summarizeForPlayer(raw, "me").score, 1);
  assert.equal(p.summarizeForPlayer(raw, "friend").score, 0);
  assert.equal(p.summarizeForPlayer(raw, "FRIEND").oppRating, 1500);
  const draw = { ...raw, white: { ...raw.white, result: "agreed" }, black: { ...raw.black, result: "agreed" } };
  assert.equal(p.summarizeForPlayer(draw, "me").score, 0.5);
});
