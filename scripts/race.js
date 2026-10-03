// race chart math: one player's journey in one time class. pure, runs in node.
// records are month records for one time class (rated and unrated).
// t is seconds (like the api), now is ms. days are local calendar days

const RACE_CONFIG = {
  milestoneStep: 100,
  smoothWindow: 50, // rolling median over this many rated games
  placementGames: 60,
  settledFrom: 30, // settled start = median of rated games 30..60
  settledTo: 60,
  // "arrived": the first rated game was already within 100 of settled start, or it was
  // 300+ below and they got within 50 of it by rated game 30
  arrivedStartWithin: 100,
  arrivedBelowBy: 300,
  arrivedWithin: 50,
  arrivedWindowGames: 30,
  heldRun: 20, // held(m) = a run of 20 rated games at or above m
  breakDays: 30,
  raceBreakDays: 90, // a race path with a break this long gets flagged
  returningBreakDays: 60,
  returningWithinDays: 90, // ...that ended in the last 90 days
  inactiveDays: 30,
  gamesCounted: "both", // default for the games toggle: "rated" | "unrated" | "both"
  sparseWindowDays: 365,
  sparseMinSessions: 3,
  sessionMinGames: 5,
  // volatility: sessions in the last 12 months, minus the first 20 games after a 60+ day break
  volatilityWindowDays: 365,
  rustGames: 20,
  rustBeforeGames: 50,
  volatilityLabels: { steady: 50, streaky: 120 },
  // best/worst session need 10+ games: a 5-game 0% or 100% session is capped at the
  // opponents' rating -/+ 400, an artefact more than form
  bestWorstMinGames: 10,
  // projection: fit to the last 90 days of the smoothed line
  projectionWindowDays: 90,
  projectionMinPoints: 10,
  projectionMaxDays: 3650, // further out than 10 years isn't an estimate, it's a guess
  // climb breakdown. under 1000 unrated games in a step, the first and last 500 would be
  // the same games, so it's the first and second half instead
  climbUnratedWindow: 500,
  climbMinUnrated: 50,
  climbPer1000MinGames: 500, // a per-1000 rate from fewer games is a small, noisy change blown up
  rivalGames: 30,
  leaveOutRivals: false, // every opponent counts, frequent ones included
};

// not DAY_MS: data.js has one, and the popup loads every script into the same global scope
const MS_PER_DAY = 86400 * 1000;

// local midnight of a time in seconds, as ms
const localMidnight = (t) => new Date(t * 1000).setHours(0, 0, 0, 0);

// calendar days from day 0 to t. round(), because a day with a clock change is 23 or 25 hours
const dayCount = (t, day0T) => Math.round((localMidnight(t) - localMidnight(day0T)) / MS_PER_DAY);

function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// median of rated games 30..60, null before 60
function settledStartOf(ratings) {
  const { settledFrom, settledTo } = RACE_CONFIG;
  if (ratings.length < settledTo) return null;
  return median(ratings.slice(settledFrom - 1, settledTo));
}

// strong players on new or high-start accounts: the first rated game already within 100 of
// settled start, or 300+ below it and within 50 of it by rated game 30.
// starting above and dropping down doesn't count
function isArrived(ratings, settled) {
  if (settled == null) return false;
  const c = RACE_CONFIG;
  if (Math.abs(ratings[0] - settled) <= c.arrivedStartWithin) return true;
  if (ratings[0] > settled - c.arrivedBelowBy) return false;
  return ratings.slice(0, c.arrivedWindowGames).some((r) => Math.abs(r - settled) <= c.arrivedWithin);
}

// the milestone a settled start counts as: 1990 -> ~2000 (nearest 100)
const settledMilestone = (settled) =>
  settled == null ? null : Math.round(settled / RACE_CONFIG.milestoneStep) * RACE_CONFIG.milestoneStep;

// a milestone at or below where they settled wasn't part of their journey, so it isn't a fair race
const isSkipped = (journey, m) => journey.settledStart != null && m <= settledMilestone(journey.settledStart);

// a point on the rated line, in the shape every milestone uses. all three game counts,
// so the games toggle can pick one later
const milestonePoint = (p) => ({
  day: p.day,
  activeDays: p.activeDays,
  date: p.t,
  rating: p.rating,
  ratedGames: p.ratedGames,
  unratedGames: p.unratedGames,
  totalGames: p.totalGames,
});

// the count the games toggle asks for: "rated" | "unrated" | "both"
function gamesBy(point, counted = RACE_CONFIG.gamesCounted) {
  if (counted === "rated") return point.ratedGames;
  if (counted === "unrated") return point.unratedGames;
  return point.totalGames;
}

// --- the journey, one game at a time ---
// a fold, so the state at the end of a finished month can be saved and the current month
// added on top later (see fetchJourney in data.js). journeyOf() folds everything at once

function newJourneyState({ keepPoints = false } = {}) {
  return {
    day0T: null, // first game of any kind in this time class
    lastT: null,
    lastDate: null,
    games: 0,
    ratedCount: 0,
    unratedCount: 0,
    activeDays: 0,
    window: [], // the last 50 rated ratings, for the rolling median
    minRating: null,
    peak: null,
    firstRatings: [], // the first 60 rated ratings: settled start and arrived
    trackers: {}, // milestone -> { beenBelow, streak, streakStart, reached, held }
    breaks: [],
    daily: [], // one point per day with a rated game (that day's last), small enough to cache
    points: keepPoints ? [] : null, // every rated game, only when the chart needs them
  };
}

