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
  // the newest rated game: breaks a confidence tie when picking the matchup's anchor
  const lastRatedT = filterGames(all, { timeClass, rated: "rated" })[0]?.t ?? null;

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
    lastRatedT,
    // last 90 days in this time class, rated and unrated, every opponent
    form: form90(filterGames(all, { timeClass, rated: "all" }), now),
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

// --- the Compare view ---

const AGAINST_MIN_GAMES = 5; // fewer games together than this: no "Against each other" section
const BLEND_GAMES = 30; // the head-to-head counts for half the gap at 30 games together
const FORM_DAYS = 90;
const CONF_RANK = { Low: 0, Medium: 1, High: 2 };

// last 90 days, all opponents, as numbers. games: one time class, rated and unrated, any order.
// score counts a draw as half a point. peak = highest rating after a rated game
function form90(games, now) {
  const since = now / 1000 - FORM_DAYS * 86400;
  const recent = games.filter((g) => g.t >= since);
  const t = wdl(recent);
  const rated = recent.filter((g) => g.rated);
  const opps = recent.map((g) => g.oppPre ?? g.oppRating).filter((x) => x != null);
  const n = recent.length;
  return {
    games: n,
    score: n ? (t.w + t.d / 2) / n : null,
    drawRate: n ? t.d / n : null,
    avgOpp: opps.length ? opps.reduce((a, b) => a + b, 0) / opps.length : null,
    peak: rated.length ? Math.max(...rated.map((g) => g.rating)) : null,
  };
}

// the gap the win chance uses. under 5 games together: current performance only. after
// that the head-to-head gap G counts more the more they've played: w = n / (n + 30)
function blendedGap(n, G, currentGap) {
  if (n < AGAINST_MIN_GAMES || G == null) return currentGap;
  const w = n / (n + BLEND_GAMES);
  return w * G + (1 - w) * currentGap;
}

// expected score (a draw = half a point) split into win / draw / loss with the draw rate:
// win = E - D/2, loss = 1 - E - D/2. whole percents, never below 0
function winChance(expected, drawRate) {
  const whole = (x) => Math.round(Math.max(0, x) * 100);
  return { win: whole(expected - drawRate / 2), draw: whole(drawRate), loss: whole(1 - expected - drawRate / 2) };
}

// whose performance the matchup hangs on: the one with higher confidence, from games NOT
// against each other (field ratings). same confidence: the one with the more recent rated
// game. a: { perf, conf, lastRatedT }. returns 0, 1, or null when neither has a performance
function pickAnchor(a, b) {
  const rank = (f) => (f?.perf != null ? CONF_RANK[f.conf?.label] ?? 0 : -1);
  const [ra, rb] = [rank(a), rank(b)];
  if (ra !== rb) return ra > rb ? 0 : 1;
  if (ra < 0) return null;
  return (a.lastRatedT ?? 0) >= (b.lastRatedT ?? 0) ? 0 : 1;
}

// both players' levels against each other: the anchor at its field rating, the other at
// anchor -/+ G. error: the anchor's and the gap's together
function matchupLevels(fields, gap) {
  const i = pickAnchor(fields[0], fields[1]);
  if (i == null || !gap) return null;
  const anchor = fields[i].perf;
  return {
    anchor: i,
    levels: i === 0 ? [anchor, anchor - gap.G] : [anchor + gap.G, anchor],
    error: Math.sqrt(fields[i].error ** 2 + gap.error ** 2),
  };
}

// who's ahead and by how much: { who: "You", by: 413 }, { who: null } for level, null if
// one side is missing
function leadOf(names, a, b) {
  if (a == null || b == null) return null;
  const d = Math.round(a - b);
  if (!d) return { who: null, by: 0 };
  return d > 0 ? { who: names[0], by: d } : { who: names[1], by: -d };
}

// "You lead by +413 official · +293 performance" as parts: every odd one is bold.
// a different leader on performance gets named: "You lead by +40 official · x +12 performance"
function leadParts(names, official, perf) {
  const leads = (who) => `${who} ${who === "You" ? "lead" : "leads"} by `;
  // plain text joins the plain text before it, so bold parts stay at odd indexes
  const out = [""];
  const plain = (text) => (out[out.length - 1] += text);
  const bold = (text) => out.push(text, "");
  if (official?.who) {
    plain(leads(official.who));
    bold(`+${official.by}`);
    plain(" official");
  } else if (official) plain("Level on official");
  if (perf) {
    if (official) plain(" · ");
    if (!perf.who) plain(official ? "level on performance" : "Level on performance");
    else {
      if (official?.who !== perf.who) plain(official ? `${perf.who} ` : leads(perf.who));
      bold(`+${perf.by}`);
      plain(" performance");
    }
  }
  return out;
}

// "Your results swing more than luck explains", "legendary9000 is steady"
function consistencyText(name, st) {
  const you = name === "You";
  if (!st || st.reason) return `Not enough sessions to tell for ${you ? "you" : name}`;
  if (st.stability === 1) return you ? "You're steady" : `${name} is steady`;
  return `${you ? "Your" : `${name}'s`} results swing more than luck explains`;
}

