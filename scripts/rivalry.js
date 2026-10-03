// rivalry math: two players who've played each other a lot. pure, runs in node.
// games are head-to-head records from the primary player's side (fetchHeadToHead), with
// pre-game numbers: myPre / oppPre are the ratings going into each game

const RIVALRY_CONFIG = {
  minGames: 30, // fewer head-to-head games than this and the rivalry features stay hidden
  gapHalfLifeDays: 60, // a head-to-head game counts half as much every 60 days
  gapRange: 1000, // the gap is searched between -1000 and +1000
  gapCap: 600, // and capped at +/-600 when one player won (or lost) every game
};

// the rivalry features only show for a pair with this many games in the filtered head-to-head
const isRivalry = (games) => games.length >= RIVALRY_CONFIG.minGames;

// one row per game, oldest first. "my" rating is whoever this record belongs to (found by
// username when the record was made), never by color or position on the board.
// games with no pre-game rating (a first rated game) can't be rated, so they're left out
function h2hRows(games) {
  return games
    .filter((g) => g.myPre != null && g.oppPre != null)
    .sort((a, b) => a.t - b.t || a.id - b.id)
    .map((g) => ({
      id: g.id,
      t: g.t,
      timeClass: g.timeClass,
      rated: g.rated,
      me: g.myPre,
      opp: g.oppPre,
      gap: g.myPre - g.oppPre,
      expected: expectedScore(g.myPre, g.oppPre),
      actual: g.score,
    }));
}

// local calendar month, "2026-09"
const monthKey = (t) => {
  const d = new Date(t * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// per month, newest first: games, the average gap at the time, expected and actual score %
function h2hMonthly(rows) {
  const months = new Map();
  for (const r of rows) {
    const key = monthKey(r.t);
    const m = months.get(key) ?? { month: key, games: 0, gapSum: 0, expectedSum: 0, actualSum: 0 };
    m.games++;
    m.gapSum += r.gap;
    m.expectedSum += r.expected;
    m.actualSum += r.actual;
    months.set(key, m);
  }
  return [...months.values()]
    .sort((a, b) => (a.month < b.month ? 1 : -1))
    .map((m) => ({
      month: m.month,
      games: m.games,
      avgGap: m.gapSum / m.games,
      expectedPct: (m.expectedSum / m.games) * 100,
      actualPct: (m.actualSum / m.games) * 100,
    }));
}

// actual minus expected score, in games: how much better (or worse) the head-to-head went
// than the ratings going into each game said it should
function vsExpected(rows) {
  const actual = rows.reduce((sum, r) => sum + r.actual, 0);
  const expected = rows.reduce((sum, r) => sum + r.expected, 0);
  return { games: rows.length, actual, expected, diff: actual - expected };
}

// --- head-to-head ratings ---

// the rating gap G between the two when they play each other, from results alone (the
// ratings recorded in the games don't come into it). recent games count more: each one is
// weighted 0.5^(age / 60 days). G is where the weighted expected score equals the weighted
// actual score. games: head-to-head records from the primary's side
function matchupGap(games, now) {
  const c = RIVALRY_CONFIG;
  const nowS = now / 1000;
  const weighted = games.map((g) => ({ w: Math.pow(0.5, Math.max(0, nowS - g.t) / 86400 / c.gapHalfLifeDays), score: g.score }));
  const totalW = weighted.reduce((sum, x) => sum + x.w, 0);
  if (!totalW) return null;
  const myScore = weighted.reduce((sum, x) => sum + x.w * x.score, 0);
  // E(G) = 1 / (1 + 10^(-G/400)), the score a G-point favourite is expected to get
  const E = (G) => 1 / (1 + Math.pow(10, -G / 400));

  let G;
  if (myScore >= totalW) G = c.gapCap;
  else if (myScore <= 0) G = -c.gapCap;
  else {
    let lo = -c.gapRange;
    let hi = c.gapRange;
    while (hi - lo > 0.01) {
      const mid = (lo + hi) / 2;
      if (totalW * E(mid) < myScore) lo = mid;
      else hi = mid;
    }
    G = Math.max(-c.gapCap, Math.min(c.gapCap, (lo + hi) / 2));
  }
  const info = weighted.reduce((sum, x) => sum + x.w * E(G) * (1 - E(G)), 0);
  const error = info > 0 ? 400 / (Math.LN10 * Math.sqrt(info)) : Infinity;
  return { G, error, weightedGames: totalW, weightedScore: myScore / totalW };
}

// both players' ratings for this matchup. an anchor is a field rating { rating, error } the
// player can be trusted on (Medium+ confidence), or null. each anchor gives an estimate of
// "me": mine directly, theirs plus the gap. they're blended by 1/error^2, the opponent is
// me - G, and the error includes the gap's
function blendMatchup(myAnchor, oppAnchor, gap) {
  if (!gap || (!myAnchor && !oppAnchor)) return null;
  const estimates = [];
  if (myAnchor) estimates.push({ me: myAnchor.rating, w: 1 / myAnchor.error ** 2 });
  if (oppAnchor) estimates.push({ me: oppAnchor.rating + gap.G, w: 1 / oppAnchor.error ** 2 });
  const totalW = estimates.reduce((sum, e) => sum + e.w, 0);
  const me = estimates.reduce((sum, e) => sum + e.w * e.me, 0) / totalW;
  return {
    me,
    opp: me - gap.G,
    error: Math.sqrt(1 / totalW + gap.error ** 2),
    anchors: { me: Boolean(myAnchor), opp: Boolean(oppAnchor) },
  };
}

// expectedScore lives in performance.js. in the popup it's a global, in node it's required
if (typeof expectedScore === "undefined" && typeof require !== "undefined") {
  globalThis.expectedScore = require("./performance.js").expectedScore;
}

if (typeof module !== "undefined") {
  module.exports = { RIVALRY_CONFIG, isRivalry, h2hRows, monthKey, h2hMonthly, vsExpected, matchupGap, blendMatchup };
}