// reached = first rated game at or above m after being below it (a first rating that's
// already above m wasn't earned). held = the first game of the first 20-in-a-row at or
// above m, also only after being below, so held never comes before reached
function trackMilestone(tracker, m, point) {
  if (point.rating < m) {
    tracker.beenBelow = true;
    tracker.streak = 0;
    return;
  }
  if (!tracker.beenBelow) return;
  tracker.reached ??= milestonePoint(point);
  if (++tracker.streak === 1) tracker.streakStart = milestonePoint(point);
  if (tracker.streak === RACE_CONFIG.heldRun && !tracker.held) tracker.held = tracker.streakStart;
}

// add one game. records must come oldest first
function journeyStep(s, r) {
  const c = RACE_CONFIG;
  if (s.day0T == null) s.day0T = r.t;
  const day = dayCount(r.t, s.day0T);
  if (s.lastT != null) {
    const fromDay = dayCount(s.lastT, s.day0T);
    if (day - fromDay >= c.breakDays) {
      s.breaks.push({ fromT: s.lastT, toT: r.t, fromDay, toDay: day, days: day - fromDay });
    }
  }
  const date = localMidnight(r.t);
  if (date !== s.lastDate) {
    s.activeDays++;
    s.lastDate = date;
  }
  s.lastT = r.t;
  s.games++;
  if (!r.rated) {
    s.unratedCount++;
    return;
  }

  // the rating line is rated games only, but each point knows every count up to it
  s.ratedCount++;
  s.window.push(r.rating);
  if (s.window.length > c.smoothWindow) s.window.shift();
  if (s.firstRatings.length < c.placementGames) s.firstRatings.push(r.rating);
  const point = {
    t: r.t,
    day,
    rating: r.rating,
    smoothed: median(s.window),
    activeDays: s.activeDays,
    ratedGames: s.ratedCount,
    unratedGames: s.unratedCount,
    totalGames: s.ratedCount + s.unratedCount,
  };

  for (const [m, tracker] of Object.entries(s.trackers)) trackMilestone(tracker, Number(m), point);
  // milestones above the old peak start now. they were "been below" if any earlier rating was
  for (let m = (Math.floor((s.peak ?? 0) / c.milestoneStep) + 1) * c.milestoneStep; m <= r.rating; m += c.milestoneStep) {
    s.trackers[m] = { beenBelow: s.minRating != null && s.minRating < m, streak: 0, streakStart: null, reached: null, held: null };
    trackMilestone(s.trackers[m], m, point);
  }
  s.minRating = s.minRating == null ? r.rating : Math.min(s.minRating, r.rating);
  s.peak = s.peak == null ? r.rating : Math.max(s.peak, r.rating);

  if (s.daily.at(-1)?.day === day) s.daily[s.daily.length - 1] = point;
  else s.daily.push(point);
  if (s.points) s.points.push(point);
}

const EMPTY_JOURNEY = { games: 0, ratedCount: 0, unratedCount: 0, rated: [], daily: [], breaks: [], milestones: {}, settledStart: null, arrived: false, peak: null, now: null };

function finishJourney(s, now) {
  if (!s.games) return { ...EMPTY_JOURNEY };
  const settledStart = settledStartOf(s.firstRatings);
  const milestones = {};
  for (const [m, t] of Object.entries(s.trackers)) milestones[m] = { reached: t.reached, held: t.held };
  return {
    games: s.games,
    ratedCount: s.ratedCount,
    unratedCount: s.unratedCount,
    day0T: s.day0T,
    lastT: s.lastT,
    currentDay: dayCount(now / 1000, s.day0T),
    activeDays: s.activeDays,
    rated: s.points ?? undefined,
    daily: s.daily,
    breaks: s.breaks,
    settledStart,
    arrived: isArrived(s.firstRatings, settledStart),
    peak: s.peak,
    milestones,
    now: s.daily.at(-1) ?? null, // the latest rated point: rating and smoothed now
  };
}

// one player's whole journey in one time class, every rated game kept for the chart
function journeyOf(records, now) {
  const s = newJourneyState({ keepPoints: true });
  for (const r of [...records].sort((a, b) => a.t - b.t || a.id - b.id)) journeyStep(s, r);
  return finishJourney(s, now);
}

// smoothed rating on day D: the last rated point on or before it. null if none yet
function smoothedAtDay(journey, D) {
  let found = null;
  for (const p of journey.daily) {
    if (p.day > D) break;
    found = p.smoothed;
  }
  return found;
}

// --- data states ---

// which data states apply (several can). computed once and passed to every feature,
// so nothing shows confident numbers built on too little data
function dataStates(records, journey, now) {
  const c = RACE_CONFIG;
  if (!journey.games) return ["none"];
  const states = [];
  if (journey.ratedCount < c.placementGames) states.push("placing");

  // sessions of 5+ games (rated or unrated) in the last 12 months
  const since = now / 1000 - c.sparseWindowDays * 86400;
  const sessions = splitSessions(records.filter((r) => r.t >= since)).filter((s) => s.length >= c.sessionMinGames);
  if (sessions.length < c.sparseMinSessions) states.push("sparse");

  if (now / 1000 - journey.lastT > c.inactiveDays * 86400) states.push("inactive");
  if (recentBreak(journey, now)) states.push("returning");
  return states;
}

// the 60+ day break that makes someone "returning": the latest one, and only if it ended
// in the last 90 days. a break years ago says nothing about how they play now
function recentBreak(journey, now) {
  const c = RACE_CONFIG;
  const latest = [...journey.breaks].reverse().find((b) => b.days >= c.returningBreakDays);
  if (!latest || now / 1000 - latest.toT > c.returningWithinDays * 86400) return null;
  return latest;
}

