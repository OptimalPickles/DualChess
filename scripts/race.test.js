// run: node --test scripts/race.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const r = require("./race.js");

// local noon on day d after jan 1 2024, in seconds. noon so clock changes never move the date
const DAY0 = new Date(2024, 0, 1, 12).getTime() / 1000;
const atDay = (d, minutes = 0) => new Date(2024, 0, 1 + d, 12, minutes).getTime() / 1000;
const NOW = new Date(2024, 11, 31, 12).getTime(); // ms, like Date.now()

let nextId = 1;
const rec = (t, rating, opts = {}) => ({ id: nextId++, t, rating, rated: true, timeClass: "bullet", score: 1, oppRating: 1500, ...opts });

// one rated game a day with these ratings
const daily = (ratings) => ratings.map((rating, d) => rec(atDay(d), rating));

test("dayCount: calendar days, not 24h blocks", () => {
  assert.equal(r.dayCount(atDay(0), DAY0), 0);
  assert.equal(r.dayCount(atDay(410), DAY0), 410);
  // 11pm and 1am the next day are one calendar day apart even though only 2 hours passed
  const late = new Date(2024, 0, 1, 23).getTime() / 1000;
  const early = new Date(2024, 0, 2, 1).getTime() / 1000;
  assert.equal(r.dayCount(early, late), 1);
});

test("rolling median over the last 50 rated games, raw kept too", () => {
  const j = r.journeyOf(daily([1500, 1600, 1550]), NOW);
  assert.deepEqual(j.rated.map((p) => [p.rating, p.smoothed]), [[1500, 1500], [1600, 1550], [1550, 1550]]);
});

// test 1
test("games 30-60 around 1990 -> settled start about 1990, arrived", () => {
  // starts at 1500 (chess.com's default), climbs fast, sits around 1990
  const ratings = Array.from({ length: 70 }, (_, i) => (i < 10 ? 1500 + i * 50 : 1990 + ((i % 3) - 1) * 10));
  const j = r.journeyOf(daily(ratings), NOW);
  assert.ok(Math.abs(j.settledStart - 1990) <= 10, String(j.settledStart));
  assert.equal(j.arrived, true); // within 50 of 1990 by game 11, well inside the first 30
});

test("arrived: a slow climber isn't (300+ below, but not within 50 by game 30)", () => {
  // 1200 -> 1790 over 60 games. games 30..60 are 1490..1790, 31 values, median the 16th: 1640.
  // by game 30 they're at 1490, 150 short
  const ratings = Array.from({ length: 60 }, (_, i) => 1200 + i * 10);
  const j = r.journeyOf(daily(ratings), NOW);
  assert.equal(j.settledStart, 1640);
  assert.equal(j.arrived, false);
});

test("arrived: first rated game 1047, settled start 823 -> false (started above and dropped)", () => {
  const ratings = [1047, ...Array.from({ length: 69 }, (_, i) => 823 + ((i % 3) - 1) * 5)];
  const j = r.journeyOf(daily(ratings), NOW);
  assert.equal(j.settledStart, 823);
  assert.equal(j.arrived, false);
});

test("arrived: a first game within 100 -> true, 100-300 below -> false", () => {
  const settled = (first) => [first, ...Array(69).fill(2000)];
  assert.equal(r.journeyOf(daily(settled(1950)), NOW).arrived, true);
  assert.equal(r.journeyOf(daily(settled(1800)), NOW).arrived, false); // 200 below
});

test("fewer than 60 rated games -> no settled start", () => {
  assert.equal(r.journeyOf(daily(Array(59).fill(1500)), NOW).settledStart, null);
});

// test 2
test("settled start 1990 -> 1500 and 2000 are skipped, 2100 isn't", () => {
  const j = { settledStart: 1990 };
  assert.equal(r.isSkipped(j, 1500), true);
  assert.equal(r.isSkipped(j, 2000), true); // 1990 counts as ~2000
  assert.equal(r.isSkipped(j, 2100), false);
  assert.equal(r.isSkipped({ settledStart: null }, 1500), false); // still placing: nothing skipped yet
});

