// the numbers the popup and the comparison tab both show, built from storage, plus the
// formatting they share. no DOM in here. uses performance.js, rivalry.js and data.js

const SETTINGS_KEY = "perfSettings";
const DEFAULT_SETTINGS = { time: "auto", range: "games:20", rated: "all" };
const SESSION_RANGE = { type: "session" };
const RECENT_GAMES_SHOWN = 5;

// --- copy ---
// counts always get thousands separators: "3,080 games"
const fmtCount = (n) => Math.round(n).toLocaleString("en-US");
// a score can be a half point (a draw): "905.5", "1,810"
const fmtScore = (x) => x.toLocaleString("en-US", { maximumFractionDigits: 1 });
// every date the same way: "Oct 29, 2025" (t in seconds)
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const fmtWdl = (t) => `${t.w}W ${t.d}D ${t.l}L`;

function timeAgo(t, now) {
  const mins = Math.round((now / 1000 - t) / 60);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

// "3:42 PM" today, "Sep 30, 2026, 3:42 PM" before that
function formatAsOf(ms, now) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${fmtDate(ms / 1000)}, ${time}`;
}

// "today" | "games:20" | "days:7"
function parseRange(value) {
  const [type, n] = value.split(":");
  return n ? { type, n: Number(n) } : { type };
}

function rangeLabel(range) {
  if (range.type === "today") return "today";
  if (range.type === "games") return `last ${range.n} games`;
  if (range.type === "days") return `last ${range.n} days`;
  return "latest session";
}

async function loadSettings() {
  const saved = (await chrome.storage.local.get(SETTINGS_KEY))[SETTINGS_KEY];
  return { ...DEFAULT_SETTINGS, ...saved };
}

// fully stable (ratio <= 1.5) or not. anything above 1.5 is already losing stability
function stabilityText(st) {
  if (!st || st.reason) return "Not enough sessions to judge stability";
  const ratio = st.ratio < 1 ? st.ratio.toFixed(2) : st.ratio.toFixed(1);
  return st.stability === 1
    ? `Stable across ${st.sessions} sessions (ratio ${ratio})`
    : `Level is shifting (ratio ${ratio})`;
}

// --- time class ---

// time class with the most recent last game in /stats
function pickTimeClass(stats) {
  if (!stats) return null;
  let best = null;
  for (const tc of ["bullet", "blitz", "rapid", "daily"]) {
    const date = stats[`chess_${tc}`]?.last?.date;
    if (date && (!best || date > best.date)) best = { tc, date };
  }
  return best?.tc ?? null;
}

// the time class someone has played most, for "no bullet games, try blitz"
function mostPlayedTimeClass(stats) {
  let best = null;
  for (const tc of ["bullet", "blitz", "rapid", "daily"]) {
    const r = stats?.[`chess_${tc}`]?.record;
    const games = r ? r.win + r.loss + r.draw : 0;
    if (games && (!best || games > best.games)) best = { tc, games };
  }
  return best?.tc ?? null;
}

// --- performance ---

function wdl(games) {
  const t = { w: 0, d: 0, l: 0 };
  for (const g of games) {
    if (g.score === 1) t.w++;
    else if (g.score === 0) t.l++;
    else t.d++;
  }
  return t;
}

// one player's card, from storage alone. data = their /stats (fetchStats).
// opponent: also work out the field rating, their games without this opponent
async function loadPerformance(username, data, now, settings, timeClass, opponent = null) {
  if (!timeClass) return null;

  const opts = { timeClass, rated: settings.rated };
  const range = parseRange(settings.range);

  // the newest 6 months, from storage. the popup's sync keeps all 6 loaded, so any range,
  // time class, or rated setting works without a request. null = not loaded yet
  const all = await fetchPlayerGames(username, () => true, { cacheOnly: true });
  if (!all) return null;
  const filtered = filterGames(all, opts);

  const games = applyRange(filtered, range, now);
  const perf = performanceRating(games);

  // steady players keep confidence longer between games
  const stab = stability(sessionPerformances(all, opts, now));

  // most recent game in this time class, rated or not. not /stats last.date
  const lastActivity = filterGames(all, { timeClass, rated: "all" })[0]?.t ?? null;

  let session = null;
  const sessionGames = applyRange(filtered, SESSION_RANGE, now);
  if (showSession(sessionGames, timeClass, now)) {
    const sPerf = performanceRating(sessionGames);
    const start = sessionGames[sessionGames.length - 1].t;
    // same range, but only games from before this session
    const basePerf = performanceRating(
      applyRange(filterGames(all, { ...opts, until: start }), range, now)
    );
    session = {
      perf: sPerf,
      error: ratingError(sessionGames, sPerf),
      wdl: wdl(sessionGames),
      endTime: sessionGames[0].t,
      active: now / 1000 - sessionGames[0].t <= PERF_CONFIG.sessionGapMinutes * 60,
      diff: basePerf == null ? null : sPerf - basePerf,
    };
  }

  const result = {
    timeClass,
    range,
    // games the numbers came from (a first rated game has no pre-game rating, so it's skipped)
    count: rateable(games).length,
    perf,
    error: ratingError(games, perf),
    conf: confidence(games, perf, now, timeClass, stab.stability),
    stability: stab,
    lastEndTime: lastActivity,
    official: data?.stats?.[`chess_${timeClass}`]?.last?.rating ?? null,
    session,
    field: opponent ? fieldRating(all, opts, range, now, timeClass, opponent) : null,
    // for "only 7 of 20 found since ..."
    requested: range.type === "games" ? range.n : null,
    searchedSince: all.length ? Math.min(...all.map((g) => g.t)) : null,
  };
  console.log(`[Performance] loadPerformance("${username}"):`, result);
  return result;
}

// how they play against everyone except the other player: the same time class and range,
// without the games between the two (so the head-to-head can't feed its own anchor). the 6
// months already loaded are what "extend back if needed" draws on for a games range
function fieldRating(all, opts, range, now, timeClass, opponent) {
  const name = opponent.toLowerCase();
  const games = applyRange(filterGames(all.filter((g) => g.opponent !== name), opts), range, now);
  const perf = performanceRating(games);
  const stab = stability(sessionPerformances(all, opts, now, name));
  return {
    perf,
    error: ratingError(games, perf),
    count: rateable(games).length,
    conf: confidence(games, perf, now, timeClass, stab.stability),
  };
}

// --- prediction and matchup ---

// perf if we trust it (Medium/High), otherwise official
function ratingFor(p) {
  if (p?.perf != null && (p.conf?.label === "High" || p.conf?.label === "Medium")) {
    return { rating: p.perf, source: "performance" };
  }
  if (p?.official != null) return { rating: p.official, source: "official" };
  return null;
}

// expected score for usernames[0] vs usernames[1]
function matchupPrediction(usernames, perfs) {
  const a = ratingFor(perfs[0]);
  const b = ratingFor(perfs[1]);
  if (!a || !b) return null;
  return {
    a: { username: usernames[0], ...a },
    b: { username: usernames[1], ...b },
    expected: expectedScore(a.rating, b.rating),
  };
}

// a field rating can anchor the matchup only if it's trustworthy: Medium+ confidence,
// stability included
const anchorOf = (p) =>
  p?.field?.perf != null && (p.field.conf?.label === "High" || p.field.conf?.label === "Medium")
    ? { rating: p.field.perf, error: p.field.error }
    : null;

function matchupOf(perfs, h2h, now) {
  const gap = matchupGap(h2h.games, now);
  return { gap, blended: blendMatchup(anchorOf(perfs[0]), anchorOf(perfs[1]), gap), fields: perfs.map((p) => p?.field ?? null) };
}

// h2h narrowed to one time class and the rated setting (standard chess only),
// plus the same thing for just the last 30 days
function filterHeadToHead(h2h, opts, now) {
  if (!h2h) return null;
  const games = filterGames(h2h.games, opts);
  const last30 = applyRange(games, { type: "days", n: 30 }, now);
  return {
    ...tallyHeadToHead(h2h.a, h2h.b, games),
    last30: tallyHeadToHead(h2h.a, h2h.b, last30),
    opts,
    allTotal: h2h.total,
  };
}

// --- the popup's lines ---
// pure: numbers in, words out. "−" is a real minus sign, so "+78" and "−78" line up

const signedMinus = (n) => (n < 0 ? `−${-n}` : `+${n}`);
const plural = (n, word) => `${fmtCount(n)} ${word}${n === 1 ? "" : "s"}`;

// the big number: performance when it's trusted (Medium+), otherwise official.
// label = the performance's confidence, said next to a dot of the same color
function currentLevel(p) {
  const r = ratingFor(p);
  if (!r) return null;
  return { ...r, label: p?.conf?.label ?? "Low" };
}

// "official 2100 (−78)", or why the big number is the official one
function officialText(level, official) {
  if (level.source === "official") return "official rating · performance confidence too low";
  if (official == null) return "no official rating yet";
  return `official ${official} (${signedMinus(Math.round(level.rating - official))})`;
}

// "last played 4 months ago" once they've been away 30+ days, else null. lastT in seconds
function inactiveText(lastT, now) {
  if (lastT == null) return null;
  const days = Math.floor((now / 1000 - lastT) / 86400);
  if (days < RACE_CONFIG.inactiveDays) return null;
  const months = Math.floor(days / 30);
  return `last played ${months >= 1 ? plural(months, "month") : plural(days, "day")} ago`;
}

// "Today: 4W 1D 1L · 70 above your usual". only for a session whose last game was today
// parts: { wdl: "4W 1D 1L", rest: " · 70 above your usual" }, so the record can be bold
function todayParts(session, now) {
  if (!session || new Date(session.endTime * 1000).toDateString() !== new Date(now).toDateString()) return null;
  let rest = "";
  if (session.diff != null) {
    const d = Math.round(session.diff);
    rest = d > 0 ? ` · ${d} above your usual` : d < 0 ? ` · ${-d} below your usual` : " · at your usual";
  }
  return { wdl: fmtWdl(session.wdl), rest };
}

function todayText(session, now) {
  const t = todayParts(session, now);
  return t && `Today: ${t.wdl}${t.rest}`;
}

// "Shadow 2165 · +65 vs official · +40 in 90 days" from the 90-day window, plus its flags
function shadowLine(w) {
  if (!w || w.empty || w.noRated) return null;
  const r = Math.round;
  // level and rest are the same line in parts, so the number can be bold
  const level = String(r(w.shadow.now));
  const rest = ` · ${signedMinus(r(w.shadow.now - w.official.now))} vs official · ${signedMinus(r(w.shadow.change))} in 90 days`;
  return { text: `Shadow ${level}${rest}`, level, rest, flags: w.flags };
}

// "You're expected to score 69% · h2h 506–187 (73%)", from the left player's side.
// h2h: the filtered head-to-head, null while it's still loading (pending) or unknown
// parts: { lead: "You're expected to score ", pct: "69%", tail: " · h2h 506–187 (73%)" }
function predictionParts(name, expected, h2h, pending) {
  const who = name === "You" ? "You're" : `${name} is`;
  let tail = "";
  if (h2h?.total) {
    const a = h2h.aWins + h2h.draws / 2;
    tail = ` · h2h ${fmtScore(a)}–${fmtScore(h2h.total - a)} (${pct(a / h2h.total)})`;
  } else if (h2h) {
    tail = " · no h2h games yet";
  } else if (pending) {
    tail = " · h2h loading…";
  }
  return { lead: `${who} expected to score `, pct: pct(expected), tail };
}

function predictionText(name, expected, h2h, pending) {
  const p = predictionParts(name, expected, h2h, pending);
  return p.lead + p.pct + p.tail;
}

// the "More details" table, one column per player: games, win/draw/loss %, peak and average
// opponent over the last 90 days. games: one time class, rated and unrated, any order
const FORM_DAYS = 90;
function recentForm(games, now) {
  const since = now / 1000 - FORM_DAYS * 86400;
  const recent = games.filter((g) => g.t >= since);
  if (!recent.length) return { games: "0", wdl: "—", peak: "—", avgOpp: "—" };
  const t = wdl(recent);
  const share = (n) => Math.round((n / recent.length) * 100);
  const rated = recent.filter((g) => g.rated);
  const opps = recent.map((g) => g.oppPre ?? g.oppRating).filter((x) => x != null);
  return {
    games: fmtCount(recent.length),
    wdl: `${share(t.w)} · ${share(t.d)} · ${share(t.l)}%`,
    // ratings after each rated game: the highest one reached
    peak: rated.length ? String(Math.max(...rated.map((g) => g.rating))) : "—",
    avgOpp: opps.length ? String(Math.round(opps.reduce((a, b) => a + b, 0) / opps.length)) : "—",
  };
}

// a table cell's worth of stability: "Stable (1.4)", "Shifting (2.8)"
function stabilityShort(st) {
  if (!st || st.reason) return "—";
  const ratio = st.ratio < 1 ? st.ratio.toFixed(2) : st.ratio.toFixed(1);
  return `${st.stability === 1 ? "Stable" : "Shifting"} (${ratio})`;
}

// "When you play each other: You 1917 vs legendary9000 1781 (±83)"
function matchupLine(a, b, primary, blended) {
  const say = (n) => (n === primary ? "You" : n);
  const when = a === primary || b === primary ? "When you play each other" : `When ${a} and ${b} play each other`;
  return `${when}: ${say(a)} ${Math.round(blended.me)} vs ${say(b)} ${Math.round(blended.opp)} (±${Math.round(blended.error)})`;
}

// "Last 30 days: 5W 1D 2L (8 games, 5.5–2.5)", from the left player's side
function last30Text(t) {
  if (!t.total) return "Last 30 days: no games";
  const a = t.aWins + t.draws / 2;
  return `Last 30 days: ${fmtCount(t.aWins)}W ${fmtCount(t.draws)}D ${fmtCount(t.bWins)}L (${plural(t.total, "game")}, ${fmtScore(a)}–${fmtScore(t.total - a)})`;
}

// RACE_CONFIG lives in race.js. in the pages it's a global, in node it's required
if (typeof RACE_CONFIG === "undefined" && typeof require !== "undefined") {
  globalThis.RACE_CONFIG = require("./race.js").RACE_CONFIG;
}

if (typeof module !== "undefined") {
  module.exports = {
    currentLevel, officialText, inactiveText, todayText, todayParts, shadowLine, predictionText, predictionParts,
    matchupLine, last30Text, recentForm, stabilityShort,
    signedMinus, stabilityText, parseRange, rangeLabel, timeAgo,
  };
}