// --- races ---
// players are { name, journey }. counted = the games toggle

// longest 90+ day break on the way to m (up to now if they haven't reached it), or null
function pathBreak(journey, reached) {
  const until = reached ? reached.day : Infinity;
  const long = journey.breaks.filter((b) => b.toDay <= until && b.days >= RACE_CONFIG.raceBreakDays);
  return long.length ? Math.max(...long.map((b) => b.days)) : null;
}

function raceResult(m, A, B, { counted = RACE_CONFIG.gamesCounted } = {}) {
  const c = RACE_CONFIG;
  const players = [A, B];

  // either still placing: their ratings are still moving fast, nothing to compare yet
  const placing = players.filter((p) => p.journey.ratedCount < c.placementGames);
  if (placing.length) {
    const who = placing.reduce((x, y) => (y.journey.ratedCount < x.journey.ratedCount ? y : x));
    return { m, status: "placing", who: who.name, ratedCount: who.journey.ratedCount };
  }

  // either skipped it: their journey didn't pass through m
  const skipped = players.filter((p) => isSkipped(p.journey, m));
  if (skipped.length) {
    const who = skipped.reduce((x, y) => (y.journey.settledStart > x.journey.settledStart ? y : x));
    return { m, status: "skipped", who: who.name, arrived: who.journey.arrived, at: settledMilestone(who.journey.settledStart) };
  }

  const [ra, rb] = players.map((p) => p.journey.milestones[m]?.reached ?? null);
  const breaks = [pathBreak(A.journey, ra), pathBreak(B.journey, rb)].filter((b) => b != null);
  const longestBreak = breaks.length ? Math.max(...breaks) : null;
  const flags = { includesBreak: longestBreak != null, longestBreak };

  if (ra && rb) {
    // fewer calendar days wins. games and active days are reported too, the leader can differ
    const aFirst = ra.day <= rb.day;
    const [w, l] = aFirst ? [A, B] : [B, A];
    const [rw, rl] = aFirst ? [ra, rb] : [rb, ra];
    return {
      m,
      status: "finished",
      winner: ra.day === rb.day ? null : w.name,
      loser: ra.day === rb.day ? null : l.name,
      byDays: rl.day - rw.day,
      byGames: gamesBy(rl, counted) - gamesBy(rw, counted),
      byActiveDays: rl.activeDays - rw.activeDays,
      reached: { [A.name]: ra, [B.name]: rb },
      ...flags,
    };
  }

  if (ra || rb) {
    // pace: the one still chasing, today, against where the other was on the same day
    const [faster, slower] = ra ? [A, B] : [B, A];
    const D = slower.journey.currentDay;
    const slowerNow = slower.journey.now?.smoothed ?? null;
    const fasterAtD = smoothedAtDay(faster.journey, D);
    return {
      m,
      status: "in progress",
      reachedBy: faster.name,
      chasing: slower.name,
      day: D,
      slowerNow,
      fasterAtD,
      aheadBy: slowerNow != null && fasterAtD != null ? slowerNow - fasterAtD : null,
      reached: { [faster.name]: (ra || rb) },
      ...flags,
    };
  }

  return { m, status: "neither", ...flags };
}

// rating gained since settling, against days since rated game 60, so players who started
// at very different levels can be compared. null while placing
function gainSeries(journey) {
  if (journey.settledStart == null) return null;
  const start = journey.daily.find((p) => p.ratedGames >= RACE_CONFIG.placementGames);
  if (!start) return null;
  return journey.daily
    .filter((p) => p.day >= start.day)
    .map((p) => ({ x: p.day - start.day, y: p.smoothed - journey.settledStart, date: p.t }));
}

// the highest milestone that's finished or in progress (so never skipped). null = no fair
// race, the headline compares the gain view instead
function headlineMilestone(A, B, opts = {}) {
  const top = Math.max(A.journey.peak ?? 0, B.journey.peak ?? 0);
  for (let m = Math.floor(top / RACE_CONFIG.milestoneStep) * RACE_CONFIG.milestoneStep; m > 0; m -= RACE_CONFIG.milestoneStep) {
    const result = raceResult(m, A, B, opts);
    if (result.status === "finished" || result.status === "in progress") return result;
    if (result.status === "placing") return null;
  }
  return null;
}

// the tiles under the headline: round 500s above the lower settled start, up to the higher
// peak, at most 4 (the top ones, closest to where they are now). anyone still placing has
// no settled start yet, so it's one tile at the next 500, which will say "still placing"
function tileMilestones(A, B) {
  const step = 500;
  const settled = [A, B].map((p) => p.journey.settledStart);
  const high = Math.max(A.journey.peak ?? 0, B.journey.peak ?? 0);
  if (settled.includes(null)) return [(Math.floor(high / step) + 1) * step];
  const out = [];
  for (let m = (Math.floor(Math.min(...settled) / step) + 1) * step; m <= high; m += step) out.push(m);
  return out.slice(-4);
}

// --- chart data ---
// the chart draws the daily points (one per day: that day's last rating and counts), which
// is what the journey cache keeps. options:
//   x: "days" | "games", counted: the games toggle, view: "rating" | "gain", smoothed: bool