// test 3
test("a spike to 2005 then a drop -> reached(2000) set, held(2000) null", () => {
  const ratings = [1950, 1980, 2005, 1970, ...Array(30).fill(1960)];
  const j = r.journeyOf(daily(ratings), NOW);
  assert.deepEqual(j.milestones[2000].reached, {
    day: 2, activeDays: 3, date: atDay(2), rating: 2005, ratedGames: 3, unratedGames: 0, totalGames: 3,
  });
  assert.equal(j.milestones[2000].held, null);
});

test("held(m) = the first game of 20 in a row at or above m", () => {
  const ratings = [1990, 2010, 1995, ...Array(20).fill(2020), 1980];
  const j = r.journeyOf(daily(ratings), NOW);
  assert.equal(j.milestones[2000].reached.ratedGames, 2);
  assert.equal(j.milestones[2000].held.ratedGames, 4); // games 4..23
});

test("unrated games count toward day, active days, and the unrated count", () => {
  const games = [
    rec(atDay(0), 1450),
    rec(atDay(3), 1450, { rated: false }), // unrated, its own day
    rec(atDay(5), 1510),
  ];
  const j = r.journeyOf(games, NOW);
  assert.deepEqual(j.milestones[1500].reached, {
    day: 5, activeDays: 3, date: atDay(5), rating: 1510, ratedGames: 2, unratedGames: 1, totalGames: 3,
  });
});

// test 6 (the break half. includesBreak on a race path comes with raceResult)
test("a 112-day gap is a break, a 29-day one isn't", () => {
  const games = [rec(atDay(0), 1500), rec(atDay(29), 1500), rec(atDay(141), 1500)];
  const j = r.journeyOf(games, NOW);
  assert.deepEqual(j.breaks.map((b) => b.days), [112]);
  assert.deepEqual([j.breaks[0].fromDay, j.breaks[0].toDay], [29, 141]);
});

// test 7
test("3 games on one date and 1 the next day -> 2 active days", () => {
  const games = [rec(atDay(0, 0), 1500), rec(atDay(0, 5), 1500), rec(atDay(0, 10), 1500), rec(atDay(1), 1500)];
  assert.equal(r.journeyOf(games, NOW).activeDays, 2);
});

// test 9 (the state. the "still placing (25 of 60 games)" text comes with the tiles)
test("25 rated games -> placing, with the count", () => {
  const games = daily(Array(25).fill(1500));
  const j = r.journeyOf(games, NOW);
  assert.ok(r.dataStates(games, j, NOW).includes("placing"));
  assert.equal(j.ratedCount, 25);
});

test("data states: none, sparse, inactive, returning", () => {
  assert.deepEqual(r.dataStates([], r.journeyOf([], NOW), NOW), ["none"]);

  // 80 games across 4 sessions in the last month, nothing wrong
  const busy = [];
  for (let s = 0; s < 4; s++) for (let g = 0; g < 20; g++) busy.push(rec(atDay(350 + s * 3, g * 2), 1500));
  assert.deepEqual(r.dataStates(busy, r.journeyOf(busy, NOW), NOW), []);

  // one game a day: no session ever has 5 games
  const lonely = daily(Array(70).fill(1500)).map((g, i) => ({ ...g, t: atDay(290 + i) }));
  assert.ok(r.dataStates(lonely, r.journeyOf(lonely, NOW), NOW).includes("sparse"));

  // last game 2 months ago
  const old = busy.map((g) => ({ ...g, t: g.t - 60 * 86400 }));
  assert.ok(r.dataStates(old, r.journeyOf(old, NOW), NOW).includes("inactive"));

  // a 70-day break that ended in the last 90 days, then more games
  const back = [...busy.slice(0, 40).map((g) => ({ ...g, t: g.t - 80 * 86400 })), ...busy.slice(40)];
  assert.ok(r.dataStates(back, r.journeyOf(back, NOW), NOW).includes("returning"));

  // a 70-day break that ended 200 days ago (day 165), then a game every 10 days since
  const longAgo = [rec(atDay(90), 1500)];
  for (let d = 160; d <= 360; d += 10) for (let g = 0; g < 6; g++) longAgo.push(rec(atDay(d, g * 2), 1500));
  const jl = r.journeyOf(longAgo, NOW);
  assert.ok(jl.breaks.some((b) => b.days >= 60));
  assert.ok(!r.dataStates(longAgo, jl, NOW).includes("returning"));
  assert.equal(r.recentBreak(jl, NOW), null);
});

