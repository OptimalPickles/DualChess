// pure math, no chrome.* or DOM so it runs in node too
// endTime is in seconds (like the api), `now` is in ms (like Date.now())

const PERF_CONFIG = {
  halfLifeDays: { bullet: 3, blitz: 7, rapid: 14, daily: 30 },
  targetError: 60,
  sessionGapMinutes: 30,
  sessionMinGames: 3,
  sessionMaxAgeHours: 12,
  // stability check: sessions from the last 90 days with 5+ games
  stabilityWindowDays: 90,
  stabilityMinSessionGames: 5,
  stabilityMinSessions: 3,
  // ratio at or under this = fully stable, at or over shifting = not stable at all
  stableRatio: 1.5,
  shiftingRatio: 3,
  // fully stable player: half-life x (1 + 3) = 4x as long
  stabilityHalfLifeBoost: 3,
  labels: { high: 0.7, medium: 0.4 },
  searchMin: 100,
  searchMax: 3500,
  perfectScoreOffset: 400,
};

// raw api game -> that player's side of it
function summarizeForPlayer(game, username) {
  const name = username.toLowerCase();
  const isWhite = game.white.username.toLowerCase() === name;
  const me = isWhite ? game.white : game.black;
  const opp = isWhite ? game.black : game.white;

  let score = 0.5;
  if (me.result === "win") score = 1;
  else if (opp.result === "win") score = 0;

  return {
    score,
    endTime: game.end_time,
    timeClass: game.time_class,
    rated: game.rated,
    rules: game.rules,
    url: game.url,
    opponent: opp.username.toLowerCase(),
    oppRating: opp.rating,
  };
}

// chance of scoring vs opp if you're rated R
function expectedScore(R, opp) {
  return 1 / (1 + Math.pow(10, (opp - R) / 400));
}

// the R where expected score = actual score
function performanceRating(games) {
  if (!games.length) return null;

  const actual = games.reduce((sum, g) => sum + g.score, 0);
  const ratings = games.map((g) => g.oppRating);

  // no finite answer at 100% or 0%, so cap it
  if (actual === games.length) return Math.max(...ratings) + PERF_CONFIG.perfectScoreOffset;
  if (actual === 0) return Math.min(...ratings) - PERF_CONFIG.perfectScoreOffset;

  // expected total only goes up as R goes up, so binary search works
  let lo = PERF_CONFIG.searchMin;
  let hi = PERF_CONFIG.searchMax;
  while (hi - lo > 0.01) {
    const mid = (lo + hi) / 2;
    const expected = ratings.reduce((sum, opp) => sum + expectedScore(mid, opp), 0);
    if (expected < actual) lo = mid;
    else hi = mid;
  }
  return Math.round((lo + hi) / 2);
}

// ± on R. more games and closer matchups -> smaller error
function ratingError(games, R) {
  if (!games.length || R == null) return null;
  const info = games.reduce((sum, g) => {
    const E = expectedScore(R, g.oppRating);
    return sum + E * (1 - E);
  }, 0);
  if (info === 0) return Infinity;
  return 400 / (Math.LN10 * Math.sqrt(info));
}

function confidenceLabel(value) {
  if (value >= PERF_CONFIG.labels.high) return "High";
  if (value >= PERF_CONFIG.labels.medium) return "Medium";
  return "Low";
}

// freshness * precision. old games and few games both drag it down.
// a stable player's old games still say a lot about them, so their half-life stretches
function confidence(games, R, now, timeClass, stabilityValue = 0) {
  if (!games.length || R == null) return null;

  const baseHalfLife = PERF_CONFIG.halfLifeDays[timeClass] ?? PERF_CONFIG.halfLifeDays.blitz;
  const halfLife = baseHalfLife * (1 + PERF_CONFIG.stabilityHalfLifeBoost * stabilityValue);
  const freshness =
    games.reduce((sum, g) => {
      const ageDays = Math.max(0, (now / 1000 - g.endTime) / 86400);
      return sum + Math.pow(0.5, ageDays / halfLife);
    }, 0) / games.length;

  const error = ratingError(games, R);
  const precision = Math.min(1, PERF_CONFIG.targetError / error);
  const value = freshness * precision;

  return { value, freshness, precision, error, halfLife, label: confidenceLabel(value) };
}

// newest first, both the sessions and the games inside them
function splitSessions(games) {
  const sorted = [...games].sort((a, b) => b.endTime - a.endTime);
  const gap = PERF_CONFIG.sessionGapMinutes * 60;
  const sessions = [];

  for (const g of sorted) {
    const current = sessions[sessions.length - 1];
    const prev = current?.[current.length - 1];
    if (prev && prev.endTime - g.endTime <= gap) current.push(g);
    else sessions.push([g]);
  }
  return sessions;
}