// one player's line: [{ x, y, p }], p = the daily point for the tooltip.
// gain view: rating gained since settling, from rated game 60 on
function chartSeries(journey, { x = "days", counted = RACE_CONFIG.gamesCounted, view = "rating", smoothed = true } = {}) {
  let points = journey.daily;
  let x0 = 0;
  let y0 = 0;
  if (view === "gain") {
    if (journey.settledStart == null) return [];
    const start = points.find((p) => p.ratedGames >= RACE_CONFIG.placementGames);
    if (!start) return [];
    points = points.filter((p) => p.day >= start.day);
    x0 = x === "games" ? gamesBy(start, counted) : start.day;
    y0 = journey.settledStart;
  }
  return points.map((p) => ({
    x: (x === "games" ? gamesBy(p, counted) : p.day) - x0,
    y: (smoothed ? p.smoothed : p.rating) - y0,
    p,
  }));
}

// a line's value at x: the last point at or before it (null before it starts)
function valueAt(series, x) {
  let found = null;
  for (const pt of series) {
    if (pt.x > x) break;
    found = pt.y;
  }
  return found;
}

// where the lead changes hands. a new leader has to get 25+ points clear, so two lines
// running side by side don't flicker "takes the lead" every few days
function leadChanges(a, b, { margin = 25 } = {}) {
  const xs = [...new Set([...a, ...b].map((pt) => pt.x))].sort((p, q) => p - q);
  const changes = [];
  let leader = null;
  for (const x of xs) {
    const ya = valueAt(a, x);
    const yb = valueAt(b, x);
    if (ya == null || yb == null) continue;
    const now = ya - yb >= margin ? "a" : yb - ya >= margin ? "b" : null;
    if (!now || now === leader) continue;
    if (leader) changes.push({ x, leader: now, y: now === "a" ? ya : yb });
    leader = now;
  }
  return changes;
}

// the default zoom: just past the later crossing of the highest milestone either reached,
// so a long career doesn't squash a short one into a corner. null = show everything
function defaultZoomEnd(A, B, { x = "days", counted = RACE_CONFIG.gamesCounted } = {}) {
  const ms = Object.keys({ ...A.journey.milestones, ...B.journey.milestones }).map(Number).sort((p, q) => q - p);
  for (const m of ms) {
    const crossings = [A, B].map((pl) => pl.journey.milestones[m]?.reached).filter(Boolean);
    if (!crossings.length) continue;
    const later = Math.max(...crossings.map((c) => (x === "games" ? gamesBy(c, counted) : c.day)));
    return Math.ceil(later * 1.08) + 1;
  }
  return null;
}

// --- copy ---
// labels: name -> what to call them ("You" for the primary user).
// milestones and ratings are written plain ("2000"), counts get commas ("3,937 games")
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const unit = (n, word) => `${fmtInt(n)} ${word}${Math.round(n) === 1 ? "" : "s"}`;

function headlineText(result, A, B, labels = {}) {
  const say = (name) => labels[name] ?? name;
  // "You" mid-sentence is "you", and it takes "are" and "your"
  const isYou = (name) => labels[name] === "You";
  const object = (name) => (isYou(name) ? "you" : say(name));
  if (!result) {
    const arrived = [A, B].find((p) => p.journey.arrived);
    return arrived
      ? `${say(arrived.name)} arrived at ~${settledMilestone(arrived.journey.settledStart)}. Compare rating gained since start`
      : "Compare rating gained since start";
  }
  if (result.status === "finished") {
    if (!result.winner) return `${say(A.name)} and ${object(B.name)} both reached ${result.m} on day ${fmtInt(result.reached[A.name].day)}`;
    const days = result.reached[result.winner].day;
    return `${say(result.winner)} reached ${result.m} in ${unit(days, "day")}, ${unit(result.byDays, "day")} sooner than ${object(result.loser)}`;
  }
  if (result.status === "in progress") {
    const ahead = (result.aheadBy ?? 0) >= 0;
    const who = isYou(result.chasing) ? "you are" : `${say(result.chasing)} is`;
    const whose = isYou(result.reachedBy) ? "your" : `${say(result.reachedBy)}'s`;
    return `At day ${fmtInt(result.day)}, ${who} ${unit(Math.abs(result.aheadBy ?? 0), "point")} ${ahead ? "ahead of" : "behind"} ${whose} pace to ${result.m}`;
  }
  return "Compare rating gained since start";
}

// "412 games (15 rated)" when counting both, otherwise just the chosen count
function gamesText(point, counted) {
  if (counted === "rated") return unit(point.ratedGames, "rated game");
  if (counted === "unrated") return unit(point.unratedGames, "unrated game");
  return `${unit(point.totalGames, "game")} (${fmtInt(point.ratedGames)} rated)`;
}

// a milestone tile: [title, detail lines...]
function tileText(result, labels = {}, { counted = RACE_CONFIG.gamesCounted } = {}) {
  const say = (name) => labels[name] ?? name;
  const title = `Race to ${result.m}`;
  const brk = result.includesBreak ? ` · includes a ${result.longestBreak}-day break` : "";
  switch (result.status) {
    case "placing":
      return [`${title} · still placing (${result.ratedCount} of ${RACE_CONFIG.placementGames} games)`];
    case "skipped":
      return [`${title} · skipped · ${say(result.who)} ${result.arrived ? "arrived" : "settled"} at ~${result.at}`];
    case "neither":
      return [`${title} · neither has reached it yet${brk}`];
    case "in progress": {
      // "+230 ahead of pace", "330 behind pace" (a minus and "behind" would say it twice)
      const by = fmtInt(Math.abs(result.aheadBy ?? 0));
      const pace = (result.aheadBy ?? 0) >= 0 ? `+${by} ahead of pace` : `${by} behind pace`;
      return [`${title} · in progress · ${say(result.chasing)} ${pace}${brk}`];
    }
    case "finished": {
      if (!result.winner) return [`${title} · a tie on days${brk}`];
      const [w, l] = [result.reached[result.winner], result.reached[result.loser]];
      return [
        `${title} · ${say(result.winner)} by ${unit(result.byDays, "day")}${brk}`,
        `${unit(w.day, "day")} (${fmtInt(w.activeDays)} active) vs ${unit(l.day, "day")} (${fmtInt(l.activeDays)} active)`,
        `${gamesText(w, counted)} vs ${gamesText(l, counted)}`,
      ];
    }
  }
  return [title];
}