test("reached is a crossing from below: a first rating already above m doesn't count", () => {
  // starts at 1047, drops to ~800, climbs back past 900 and 1000 at games 40 and 45
  const ratings = [1047, ...Array(38).fill(820), 950, 960, 970, 980, 990, 1010, 1020];
  const j = r.journeyOf(daily(ratings), NOW);
  assert.equal(j.milestones[900].reached.ratedGames, 40);
  assert.equal(j.milestones[1000].reached.ratedGames, 45);
  // and never above m at all before dropping: still null, not game 1
  assert.equal(r.journeyOf(daily([1047, 1050]), NOW).milestones[1000].reached, null);
});

test("games toggle: 3 rated games with 50 unrated between them", () => {
  const games = [rec(atDay(0), 1500)];
  for (let i = 0; i < 25; i++) games.push(rec(atDay(1, i), 1500, { rated: false }));
  games.push(rec(atDay(2), 1550));
  for (let i = 0; i < 25; i++) games.push(rec(atDay(3, i), 1550, { rated: false }));
  games.push(rec(atDay(4), 1610));
  const third = r.journeyOf(games, NOW).rated[2];
  assert.deepEqual([third.ratedGames, third.unratedGames, third.totalGames], [3, 50, 53]);
  assert.equal(r.gamesBy(third, "rated"), 3);
  assert.equal(r.gamesBy(third, "unrated"), 50);
  assert.equal(r.gamesBy(third, "both"), 53);
  assert.equal(r.gamesBy(third), 53); // default is both
});

// --- part 2: races ---

// a journey from a list of [day, rating] rated games
const journey = (pairs, now = NOW) => r.journeyOf(pairs.map(([d, rating], i) => rec(atDay(d, i % 600), rating)), now);
const flat = (fromDay, toDay, rating, perDay = 1) => {
  const out = [];
  for (let d = fromDay; d <= toDay; d++) for (let k = 0; k < perDay; k++) out.push([d, rating]);
  return out;
};

// test 4
test("A reaches 2000 on day 410, B on day 980 -> finished, A by 570 days", () => {
  const A = { name: "a", journey: journey([...flat(0, 409, 1500), [410, 2000]]) };
  const B = { name: "b", journey: journey([...flat(0, 979, 1500), [980, 2000]]) };
  const result = r.raceResult(2000, A, B);
  assert.equal(result.status, "finished");
  assert.equal(result.winner, "a");
  assert.equal(result.byDays, 570);
  assert.equal(result.byGames, 570); // one game a day, so the same here
  assert.equal(result.includesBreak, false);
  assert.equal(r.headlineText(result, A, B), "a reached 2000 in 410 days, 570 days sooner than b");
  assert.deepEqual(r.tileText(result), [
    "Race to 2000 · a by 570 days",
    "410 days (411 active) vs 980 days (981 active)",
    "411 games (411 rated) vs 981 games (981 rated)",
  ]);
});

// test 5
test("B at day 45 rated 1380, A was 1150 at day 45 and reached 1500 on day 140 -> +230", () => {
  const A = { name: "a", journey: journey([...flat(0, 139, 1150, 2), [140, 1500]]) };
  const now = new Date(2024, 0, 1 + 45, 20).getTime();
  const B = { name: "b", journey: journey(flat(0, 45, 1380, 2), now) };
  const result = r.raceResult(1500, A, B);
  assert.equal(result.status, "in progress");
  assert.deepEqual([result.reachedBy, result.chasing, result.day, result.aheadBy], ["a", "b", 45, 230]);
  assert.equal(r.headlineText(result, A, B), "At day 45, b is 230 points ahead of a's pace to 1500");
  assert.deepEqual(r.tileText(result), ["Race to 1500 · in progress · b +230 ahead of pace"]);
});

// test 6, the race half
test("a race path with a 112-day break sets includesBreak, longest 112", () => {
  const A = { name: "a", journey: journey([...flat(0, 59, 1500), [171, 2000]]) };
  const B = { name: "b", journey: journey([...flat(0, 299, 1500), [300, 2000]]) };
  const result = r.raceResult(2000, A, B);
  assert.equal(result.status, "finished");
  assert.deepEqual([result.includesBreak, result.longestBreak], [true, 112]);
  assert.match(r.tileText(result)[0], / · includes a 112-day break$/);
});