// everything the Compare view says, from the left player's side. pure, so it's tested as is.
//   names: ["You", "legendary9000"] (or two usernames when spectating)
//   perfs: [{ perf, official, conf, stability, lastRatedT, field, form }] (loadPerformance)
//   h2h: the filtered head-to-head ({ total, aWins, draws, bWins, last30 }), or null
//   gap: matchupGap() of the head-to-head games, or null
function compareSummary({ names, perfs, h2h, gap }) {
  const [a, b] = perfs;
  const you = names[0] === "You";
  const n = h2h?.total ?? 0;

  // the current-performance gap, or official when there's no performance to go on
  const levelOf = (p) => p?.perf ?? p?.official ?? null;
  const currentGap = levelOf(a) != null && levelOf(b) != null ? levelOf(a) - levelOf(b) : null;
  const together = n >= AGAINST_MIN_GAMES && gap;
  const g = currentGap == null ? (together ? gap.G : null) : blendedGap(together ? n : 0, gap?.G, currentGap);
  const expected = g == null ? null : 1 / (1 + Math.pow(10, -g / 400));

  // draw rate: both players' last 90 days averaged, or whoever has games
  const rates = perfs.map((p) => p?.form?.drawRate).filter((x) => x != null);
  const drawRate = rates.length ? rates.reduce((x, y) => x + y, 0) / rates.length : 0;
  const chance = expected == null ? null : winChance(expected, drawRate);

  let against = null;
  if (n >= AGAINST_MIN_GAMES) {
    const m = gap ? matchupLevels([{ ...a?.field, lastRatedT: a?.lastRatedT }, { ...b?.field, lastRatedT: b?.lastRatedT }], gap) : null;
    const r = Math.round;
    const scored = (h2h.aWins + h2h.draws / 2) / n;
    // parts: every odd one is bold
    against = {
      title: `Against each other · ${plural(n, "game")}`,
      levels: m && [`${you ? "You play" : `${names[0]} plays`} at `, String(r(m.levels[0])), " vs ", String(r(m.levels[1])), ` (±${r(m.error)})`],
      scored: [`${you ? "You've" : `${names[0]} has`} scored `, pct(scored), expected == null ? "" : ` · expected ${pct(expected)}`],
    };
  }

  // more details, as sentences
  const played = (name, f, first) => {
    if (!f?.games) return `${name} played no games`;
    return `${name} played ${plural(f.games, "game")} and scored ${pct(f.score)}${first ? " of points" : ""}`;
  };
  const opp = (x) => (x == null ? "—" : String(Math.round(x)));
  const last30 = h2h?.last30;
  const forWho = you ? "you" : names[0];
  let last30Line = null;
  if (n >= 1) {
    const pts = last30?.total ? last30.aWins + last30.draws / 2 : 0;
    last30Line = last30?.total
      ? `Last 30 days: ${fmtScore(pts)}–${fmtScore(last30.total - pts)} for ${forWho} (${plural(last30.total, "game")})`
      : "Last 30 days: no games";
  }

  const leads = [leadOf(names, a?.official, b?.official), leadOf(names, a?.perf, b?.perf)];
  return {
    official: [a?.official ?? null, b?.official ?? null],
    current: perfs.map((p) => (p?.perf == null ? null : { perf: p.perf, label: p.conf?.label ?? "Low" })),
    lead: leadParts(names, ...leads),
    // the bold numbers in the lead line, in the leader's color: "y" (left) or "o" (right)
    leadSides: leads.filter((l) => l?.who).map((l) => (l.who === names[0] ? "y" : "o")),
    against,
    chance,
    win: chance && `Win chance: ${names[0]} ${chance.win}% · draw ${chance.draw}% · ${names[1]} ${chance.loss}%`,
    basedOn: n >= AGAINST_MIN_GAMES ? `Based on current performance and ${plural(n, "game")} together` : "Based on current performance",
    more: {
      form: [
        played(names[0], a?.form, true),
        played(names[1], b?.form, false),
        `Average opponent: ${opp(a?.form?.avgOpp)} for ${forWho}, ${opp(b?.form?.avgOpp)} for ${you ? "them" : names[1]}`,
      ],
      consistency: names.map((name, i) => consistencyText(name, perfs[i]?.stability)),
      against: last30Line,
    },
  };
}

// RACE_CONFIG lives in race.js. in the pages it's a global, in node it's required
if (typeof RACE_CONFIG === "undefined" && typeof require !== "undefined") {
  globalThis.RACE_CONFIG = require("./race.js").RACE_CONFIG;
}

if (typeof module !== "undefined") {
  module.exports = {
    currentLevel, officialText, inactiveText, todayText, todayParts, shadowLine,
    form90, blendedGap, winChance, pickAnchor, matchupLevels, leadOf, leadParts, consistencyText, compareSummary,
    signedMinus, stabilityText, parseRange, rangeLabel, timeAgo, fieldRating,
  };
}