// --- volatility and rust ---
// records here have pre-game numbers (preGamePass), rated and unrated

// linear interpolation between the two nearest ranks
function percentile(sortedValues, q) {
  if (!sortedValues.length) return null;
  const pos = (sortedValues.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (pos - lo);
}

// how much someone's level really swings between sessions, after taking out the swing
// small samples cause by luck alone: sqrt(max(0, sample variance - mean error^2))
function volatilityFromSessions(sessions) {
  if (sessions.length < RACE_CONFIG.sparseMinSessions) return { label: "Not enough sessions", sessions: sessions.length };
  const perfs = sessions.map((s) => s.perf);
  const mean = perfs.reduce((a, b) => a + b, 0) / perfs.length;
  const variance = perfs.reduce((sum, p) => sum + (p - mean) ** 2, 0) / (perfs.length - 1);
  const noise = sessions.reduce((sum, s) => sum + s.error ** 2, 0) / sessions.length;
  const value = Math.sqrt(Math.max(0, variance - noise));
  const { steady, streaky } = RACE_CONFIG.volatilityLabels;
  const label = value < steady ? "Steady" : value > streaky ? "Streaky" : "Normal";
  const sorted = [...perfs].sort((a, b) => a - b);
  // best and worst only from sessions long enough to mean something
  const byPerf = sessions
    .filter((s) => (s.games ?? Infinity) >= RACE_CONFIG.bestWorstMinGames)
    .sort((a, b) => a.perf - b.perf);
  return {
    label,
    volatility: value,
    sessions: sessions.length,
    formRange: [percentile(sorted, 0.1), percentile(sorted, 0.9)],
    best: byPerf.at(-1) ?? null,
    worst: byPerf[0] ?? null,
  };
}

// sessions of 5+ games in the last 12 months, leaving out the first 20 games after any
// 60+ day break (rust isn't their normal form)
function volatilityOf(records, now) {
  const c = RACE_CONFIG;
  const since = now / 1000 - c.volatilityWindowDays * 86400;
  const sorted = [...records].sort((a, b) => a.t - b.t || a.id - b.id);
  const kept = [];
  let skip = 0;
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && dayCount(sorted[i].t, sorted[i - 1].t) >= c.returningBreakDays) skip = c.rustGames;
    if (skip > 0) {
      skip--;
      continue;
    }
    if (sorted[i].t >= since) kept.push(sorted[i]);
  }
  const sessions = splitSessions(kept)
    .filter((s) => s.length >= c.sessionMinGames)
    .map((s) => {
      const perf = performanceRating(s);
      return { perf, error: ratingError(s, perf), games: s.length, date: s.at(-1).t };
    })
    .filter((s) => s.perf != null && Number.isFinite(s.error));
  return volatilityFromSessions(sessions);
}

function perfOf(games) {
  const perf = performanceRating(games);
  return { perf, error: ratingError(games, perf), games: games.length };
}

// returning players only: the first 20 games after the recent break vs the 50 before it
function rustCheck(records, journey, now) {
  const brk = recentBreak(journey, now);
  if (!brk) return null;
  const sorted = [...records].sort((a, b) => a.t - b.t || a.id - b.id);
  const after = sorted.filter((r) => r.t >= brk.toT).slice(0, RACE_CONFIG.rustGames);
  const before = sorted.filter((r) => r.t <= brk.fromT).slice(-RACE_CONFIG.rustBeforeGames);
  const a = perfOf(after);
  const b = perfOf(before);
  return { breakDays: brk.days, before: b, after: a, change: a.perf != null && b.perf != null ? a.perf - b.perf : null };
}

// --- projection (an estimate, never data) ---
// fit rating = a + b * ln(1 + day) to the last 90 days of the smoothed line
function projectionOf(journey) {
  const c = RACE_CONFIG;
  if (!journey.now) return null;
  const from = journey.currentDay - c.projectionWindowDays;
  const pts = journey.daily.filter((p) => p.day >= from);
  if (pts.length < c.projectionMinPoints) return null;

  const xs = pts.map((p) => Math.log(1 + p.day));
  const ys = pts.map((p) => p.smoothed);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  const sxx = xs.reduce((s, x) => s + (x - mx) ** 2, 0);
  if (sxx === 0) return null;
  const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / sxx;
  const a = my - b * mx;

  const next = (Math.floor(journey.now.smoothed / c.milestoneStep) + 1) * c.milestoneStep;
  let daysToNext = null;
  if (b > 0) {
    const day = Math.exp((next - a) / b) - 1;
    const wait = Math.max(0, Math.round(day - journey.currentDay));
    if (wait <= c.projectionMaxDays) daysToNext = wait;
  }
  return { estimate: true, a, b, next, daysToNext };
}

// the fitted line at a day, for drawing the dotted continuation
const projectAt = (projection, day) => projection.a + projection.b * Math.log(1 + day);

// --- climb breakdown ---
// for every 100-point step from settled start up, what the step took and how the player's
// level moved inside it. records have pre-game numbers, oldest first, one time class.
// wording: "improved by +120 during 3,937 unrated games", never "unrated games gave you +120",
// because study and time also happened in that stretch