// test 9
test("25 rated games -> 'still placing (25 of 60 games)'", () => {
  const A = { name: "a", journey: journey(flat(0, 24, 1500)) };
  const B = { name: "b", journey: journey(flat(0, 99, 1500)) };
  const result = r.raceResult(1500, A, B);
  assert.deepEqual([result.status, result.who, result.ratedCount], ["placing", "a", 25]);
  assert.deepEqual(r.tileText(result), ["Race to 1500 · still placing (25 of 60 games)"]);
  assert.equal(r.headlineMilestone(A, B), null); // nothing fair to headline yet
});

// test 2, the race half
test("a milestone at or below settled start is a skipped race", () => {
  const A = { name: "a", journey: journey(flat(0, 99, 1990)) };
  const B = { name: "b", journey: journey([...flat(0, 99, 1500), [100, 2000]]) };
  const result = r.raceResult(2000, A, B);
  assert.deepEqual([result.status, result.who, result.at], ["skipped", "a", 2000]);
  assert.equal(r.raceResult(1500, A, B).status, "skipped");
});

test("neither, and the headline picks the highest finished or in-progress milestone", () => {
  const A = { name: "a", journey: journey([...flat(0, 99, 1400), [100, 1600], [101, 1700]]) };
  const B = { name: "b", journey: journey([...flat(0, 99, 1400), [150, 1600]]) };
  assert.equal(r.raceResult(1800, A, B).status, "neither");
  const head = r.headlineMilestone(A, B);
  assert.deepEqual([head.m, head.status], [1700, "in progress"]);
  // a started within 100 of where they settled, so they arrived
  assert.equal(r.headlineText(null, A, B), "a arrived at ~1400. Compare rating gained since start");
  const climbers = [A, B].map((p) => ({ ...p, journey: { ...p.journey, arrived: false } }));
  assert.equal(r.headlineText(null, ...climbers), "Compare rating gained since start");
});

test("byGames uses the games toggle", () => {
  const withUnrated = [...flat(0, 99, 1500).map(([d, x], i) => rec(atDay(d, i % 600), x)), rec(atDay(100), 1500, { rated: false }), rec(atDay(101), 2000)];
  const A = { name: "a", journey: r.journeyOf(withUnrated, NOW) };
  const B = { name: "b", journey: journey([...flat(0, 199, 1500), [200, 2000]]) };
  assert.equal(r.raceResult(2000, A, B, { counted: "rated" }).byGames, 201 - 101);
  assert.equal(r.raceResult(2000, A, B, { counted: "both" }).byGames, 201 - 102);
  assert.deepEqual(r.tileText(r.raceResult(2000, A, B), {}, { counted: "both" })[2], "102 games (101 rated) vs 201 games (201 rated)");
});

test("gain view: smoothed minus settled start, from rated game 60", () => {
  const j = journey([...flat(0, 59, 1500), ...flat(60, 160, 1600)]);
  const gain = r.gainSeries(j);
  assert.deepEqual([gain[0].x, gain[0].y], [0, 0]);
  assert.equal(gain.at(-1).y, 100);
  assert.equal(r.gainSeries(journey(flat(0, 30, 1500))), null); // still placing
});

// --- part 2: volatility, rust, projection ---

// test 8
test("sessions 2300/2050/2150/1900/2250/2000 at ±110 -> volatility about 106, Normal", () => {
  const sessions = [2300, 2050, 2150, 1900, 2250, 2000].map((perf, i) => ({ perf, error: 110, games: 10, date: atDay(i) }));
  const v = r.volatilityFromSessions(sessions);
  assert.ok(Math.abs(v.volatility - 106) < 1, String(v.volatility));
  assert.equal(v.label, "Normal");
  assert.equal(v.best.perf, 2300);
  assert.equal(v.worst.perf, 1900);
  // a 5-game session can't be the best or worst
  const withShort = [...sessions, { perf: 2600, error: 200, games: 5, date: atDay(9) }];
  assert.equal(r.volatilityFromSessions(withShort).best.perf, 2300);
  assert.equal(r.volatilityFromSessions(sessions.slice(0, 2)).label, "Not enough sessions");
});