// rated: "all" | "rated" | "unrated". until (seconds) keeps only games before it
function filterGames(games, { timeClass, rated = "all", until = null }) {
  return games
    .filter((g) => g.rules === "chess")
    .filter((g) => g.timeClass === timeClass)
    .filter((g) => rated === "all" || (rated === "rated" ? g.rated : !g.rated))
    .filter((g) => until == null || g.endTime < until)
    .sort((a, b) => b.endTime - a.endTime);
}

// range: { type: "today" } | { type: "games", n } | { type: "days", n } | { type: "session" }
// expects already-filtered games
function applyRange(games, range, now) {
  const sorted = [...games].sort((a, b) => b.endTime - a.endTime);

  switch (range.type) {
    case "today": {
      const midnight = new Date(now);
      midnight.setHours(0, 0, 0, 0); // local midnight
      return sorted.filter((g) => g.endTime * 1000 >= midnight.getTime());
    }
    case "games":
      return sorted.slice(0, range.n);
    case "days": {
      const cutoff = now / 1000 - range.n * 86400;
      return sorted.filter((g) => g.endTime >= cutoff);
    }
    case "session":
      return splitSessions(sorted)[0] || [];
    default:
      return sorted;
  }
}

// one { perf, error } per session, for the stability check.
// same filters as the card, last 90 days, sessions with 5+ games.
// excludeOpponent drops games vs that player (so h2h doesn't feed itself)
function sessionPerformances(games, opts, now, excludeOpponent = null) {
  let recent = applyRange(
    filterGames(games, opts),
    { type: "days", n: PERF_CONFIG.stabilityWindowDays },
    now
  );
  if (excludeOpponent) {
    const name = excludeOpponent.toLowerCase();
    recent = recent.filter((g) => g.opponent !== name);
  }

  return splitSessions(recent)
    .filter((session) => session.length >= PERF_CONFIG.stabilityMinSessionGames)
    .map((session) => {
      const perf = performanceRating(session);
      return {
        games: session.length,
        perf,
        error: ratingError(session, perf),
        start: session[session.length - 1].endTime,
        end: session[0].endTime,
      };
    });
}

// do the sessions agree with each other, given their error bars?
// ratio ~1 = they differ about as much as their errors say they should.
// much bigger = the player's level is actually moving
function stability(sessions) {
  const usable = sessions.filter((x) => x.perf != null && Number.isFinite(x.error) && x.error > 0);
  if (usable.length < PERF_CONFIG.stabilityMinSessions) {
    return { stability: 0, reason: "not enough sessions", sessions: usable.length };
  }

  // tighter sessions count more: weight 1/error^2
  const weights = usable.map((x) => 1 / (x.error * x.error));
  const totalWeight = weights.reduce((sum, w) => sum + w, 0);
  const mu = usable.reduce((sum, x, i) => sum + weights[i] * x.perf, 0) / totalWeight;

  // how many error bars each session is from mu, squared and summed
  const Q = usable.reduce((sum, x) => sum + ((x.perf - mu) / x.error) ** 2, 0);
  const ratio = Q / (usable.length - 1);

  const { stableRatio, shiftingRatio } = PERF_CONFIG;
  let value;
  if (ratio <= stableRatio) value = 1;
  else if (ratio >= shiftingRatio) value = 0;
  else value = (shiftingRatio - ratio) / (shiftingRatio - stableRatio);

  return { stability: value, ratio, mu, sessions: usable.length };
}

// worth showing: 3+ games, ended in the last 12h, and never daily
// (a daily "session" is just moves spread over days)
function showSession(sessionGames, timeClass, now) {
  if (timeClass === "daily") return false;
  if (sessionGames.length < PERF_CONFIG.sessionMinGames) return false;
  const newest = Math.max(...sessionGames.map((g) => g.endTime));
  return now / 1000 - newest <= PERF_CONFIG.sessionMaxAgeHours * 3600;
}

// "180", "60+1", "1/86400" (daily). chess.com estimates base + 40 * increment:
// under 3 min bullet, under 10 min blitz, otherwise rapid
function classifyTimeControl(tc) {
  if (!tc) return null;
  if (tc.includes("/")) return "daily";
  const [base, inc = 0] = tc.split("+").map(Number);
  if (!Number.isFinite(base) || !Number.isFinite(inc)) return null;
  const est = base + 40 * inc;
  if (est < 180) return "bullet";
  if (est < 600) return "blitz";
  return "rapid";
}

// node gets module.exports, the popup just gets globals from the script tag
if (typeof module !== "undefined") {
  module.exports = {
    PERF_CONFIG,
    summarizeForPlayer,
    expectedScore,
    performanceRating,
    ratingError,
    confidenceLabel,
    confidence,
    splitSessions,
    filterGames,
    applyRange,
    classifyTimeControl,
    showSession,
    sessionPerformances,
    stability,
  };
}