// opponents with 30+ games against the player in this record set
function rivalsOf(records) {
  const counts = {};
  for (const r of records) if (r.opponent) counts[r.opponent] = (counts[r.opponent] || 0) + 1;
  return new Set(Object.keys(counts).filter((o) => counts[o] >= RACE_CONFIG.rivalGames));
}

function climbBreakdown(records, journey, { leaveOutRivals = RACE_CONFIG.leaveOutRivals } = {}) {
  const c = RACE_CONFIG;
  if (journey.settledStart == null) return { steps: [], summary: null };
  const sorted = [...records].sort((a, b) => a.t - b.t || a.id - b.id);
  const rivals = leaveOutRivals ? rivalsOf(sorted) : new Set();

  const steps = [];
  const first = Math.ceil(journey.settledStart / c.milestoneStep) * c.milestoneStep;
  for (let m = first; journey.milestones[m + c.milestoneStep]?.reached; m += c.milestoneStep) {
    const from = journey.milestones[m]?.reached;
    const to = journey.milestones[m + c.milestoneStep].reached;
    // starting between two milestones can mean reaching the higher one first (the lower one
    // only counts after dropping under it and coming back). a step that ends before it starts
    // isn't a step
    if (!from || to.date <= from.date) continue;

    const inStep = sorted.filter((r) => r.t > from.date && r.t <= to.date && !rivals.has(r.opponent));
    const rated = inStep.filter((r) => r.rated);
    const unrated = inStep.filter((r) => !r.rated);
    const ratedPerf = perfOf(rated);

    let start = null;
    let end = null;
    if (unrated.length >= c.climbMinUnrated) {
      // the first and last 500, or the two halves when there aren't 1000 (no shared games)
      const size = Math.min(c.climbUnratedWindow, Math.floor(unrated.length / 2));
      start = perfOf(unrated.slice(0, size));
      end = perfOf(unrated.slice(-size));
    }
    const change = start && end ? end.perf - start.perf : null;
    // do the two agree within their combined error? both numbers are uncertain, not just one
    const both = ratedPerf.perf != null && end?.perf != null && Number.isFinite(ratedPerf.error) && Number.isFinite(end.error);
    const agree = both ? Math.abs(ratedPerf.perf - end.perf) <= Math.hypot(ratedPerf.error, end.error) : null;

    steps.push({
      from: m,
      to: m + c.milestoneStep,
      days: to.day - from.day,
      activeDays: to.activeDays - from.activeDays,
      ratedGames: to.ratedGames - from.ratedGames,
      unratedGames: to.unratedGames - from.unratedGames,
      ratedPerf,
      unratedPerfStart: start,
      unratedPerfEnd: end,
      unratedCount: unrated.length,
      unratedChange: change,
      per1000: change != null && unrated.length >= c.climbPer1000MinGames ? change / (unrated.length / 1000) : null,
      // the official rating at the step's start is the game that reached m
      ratingLag: start ? start.perf - from.rating : null,
      agree,
    });
  }

  const compared = steps.filter((s) => s.agree != null);
  return {
    steps,
    summary: {
      compared: compared.length,
      agreed: compared.filter((s) => s.agree).length,
      avgDiff: compared.length
        ? compared.reduce((sum, s) => sum + (s.ratedPerf.perf - s.unratedPerfEnd.perf), 0) / compared.length
        : null,
    },
  };
}

// --- shadow rating ---
// what my rating would be if my unrated games had counted: start from a real (recorded)
// rating and replay the games after it with an elo update.
// records: one time class, oldest first, with pre-game numbers (preGamePass)

// elo: the score I'd be expected to get at this rating against this opponent
const shadowExpected = (shadow, oppPre) => 1 / (1 + Math.pow(10, (oppPre - shadow) / 400));

// start at the anchor game's recorded rating, then every game after it in order, rated and
// unrated: shadow += K * (score - expected). leaveOutRivals skips opponents with 30+ games
// against me in this record set. returns the value before and after each game and the counts
function shadowReplay(records, K, { anchorIndex = 0, leaveOutRivals = false } = {}) {
  const anchor = records[anchorIndex];
  if (!anchor) return null;
  const rivals = leaveOutRivals ? rivalsOf(records) : new Set();
  let shadow = anchor.rating;
  const steps = [];
  let rated = 0;
  let unrated = 0;
  let skipped = 0;
  for (const g of records.slice(anchorIndex + 1)) {
    // a rival's games, or one with no rating to compare against (a first rated game)
    if (rivals.has(g.opponent) || g.oppPre == null) {
      skipped++;
      continue;
    }
    const expected = shadowExpected(shadow, g.oppPre);
    const before = shadow;
    shadow += K * (g.score - expected);
    steps.push({ id: g.id, t: g.t, rated: g.rated, score: g.score, myPre: g.myPre, oppPre: g.oppPre, expected, before, after: shadow });
    if (g.rated) rated++;
    else unrated++;
  }
  return { start: anchor.rating, anchorT: anchor.t, end: shadow, steps, rated, unrated, skipped };
}

// chess.com uses glicko, not plain elo, so K is measured rather than guessed: replay only
// my rated games from rated game 60 (end of placement) with each K, and see which stays
// closest to the ratings chess.com actually recorded after each game
const CALIBRATE_KS = [8, 10, 12, 14, 16, 18, 20, 22, 24];