test("volatility labels, form range is the 10th-90th percentile", () => {
  const steady = [2000, 2010, 1995, 2005].map((perf) => ({ perf, error: 100 }));
  assert.equal(r.volatilityFromSessions(steady).label, "Steady");
  const streaky = [2400, 1700, 2300, 1800].map((perf) => ({ perf, error: 50 }));
  assert.equal(r.volatilityFromSessions(streaky).label, "Streaky");
  assert.deepEqual(r.percentile([10, 20, 30, 40, 50], 0.1), 14);
});

// a game with pre-game numbers, for the performance-based checks
const pre = (t, score, oppPre, opts = {}) => rec(t, 2000, { score, oppPre, oppRating: oppPre, myPre: 2000, ...opts });

test("rust check: the first 20 games after a recent break vs the 50 before", () => {
  const games = [];
  for (let i = 0; i < 50; i++) games.push(pre(atDay(200, i), i % 2, 2000)); // 50% vs 2000
  for (let i = 0; i < 20; i++) games.push(pre(atDay(300, i), i % 4 === 0 ? 1 : 0, 2000)); // 25% after 100 days off
  const now = new Date(2024, 0, 1 + 310, 12).getTime();
  const rust = r.rustCheck(games, r.journeyOf(games, now), now);
  assert.equal(rust.breakDays, 100);
  assert.deepEqual([rust.before.games, rust.after.games], [50, 20]);
  assert.equal(rust.before.perf, 2000);
  assert.ok(rust.change < -100, String(rust.change));
  // same break, but it ended long ago: not returning, no rust check
  const later = new Date(2024, 0, 1 + 500, 12).getTime();
  assert.equal(r.rustCheck(games, r.journeyOf(games, later), later), null);
});

test("projection: an estimate of days to the next milestone, none when flat", () => {
  // "now" is the day after the last game, so the last 90 days have games in them
  const now = new Date(2024, 0, 1 + 200, 12).getTime();
  const climbing = journey(Array.from({ length: 200 }, (_, d) => [d, Math.round(1200 + 120 * Math.log(1 + d))]), now);
  const p = r.projectionOf(climbing);
  assert.equal(p.estimate, true);
  assert.ok(p.b > 0);
  assert.equal(p.next, Math.floor(climbing.now.smoothed / 100) * 100 + 100);
  assert.ok(p.daysToNext > 0 && p.daysToNext < 3650, String(p.daysToNext));
  assert.equal(r.projectionOf(journey(flat(0, 199, 1500), now)).daysToNext, null);
  // nothing in the last 90 days: no estimate at all
  assert.equal(r.projectionOf(journey(flat(0, 99, 1500), now)), null);
});

// --- climb breakdown ---

// settled at 1850, reaches 1900 on day 60, then the step 1900 -> 2000:
// `unrated` unrated games vs 1800, then 3 rated wins vs 1800 (the last one reaches 2000)
function climb(unrated, { rival = 0 } = {}) {
  const games = [];
  for (let d = 0; d < 60; d++) games.push(pre(atDay(d), 0.5, 1850, { rating: 1850, myPre: 1850 }));
  games.push(pre(atDay(60), 1, 1800, { rating: 1900, myPre: 1850 }));
  for (let i = 0; i < unrated; i++) {
    // the first half at 50%, the second half at 70%
    const score = i < unrated / 2 ? i % 2 : i % 10 < 7 ? 1 : 0;
    const opponent = i < rival ? "rival" : `opponent${i}`; // everyone else, once each
    games.push(pre(atDay(61 + Math.floor(i / 50), i % 50), score, 1800, { rated: false, rating: 1900, myPre: 1900, opponent }));
  }
  const last = 62 + Math.floor(unrated / 50);
  [1950, 1980, 2010].forEach((rating, k) => games.push(pre(atDay(last, k), 1, 1800, { rating, myPre: rating - 30 })));
  return games;
}

test("climb: 3 rated wins vs 1800 and 600 unrated going 50% -> 70%", () => {
  const games = climb(600);
  const j = r.journeyOf(games, NOW);
  assert.equal(j.settledStart, 1850);
  const { steps } = r.climbBreakdown(games, j);
  const step = steps.find((s) => s.from === 1900);
  assert.deepEqual([step.ratedGames, step.unratedGames], [3, 600]);
  assert.ok(step.unratedChange > 0, String(step.unratedChange));
  assert.ok(step.ratedPerf.perf > step.unratedPerfStart.perf);
  assert.equal(step.ratedPerf.perf, 2200); // 3 wins vs 1800: best opponent + 400
  assert.equal(step.ratingLag, step.unratedPerfStart.perf - 1900);
  assert.ok(Math.abs(step.per1000 - step.unratedChange / 0.6) < 1e-9);
  // 600 games: the two halves, 300 each. the first half is all 50% vs 1800, so exactly 1800
  assert.equal(step.unratedPerfStart.games, 300);
  assert.equal(step.unratedPerfStart.perf, 1800);
});

test("climb: under 1000 unrated games, start and end are the two halves, never the same games", () => {
  const games = climb(310);
  const step = r.climbBreakdown(games, r.journeyOf(games, NOW)).steps.find((s) => s.from === 1900);
  assert.deepEqual([step.unratedPerfStart.games, step.unratedPerfEnd.games], [155, 155]);
  assert.ok(step.unratedChange > 0); // 50% half vs 70% half
  assert.equal(step.per1000, null); // 310 games: too few to turn into a per-1000 rate
});

test("climb: rivals are left out by default", () => {
  const games = climb(600, { rival: 100 });
  const j = r.journeyOf(games, NOW);
  assert.equal(r.climbBreakdown(games, j).steps.find((s) => s.from === 1900).unratedCount, 500);
});

test("climb: agreement uses both numbers' errors combined", () => {
  // rated 2200±e1 vs unrated end: agree if |difference| <= sqrt(e1^2 + e2^2)
  const games = climb(600);
  const step = r.climbBreakdown(games, r.journeyOf(games, NOW)).steps.find((s) => s.from === 1900);
  const combined = Math.hypot(step.ratedPerf.error, step.unratedPerfEnd.error);
  assert.equal(step.agree, Math.abs(step.ratedPerf.perf - step.unratedPerfEnd.perf) <= combined);
  assert.ok(combined > step.ratedPerf.error);
});

test("climb: fewer than 50 unrated games -> unrated fields null", () => {
  const games = climb(40);
  const { steps } = r.climbBreakdown(games, r.journeyOf(games, NOW));
  const step = steps.find((s) => s.from === 1900);
  assert.equal(step.unratedPerfStart, null);
  assert.equal(step.unratedPerfEnd, null);
  assert.equal(step.unratedChange, null);
  assert.equal(step.agree, null);
});

test("climb: leaveOutRivals drops a 30+ game opponent from the unrated numbers", () => {
  const games = climb(600, { rival: 100 });
  const j = r.journeyOf(games, NOW);
  const all = r.climbBreakdown(games, j, { leaveOutRivals: false }).steps.find((s) => s.from === 1900);
  const noRival = r.climbBreakdown(games, j, { leaveOutRivals: true }).steps.find((s) => s.from === 1900);
  assert.deepEqual([...r.rivalsOf(games)], ["rival"]);
  assert.deepEqual([all.unratedCount, noRival.unratedCount], [600, 500]);
  assert.notEqual(all.unratedPerfStart.perf, noRival.unratedPerfStart.perf);
  assert.equal(noRival.unratedGames, 600); // the step's own game counts don't change
});

test("journey folded month by month = folded all at once", () => {
  const games = climb(600);
  const now = NOW;
  const split = games.findIndex((g) => g.t >= atDay(70));
  const s = r.newJourneyState();
  const sorted = [...games].sort((a, b) => a.t - b.t || a.id - b.id);
  for (const g of sorted.slice(0, split)) r.journeyStep(s, g);
  const saved = JSON.parse(JSON.stringify(s)); // what goes into storage
  for (const g of sorted.slice(split)) r.journeyStep(saved, g);
  const { rated, ...whole } = r.journeyOf(games, now);
  const { rated: _, ...folded } = r.finishJourney(saved, now);
  assert.deepEqual(folded, whole);
});