function calibrateK(records, ks = CALIBRATE_KS) {
  const rated = records.filter((g) => g.rated && g.oppPre != null);
  const startAt = RACE_CONFIG.placementGames - 1; // rated game 60
  if (rated.length <= startAt + 1) return null;
  const results = ks.map((K) => {
    let shadow = rated[startAt].rating;
    let errorSum = 0;
    for (const g of rated.slice(startAt + 1)) {
      shadow += K * (g.score - shadowExpected(shadow, g.oppPre));
      errorSum += Math.abs(shadow - g.rating);
    }
    return { K, meanError: errorSum / (rated.length - startAt - 1) };
  });
  const best = results.reduce((a, b) => (b.meanError < a.meanError ? b : a));
  return { K: best.K, meanError: best.meanError, games: rated.length - startAt - 1, results };
}

// the record index of rated game 60, the end of placement. null before that
function placementAnchorIndex(records) {
  let rated = 0;
  for (let i = 0; i < records.length; i++) {
    if (records[i].rated && records[i].oppPre != null && ++rated === RACE_CONFIG.placementGames) return i;
  }
  return null;
}

// how badly a prediction p missed the result s (1 / 0.5 / 0). 0 is perfect, ln 2 = 0.693 is
// a coin flip's score on a decisive game. lower is better
const logLoss = (s, p) => -(s * Math.log(p) + (1 - s) * Math.log(1 - p));

// does the shadow rating know my rated results better than my official rating does?
// replay from rated game 60, and before every rated game after it predict the result two
// ways: (a) from my official rating going in (myPre), (b) from my shadow going in, which
// has also seen my unrated games. both scored with log loss on the same games.
// leaveOutRivals leaves rivals out of the replay and the scoring alike
function compareSkillEstimates(records, K, { leaveOutRivals = false } = {}) {
  const anchorIndex = placementAnchorIndex(records);
  if (anchorIndex == null) return null;
  const replay = shadowReplay(records, K, { anchorIndex, leaveOutRivals });
  let official = 0;
  let shadow = 0;
  let games = 0;
  for (const st of replay.steps) {
    if (!st.rated || st.myPre == null) continue;
    official += logLoss(st.score, shadowExpected(st.myPre, st.oppPre));
    shadow += logLoss(st.score, shadowExpected(st.before, st.oppPre));
    games++;
  }
  if (!games) return null;
  return { official: official / games, shadow: shadow / games, games, unratedSeen: replay.unrated };
}

// everything the shadow card shows. anchor = my last rated game (its recorded rating is the
// most recent real one), K measured from my own rated games, every opponent counted
function shadowSummary(records, { leaveOutRivals = RACE_CONFIG.leaveOutRivals } = {}) {
  const anchorIndex = records.map((g) => g.rated && g.oppPre != null).lastIndexOf(true);
  if (anchorIndex < 0) return null;
  const cal = calibrateK(records);
  const K = cal?.K ?? 16;
  const replay = shadowReplay(records, K, { anchorIndex, leaveOutRivals });
  return {
    anchorT: replay.anchorT,
    start: replay.start,
    end: replay.end,
    change: replay.end - replay.start,
    unrated: replay.unrated,
    skipped: replay.skipped,
    K,
    calibration: cal,
    check: compareSkillEstimates(records, K, { leaveOutRivals }),
    leaveOutRivals,
  };
}

// --- controls and cards ---

// every 100 the milestone dropdown offers: above the lower settled start, up to the higher peak
function milestoneOptions(A, B) {
  const step = RACE_CONFIG.milestoneStep;
  const settled = [A, B].map((p) => p.journey.settledStart).filter((x) => x != null);
  const low = settled.length ? settledMilestone(Math.min(...settled)) : step;
  const high = Math.max(A.journey.peak ?? 0, B.journey.peak ?? 0);
  const out = [];
  for (let m = low + step; m <= Math.floor(high / step) * step; m += step) out.push(m);
  return out;
}

const shortDate = (t) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

// a volatility card: [title, lines...]
function volatilityText(name, vol, rust) {
  if (!vol || vol.label === "Not enough sessions") {
    return [`${name} · Not enough sessions`, "Needs 3+ sessions of 5+ games in the last 12 months"];
  }
  const lines = [
    `${name} · ${vol.label} (${Math.round(vol.volatility)})`,
    `Form range ${Math.round(vol.formRange[0])}–${Math.round(vol.formRange[1])} across ${fmtInt(vol.sessions)} sessions`,
  ];
  const session = (s) => `${Math.round(s.perf)} (${unit(s.games, "game")}, ${shortDate(s.date)})`;
  if (vol.best && vol.worst) lines.push(`Best session ${session(vol.best)} · worst ${session(vol.worst)}`);
  if (rust?.change != null) {
    const sign = rust.change >= 0 ? "+" : "";
    lines.push(
      `Back from a ${rust.breakDays}-day break: ${Math.round(rust.after.perf)} in the first ${rust.after.games} games vs ` +
        `${Math.round(rust.before.perf)} in the ${rust.before.games} before (${sign}${Math.round(rust.change)})`
    );
  }
  return lines;
}

// the shadow card: [title, lines...]
function shadowText(sh) {
  if (!sh) return ["Your shadow rating", "No rated games to start from"];
  const lines = ["Your shadow rating"];
  if (!sh.unrated) {
    lines.push(`No unrated games since your last rated game (${shortDate(sh.anchorT)}, ${sh.start})`);
    return lines;
  }
  const sign = sh.change >= 0 ? "+" : "";
  lines.push(
    `Since your last rated game (${shortDate(sh.anchorT)}, ${sh.start}): ${Math.round(sh.end)} ` +
      `(${sign}${Math.round(sh.change)}) across ${unit(sh.unrated, "unrated game")}` +
      (sh.leaveOutRivals && sh.skipped ? `, frequent opponents left out` : "")
  );
  lines.push("Estimated as if your unrated games were rated.");
  if (sh.calibration) {
    lines.push(`K = ${sh.K}, measured from your rated games (off by ${sh.calibration.meanError.toFixed(1)} points on average)`);
  }
  if (sh.check) {
    const better = sh.check.shadow < sh.check.official;
    lines.push(
      `${better ? "It predicted" : "It didn't predict"} your rated results better than your official rating ` +
        `(log loss ${sh.check.shadow.toFixed(4)} vs ${sh.check.official.toFixed(4)}, ${fmtInt(sh.check.games)} games)`
    );
  }
  return lines;
}

// the data states as words, for next to the username. none is said elsewhere ("no bullet games")
function statesText(states, journey, now) {
  const out = [];
  if (states.includes("placing")) out.push(`Still placing (${journey.ratedCount} of ${RACE_CONFIG.placementGames} rated games)`);
  if (states.includes("inactive")) {
    const days = Math.floor((now / 1000 - journey.lastT) / 86400);
    const months = Math.floor(days / 30);
    out.push(`Last played ${months >= 1 ? unit(months, "month") : unit(days, "day")} ago`);
  }
  if (states.includes("returning")) {
    const brk = recentBreak(journey, now);
    out.push(`Back from a ${brk.days}-day break`);
  }
  if (states.includes("sparse")) out.push("Few sessions in the last year");
  return out.join(" · ");
}

// the footer, so a shared screenshot carries its own context
function footerText(timeClass, asOfT) {
  const tc = timeClass[0].toUpperCase() + timeClass.slice(1);
  return `${tc} · rated games · as of ${shortDate(asOfT)}`;
}

// for the methodology view, next to performance.js's METHODOLOGY
const RACE_METHODOLOGY = {
  settledStart:
    "Settled start is the median rating over rated games 30 to 60, after chess.com's placement " +
    "games stop moving the rating quickly. A milestone at or below it (rounded to the nearest 100) " +
    "is skipped for that player: they started there, so it isn't a fair race.",
  reachedHeld:
    "Reached means the first rated game at or above a milestone after being below it. A starting " +
    "rating that's already above it doesn't count. Held means 20 rated games in a row at or above " +
    "it, because bullet ratings spike: touching a rating once isn't the same as playing there.",
  days:
    "Races are counted in calendar days since the player's first game in that time class, because " +
    "players improve between games too. Games (rated, unrated, or both) and active days (dates with " +
    "at least one game) are shown next to it. The rating line itself only uses rated games.",
  breaks:
    "A break is 30 or more days without a game in that time class. A race that went through a break " +
    "of 90 days or more says so.",
  climb:
    "The climb breakdown splits a journey into 100-point steps, each from the first time the " +
    "rating reached one milestone to the first time it reached the next. For each step it shows " +
    "the time and games it took, the performance in its rated games, and how the level in its " +
    "unrated games moved from the first half (or first 500 games) to the last. Every opponent " +
    "counts, frequent ones included. A change is described as \"improved by +59 during 3,937 " +
    "unrated games\", never as something the unrated games caused, since study and time away " +
    "also happened in that stretch.",
  shadow:
    "The shadow rating starts from your last rated game's rating and replays every game since, " +
    "as if each one had been rated, with an Elo update of K times (score minus expected score). " +
    "K is measured from your own rated games: the K whose replay stays closest to chess.com's " +
    "real ratings. It's checked by asking whether it predicts your rated results better than " +
    "your official rating does, and the card says if it doesn't. It estimates skill, not the " +
    "exact rating you'd have, since matchmaking and opponents' ratings would have changed if " +
    "those games had been rated. Every opponent counts, frequent ones included.",
  volatility:
    "Volatility is how much a player's session performances really swing, using sessions of 5 or " +
    "more games in the last 12 months, after taking out what small samples swing by luck alone. " +
    "Under 50 is Steady, 50 to 120 Normal, over 120 Streaky. The first 20 games after a break of " +
    "60 days or more are left out, since rust isn't normal form.",
  projection:
    "Estimates fit a curve to the last 90 days of the smoothed rating line and say how long the next " +
    "milestone might take at that pace. They're estimates, not data.",
};

// splitSessions, performanceRating and ratingError live in performance.js. in the popup
// they're globals, in node they're required
if (typeof splitSessions === "undefined" && typeof require !== "undefined") {
  const perf = require("./performance.js");
  globalThis.splitSessions = perf.splitSessions;
  globalThis.performanceRating = perf.performanceRating;
  globalThis.ratingError = perf.ratingError;
}

if (typeof module !== "undefined") {
  module.exports = {
    RACE_CONFIG, dayCount, median, settledStartOf, isArrived, settledMilestone, isSkipped,
    gamesBy, newJourneyState, journeyStep, finishJourney, journeyOf, smoothedAtDay,
    dataStates, recentBreak, pathBreak, raceResult, gainSeries, headlineMilestone, tileMilestones,
    chartSeries, valueAt, leadChanges, defaultZoomEnd, milestoneOptions, volatilityText,
    footerText, RACE_METHODOLOGY, shadowExpected, shadowReplay, calibrateK, placementAnchorIndex,
    shadowSummary, shadowText, statesText,
    logLoss, compareSkillEstimates,
    headlineText, tileText, percentile, volatilityFromSessions, volatilityOf, rustCheck,
    projectionOf, projectAt, rivalsOf, climbBreakdown,
  };
}
