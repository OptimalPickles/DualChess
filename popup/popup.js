// flow: scrape tab -> fair play lock (in-progress game = show nothing) -> get/ask primary ->
// figure out mode -> render() from cache right away,
// then sync() from chess.com in the background (and every 60s), re-rendering only on changes
// logs start with "[Performance]". popup logs: right-click icon > Inspect popup.
// scrapeChessPage logs show in the chess.com tab's own console

// Key used in chrome.storage.local to remember "you" between popup opens
const STORAGE_KEY_PRIMARY_USERNAME = "primaryUsername";
const RECENT_GAMES_SHOWN = 5;
const SETTINGS_KEY = "perfSettings";
const DEFAULT_SETTINGS = { time: "auto", range: "games:20", rated: "all" };
const SESSION_RANGE = { type: "session" };
const REFRESH_MS = 60 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

// what init() found, reused by every render and sync
let current = null;
let refreshTimer = null;
let refreshDelay = REFRESH_MS;

// runs inside the chess.com tab, can't use anything outside this function
function scrapeChessPage() {
  // Map instead of array so adding the same username twice merges into one entry instead of creating a duplicate.
  const candidates = new Map();

  const addCandidate = (rawUsername, ratingOnPage = null) => {
    if (!rawUsername) return;
    const username = rawUsername.trim().toLowerCase();
    if (!username) return;

    const existing = candidates.get(username);
    if (existing) {
      // keep a rating if a later source has one
      if (existing.ratingOnPage == null && ratingOnPage != null) {
        existing.ratingOnPage = ratingOnPage;
      }
    } else {
      candidates.set(username, { username, ratingOnPage });
    }
  };

  // Only present on profile pages, always in the clean form
  // "https://www.chess.com/member/<username>"
  // most reliable
  const canonicalHref =
    document.querySelector('link[rel="canonical"]')?.href || "";
  const canonicalMatch = canonicalHref.match(/\/member\/([^/?#]+)/i);
  if (canonicalMatch) {
    addCandidate(canonicalMatch[1]);
  }

  // og:title
  //   game:    "Chess: FM puz2010 vs GM Hikaru"
  //   profile: "GM Hikaru Nakamura (Hikaru) - Chess Profile" or "lethalspider7 - Chess Profile"
  const ogTitle =
    document.querySelector('meta[property="og:title"]')?.content || "";

  const vsMatch = ogTitle.match(/^Chess:\s*(.+?)\s+vs\s+(.+)$/i);
  if (vsMatch) {
    // titles are one word and usernames have no spaces, so last word = username
    [vsMatch[1], vsMatch[2]].forEach((side) => {
      const words = side.trim().split(/\s+/);
      addCandidate(words[words.length - 1]);
    });
  }

  const profileMatch = ogTitle.match(/^(.+?)\s*-\s*Chess Profile$/i);
  if (profileMatch) {
    // "(username)" at the end is the real username, otherwise the whole thing is
    const parenMatch = profileMatch[1].match(/\(([^)]+)\)\s*$/);
    addCandidate(parenMatch ? parenMatch[1] : profileMatch[1]);
  }

  // description, adds ratings: "FM puz2010 (3008) vs GM Hikaru (3366). Game drawn..."
  const description =
    document.querySelector('meta[name="description"]')?.content || "";
  const descMatch = description.match(/^(.+?)\s+vs\s+(.+?)\.\s/i);
  if (descMatch) {
    [descMatch[1], descMatch[2]].forEach((side) => {
      const ratingMatch = side.match(/\(([\d,]+)\)\s*$/);
      const namePart = ratingMatch ? side.slice(0, ratingMatch.index) : side;
      const words = namePart.trim().split(/\s+/);
      const rating = ratingMatch
        ? Number(ratingMatch[1].replace(/,/g, ""))
        : null;
      addCandidate(words[words.length - 1], rating);
    });
  }

  // fallback: chess.com's user tagline component in the rendered page
  document.querySelectorAll("[data-username]").forEach((el) => {
    addCandidate(el.getAttribute("data-username"));
  });
  document
    .querySelectorAll('[data-test-element="user-tagline-username"]')
    .forEach((el) => {
      addCandidate(el.textContent);
    });

  const result = { playersOnPage: Array.from(candidates.values()), canonicalHref };
  console.log("[Performance] scrapeChessPage() found:", result);
  return result;
}

// null if the active tab isn't chess.com
async function getActiveChessTabData() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes("chess.com")) {
    return null;
  }

  // one result per frame, only need the top one
  const [{ result: scraped }] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: scrapeChessPage,
  });

  return { tab, scraped };
}

// pick a found username or type one. resolves with the username
function askWhoIsPrimary(candidates) {
  return new Promise((resolve) => {
    const box = document.getElementById("who-are-you");
    const text = document.getElementById("who-are-you-text");
    const candidatesEl = document.getElementById("who-are-you-candidates");
    const input = document.getElementById("who-are-you-input");
    const saveBtn = document.getElementById("who-are-you-save");

    candidatesEl.innerHTML = "";
    input.value = "";

    text.textContent = candidates.length
      ? "Which of these is you? (Or type your username below.)"
      : "Couldn't find any usernames on this page - type yours below.";

    // is-loading blocks clicks, so drop it while waiting on the user or the picker is dead
    document.body.classList.remove("is-loading");

    const finish = (username) => {
      console.log(`[Performance] askWhoIsPrimary(): user picked "${username}".`);
      box.hidden = true;
      document.body.classList.add("is-loading");
      resolve(username);
    };

    candidates.forEach((candidate) => {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = candidate.ratingOnPage
        ? `${candidate.username} (${candidate.ratingOnPage})`
        : candidate.username;
      btn.addEventListener("click", () => finish(candidate.username));
      candidatesEl.appendChild(btn);
    });

    // once: true so repeat calls don't stack listeners
    saveBtn.addEventListener(
      "click",
      () => {
        const typed = input.value.trim().toLowerCase();
        if (!typed) {
          console.log("[Performance] Save clicked with an empty username - ignored.");
          return;
        }
        finish(typed);
      },
      { once: true }
    );

    box.hidden = false;
    console.log(
      `[Performance] askWhoIsPrimary(): showing picker with ${candidates.length} candidate(s).`,
      candidates
    );
    input.focus();
  });
}

// saved username, or ask + save it
async function getPrimaryUsername(candidates) {
  const stored = await chrome.storage.local.get(STORAGE_KEY_PRIMARY_USERNAME);
  const saved = stored[STORAGE_KEY_PRIMARY_USERNAME] || null;

  if (saved) {
    console.log(`[Performance] Using saved primary username: "${saved}".`);
    return saved;
  }

  console.log("[Performance] No saved primary username yet - asking.");
  const chosen = await askWhoIsPrimary(candidates);

  await chrome.storage.local.set({ [STORAGE_KEY_PRIMARY_USERNAME]: chosen });

  // read back to prove it saved
  const verify = await chrome.storage.local.get(STORAGE_KEY_PRIMARY_USERNAME);
  console.log(
    "[Performance] Saved primary username. Now in storage:",
    verify[STORAGE_KEY_PRIMARY_USERNAME]
  );

  return chosen;
}

// playing / spectating / profile / none, based on whether you're on the page
function resolveMode(primaryUsername, playersOnPage) {
  const isPlaying = playersOnPage.some((p) => p.username === primaryUsername);
  const others = playersOnPage.filter((p) => p.username !== primaryUsername);

  let mode;
  if (isPlaying) mode = "playing";
  else if (others.length >= 2) mode = "spectating"; // primary stays the same
  else if (others.length === 1) mode = "profile";
  else mode = "none";

  console.log(`[Performance] resolveMode(primary="${primaryUsername}") ->`, { mode, others });
  return { mode, others };
}

function renderPlayer(container, label, username, data) {
  if (!container) return;

  if (!username) {
    container.textContent = "";
    return;
  }

  if (!data) {
    container.textContent = `${label}: ${username} — couldn't load stats from chess.com's API.`;
    return;
  }

  // missing if they've never played that format
  const rapid = data.stats.chess_rapid?.last?.rating ?? "—";
  const blitz = data.stats.chess_blitz?.last?.rating ?? "—";
  const bullet = data.stats.chess_bullet?.last?.rating ?? "—";
  const daily = data.stats.chess_daily?.last?.rating ?? "—";

  container.textContent = `${label}: ${username} — rapid: ${rapid}, blitz: ${blitz}, bullet: ${bullet}, daily: ${daily}`;
}

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

// "auto": the game on the page, else the last game between the two, else /stats.
// /stats is only meant for profile pages, the rest just land there if nothing else works
async function resolveTimeClass(settings, results) {
  const opt = { cacheOnly: true };
  if (settings.time !== "auto") return { timeClass: settings.time, source: null };

  const { mode, gameRecord, pair } = current;
  // a finished game on the page: its own record, found by id when the lock was checked
  if (gameRecord) return { timeClass: gameRecord.timeClass, source: "this game" };
  if (mode === "playing" || mode === "spectating") {
    const tc = await latestHeadToHeadTimeClass(pair[0], pair[1], opt);
    if (tc) return { timeClass: tc, source: "last game between them" };
  }

  const tc = pickTimeClass(results[0]?.stats) ?? pickTimeClass(results[1]?.stats);
  return { timeClass: tc, source: "most played lately" };
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

// session storage so it lasts until the browser closes, not just this popup
async function getTallyStart(username) {
  const key = `tallyStart:${username}`;
  const saved = (await chrome.storage.session.get(key))[key];
  if (saved) return saved;
  const start = Date.now();
  await chrome.storage.session.set({ [key]: start });
  return start;
}

function wdl(games) {
  const t = { w: 0, d: 0, l: 0 };
  for (const g of games) {
    if (g.score === 1) t.w++;
    else if (g.score === 0) t.l++;
    else t.d++;
  }
  return t;
}

async function loadPerformance(username, data, now, settings, timeClass) {
  if (!timeClass) return null;

  const opts = { timeClass, rated: settings.rated };
  const range = parseRange(settings.range);
  const tallyStart = await getTallyStart(username);

  // the newest 6 months, from storage. sync() keeps all 6 loaded, so any range,
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

  const tallyGames = filtered.filter((g) => g.t * 1000 >= tallyStart);

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
    tally: { start: tallyStart, count: tallyGames.length, wdl: wdl(tallyGames) },
    // for "only 7 of 20 found since ..."
    requested: range.type === "games" ? range.n : null,
    searchedSince: all.length ? Math.min(...all.map((g) => g.t)) : null,
  };
  console.log(`[Performance] loadPerformance("${username}"):`, result);
  return result;
}

function timeAgo(t, now) {
  const mins = Math.round((now / 1000 - t) / 60);
  if (mins < 60) return `${mins}m ago`;
  if (mins < 48 * 60) return `${Math.round(mins / 60)}h ago`;
  return `${Math.round(mins / 1440)}d ago`;
}

const signed = (n) => `${n >= 0 ? "+" : ""}${n}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const fmtWdl = (t) => `${t.w}W ${t.d}D ${t.l}L`;

// fully stable (ratio <= 1.5) or not. anything above 1.5 is already losing stability
function stabilityText(st) {
  if (!st || st.reason) return "Not enough sessions to judge stability";
  const ratio = st.ratio < 1 ? st.ratio.toFixed(2) : st.ratio.toFixed(1);
  return st.stability === 1
    ? `Stable across ${st.sessions} sessions (ratio ${ratio})`
    : `Level is shifting (ratio ${ratio})`;
}

// appends under the player's card, after renderPlayer
function renderPerformance(container, p, now) {
  if (!container) return;
  const line = (text, className) => {
    const el = document.createElement("p");
    el.textContent = text;
    el.className = className;
    container.appendChild(el);
  };

  if (!p) {
    line("Couldn't load performance.", "perf-sub");
    return;
  }

  const shortDate = (t) => {
    const d = new Date(t * 1000);
    const sameYear = d.getFullYear() === new Date(now).getFullYear();
    return d.toLocaleDateString([], { month: "short", day: "numeric", ...(sameYear ? {} : { year: "numeric" }) });
  };

  if (p.count) {
    // low confidence: number and diff go grey, not worth reading much into
    const lowClass = p.conf.label === "Low" ? "low-conf" : "";
    const main = document.createElement("p");
    main.className = "perf-main";
    const part = (text, className = "") => {
      const span = document.createElement("span");
      span.textContent = text;
      span.className = className;
      main.appendChild(span);
    };
    part(`Performance (${p.timeClass}, ${rangeLabel(p.range)}): `);
    part(`${p.perf} ± ${Math.round(p.error)}`, lowClass);
    if (p.official != null) {
      part(` · official ${p.official} `);
      part(`(${signed(p.perf - p.official)})`, lowClass);
    }
    container.appendChild(main);

    line(
      `${p.conf.label} confidence (${pct(p.conf.value)}) · freshness ${pct(p.conf.freshness)} · ` +
        `${p.count} game${p.count === 1 ? "" : "s"} · last game ${timeAgo(p.lastEndTime, now)}`,
      "perf-sub"
    );
  }

  // asked for n games, got fewer: say how many and how far back we looked
  if (p.requested && p.count < p.requested) {
    const since = p.searchedSince ? ` since ${shortDate(p.searchedSince)}` : "";
    line(
      p.count
        ? `Only ${p.count} of ${p.requested} ${p.timeClass} games found${since}.`
        : `No ${p.timeClass} games found${since}.`,
      "perf-sub"
    );
  } else if (!p.count) {
    line(`No ${p.timeClass} games in ${rangeLabel(p.range)}.`, "perf-sub");
  }

  line(stabilityText(p.stability), "perf-sub");

  if (p.session) {
    const s = p.session;
    const status = s.active
      ? `active, last game ${timeAgo(s.endTime, now)}`
      : `ended ${timeAgo(s.endTime, now)}`;
    const diff =
      s.diff == null
        ? "no earlier games to compare"
        : `${signed(s.diff)} vs ${rangeLabel(p.range)} before it`;
    line(
      `Session: ${s.perf} ± ${Math.round(s.error)} · ${fmtWdl(s.wdl)} · ${status} · ${diff}`,
      "perf-sub"
    );
  }

  const since = new Date(p.tally.start).toLocaleString([], {
    month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  line(`Since ${since}: ${p.tally.count ? fmtWdl(p.tally.wdl) : "no games yet"}`, "perf-sub");
}

// perf if we trust it (Medium/High), otherwise official
function ratingFor(p) {
  if (p?.perf != null && (p.conf?.label === "High" || p.conf?.label === "Medium")) {
    return { rating: p.perf, source: "performance" };
  }
  if (p?.official != null) return { rating: p.official, source: "official" };
  return null;
}

// expected score for entries[0] vs entries[1]
function matchupPrediction(entries, perfs) {
  const a = ratingFor(perfs[0]);
  const b = ratingFor(perfs[1]);
  if (!a || !b) return null;
  return {
    a: { username: entries[0].username, ...a },
    b: { username: entries[1].username, ...b },
    expected: expectedScore(a.rating, b.rating),
  };
}

// h2h is null until the scan finishes, then this runs again with it
// pending = the h2h scan hasn't finished yet
function renderPrediction(container, pred, h2h, pending) {
  container.innerHTML = "";
  if (!pred) return;
  const line = (text, className) => {
    const el = document.createElement("p");
    el.textContent = text;
    if (className) el.className = className;
    container.appendChild(el);
  };

  let h2hText = pending ? " · h2h loading…" : " · h2h unavailable";
  if (h2h?.total) {
    const actual = (h2h.aWins + h2h.draws / 2) / h2h.total;
    h2hText = ` · h2h actual ${pct(actual)} (${h2h.total} games)`;
  } else if (h2h) {
    h2hText = " · no h2h games yet";
  }
  line(`${pred.a.username}: expected ${pct(pred.expected)}${h2hText}`, "h2h-title");
  line(
    `${pred.a.username} ${pred.a.rating} (${pred.a.source}) vs ${pred.b.username} ${pred.b.rating} (${pred.b.source})`,
    "h2h-sub"
  );

  const v = h2h?.vsRatings;
  if (v?.games) {
    const diff = v.actual - v.expected;
    line(
      `h2h score ${v.actual} vs ${v.expected.toFixed(1)} expected from ratings at the time (${diff >= 0 ? "+" : ""}${diff.toFixed(1)})`,
      "h2h-sub"
    );
  }
}

// h2h narrowed to the dropdowns (standard chess, one time class, rated toggle),
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

// everything is from h2h.a's side
function renderHeadToHead(container, h2h, pending) {
  container.innerHTML = "";
  const line = (text, className) => {
    const p = document.createElement("p");
    p.textContent = text;
    if (className) p.className = className;
    container.appendChild(p);
    return p;
  };

  if (!h2h) {
    line(pending ? "Loading head-to-head…" : "Couldn't load head-to-head games.");
    return;
  }
  const filterText = `${h2h.opts.timeClass}${h2h.opts.rated === "all" ? "" : `, ${h2h.opts.rated}`}`;
  if (!h2h.total) {
    // say if there are games, just not in this time class / rated setting
    const other = h2h.allTotal ? ` (${h2h.allTotal} in other settings)` : "";
    line(`No ${filterText} games between ${h2h.a} and ${h2h.b}${other}.`);
    return;
  }

  const pct = (n, total) => Math.round((n / total) * 100);
  // chess score: win 1, draw 0.5
  const score = (t) => `${t.aWins + t.draws / 2}–${t.bWins + t.draws / 2}`;

  line(`${h2h.a} vs ${h2h.b} · ${filterText}`, "h2h-title");
  line(`${h2h.total} games · score ${score(h2h)}`);
  line(
    `${h2h.a} wins ${h2h.aWins} (${pct(h2h.aWins, h2h.total)}%) · ` +
      `draws ${h2h.draws} (${pct(h2h.draws, h2h.total)}%) · ` +
      `${h2h.b} wins ${h2h.bWins} (${pct(h2h.bWins, h2h.total)}%)`
  );

  const t = h2h.last30;
  line(
    t.total
      ? `Last 30 days: ${t.aWins}W ${t.draws}D ${t.bWins}L (${t.total} games, ${score(t)})`
      : "Last 30 days: no games",
    "h2h-sub"
  );

  const recent = document.createElement("ul");
  recent.className = "h2h-recent";
  for (const g of h2h.games.slice(0, RECENT_GAMES_SHOWN)) {
    const result = g.score === 1 ? "W" : g.score === 0 ? "L" : "D";
    const date = new Date(g.t * 1000).toLocaleDateString();
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = gameUrl(g);
    a.target = "_blank";
    a.textContent = `${result} · ${g.timeClass} · ${date}`;
    li.appendChild(a);
    recent.appendChild(li);
  }
  container.appendChild(recent);
}

// "3:42 PM" today, "Sep 30, 3:42 PM" before that
function formatAsOf(ms, now) {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (d.toDateString() === new Date(now).toDateString()) return time;
  return `${d.toLocaleDateString([], { month: "short", day: "numeric" })}, ${time}`;
}

// --- render from cache, sync from chess.com -------------------------------
// render() never touches the network. it builds everything from storage and only
// redraws when the numbers changed. sync() is the only thing that makes requests,
// and it calls render() once new data is saved.

// everything the popup shows, from storage alone
async function buildView() {
  const { entries, pair, mode } = current;
  const opt = { cacheOnly: true };
  const settings = await loadSettings();
  const results = await Promise.all(entries.map((entry) => fetchStats(entry.username, opt)));
  const { timeClass, source } = await resolveTimeClass(settings, results);

  const now = Date.now();
  const perfs = await Promise.all(
    entries.map((entry, i) => loadPerformance(entry.username, results[i], now, settings, timeClass))
  );
  // only when two people are actually playing each other
  const pred =
    mode === "playing" || mode === "spectating" ? matchupPrediction(entries, perfs) : null;
  const h2hAll = pair ? await fetchHeadToHead(pair[0], pair[1], () => {}, opt) : null;
  const h2h = filterHeadToHead(h2hAll, { timeClass, rated: settings.rated }, now);

  // the older of the players' last confirmed times, so it never claims more than the staler card
  const asOfs = await Promise.all(entries.map((entry) => dataAsOf(entry.username)));
  const asOf = asOfs.every((t) => t != null) ? Math.min(...asOfs) : null;

  // complete = every card has real numbers, not "not loaded yet"
  const complete = results.every(Boolean) && perfs.every(Boolean);
  return { settings, results, timeClass, source, now, perfs, pred, h2h, asOf, complete };
}

// the numbers on screen, minus anything that only moves because the clock moved,
// so "changed" means the data changed
function viewSignature(view) {
  const ratings = (r) =>
    r && ["bullet", "blitz", "rapid", "daily"].map((tc) => r.stats[`chess_${tc}`]?.last?.rating ?? null);
  const perf = (p) =>
    p && {
      perf: p.perf, error: Math.round(p.error ?? 0), count: p.count, last: p.lastEndTime,
      label: p.conf?.label, stability: p.stability?.ratio, official: p.official,
      session: p.session && [p.session.perf, p.session.wdl, p.session.endTime, p.session.active],
      tally: [p.tally.start, p.tally.count, p.tally.wdl],
    };
  const h = view.h2h;
  return JSON.stringify({
    settings: view.settings, timeClass: view.timeClass, source: view.source,
    h2hSynced: Boolean(current.h2hSynced),
    // to the minute, so a sync that only confirmed nothing changed still moves the time
    asOf: view.asOf == null ? null : Math.floor(view.asOf / 60000),
    stats: view.results.map(ratings),
    perfs: view.perfs.map(perf),
    h2h: h && [h.total, h.aWins, h.draws, h.bWins, h.last30.total, h.games[0]?.t ?? null],
  });
}

let renderGen = 0;
let lastSignature = null;

// final = sync has run, so missing numbers are real failures, not "still loading".
// returns true if the cards are showing numbers
async function render({ final = false } = {}) {
  if (!current) return false;
  const gen = ++renderGen;
  const view = await buildView();
  // a newer render started while this one was reading storage
  if (gen !== renderGen) return false;
  // nothing cached yet: keep "loading" up rather than empty cards
  if (!view.complete && !final) return false;

  const signature = viewSignature(view);
  if (signature === lastSignature) return true;
  lastSignature = signature;
  console.log("[Performance] render:", view);

  const { entries, pair } = current;
  const { timeClass, source, results, perfs, pred, h2h, now } = view;
  document.querySelector('#ctl-time option[value="auto"]').textContent =
    timeClass && source ? `auto (${timeClass}, ${source})` : "auto";

  const containers = [
    document.getElementById("primary-info"),
    document.getElementById("opponent-info"),
  ];
  // an unused card gets cleared by renderPlayer
  containers.forEach((container, i) => {
    renderPlayer(container, entries[i]?.label, entries[i]?.username, results[i]);
    if (entries[i]) renderPerformance(container, perfs[i], now);
  });
  document.getElementById("data-as-of").textContent = view.asOf ? `Data as of ${formatAsOf(view.asOf, now)}` : "";

  const pending = Boolean(pair) && !h2h && !current.h2hSynced;
  renderPrediction(document.getElementById("prediction"), pred, h2h, pending);
  if (pair) renderHeadToHead(document.getElementById("h2h"), h2h, pending);

  // dropdowns work during the h2h scan
  document.body.classList.remove("is-loading");
  return true;
}

let syncGen = 0;

// the only place that asks chess.com for anything (besides the fair play check): /stats,
// the newest 6 months of each player, and the h2h months. mostly 304s after the first time.
// stats -> recent games -> render -> head-to-head -> render
async function sync() {
  if (!current) return;
  const gen = ++syncGen;
  const stale = () => gen !== syncGen;
  clearTimeout(refreshTimer);

  const { entries, pair, baseStatus } = current;
  const statusEl = document.getElementById("status");
  let ok = true;

  try {
    const stats = await Promise.all(entries.map((entry) => fetchStats(entry.username)));
    const games = await Promise.all(entries.map((entry) => fetchPlayerGames(entry.username, () => true)));
    if (stale()) return;
    ok = stats.every(Boolean) && games.every(Boolean);
    statusEl.textContent = baseStatus;
    await render({ final: true });

    if (pair) {
      // a first scan can be dozens of months. a reopen is just this month, no need to say so
      const onProgress = (done, total) => {
        if (total > 1 && !stale()) statusEl.textContent = `${baseStatus} Scanning games ${done}/${total} months…`;
      };
      const h2h = await fetchHeadToHead(pair[0], pair[1], onProgress);
      if (stale()) return;
      ok = ok && Boolean(h2h);
      current.h2hSynced = true;
      statusEl.textContent = baseStatus;
      await render({ final: true });
    }
  } catch (err) {
    if (stale()) return;
    ok = false;
    console.error("[Performance] sync failed:", err);
    document.body.classList.remove("is-loading");
  }

  // a stale sync returned above, so only the newest one schedules the next
  refreshDelay = ok ? REFRESH_MS : Math.min(refreshDelay * 2, MAX_BACKOFF_MS);
  if (!ok) console.warn(`[Performance] sync had failures, next one in ${refreshDelay / 1000}s`);
  refreshTimer = setTimeout(() => sync(), refreshDelay);
}

// bumped by every init(). a tab change mid-way means an older init stops where it is
let initGen = 0;
// game ids whose stored months were already searched once, see findGameInArchive
const scannedGames = new Set();

// fair play lock: every view is replaced by one line, and the only thing still running
// is the lock check itself, every 60s (and on tab changes)
function showLocked() {
  current = null;
  document.body.classList.add("locked");
  document.getElementById("status").textContent = LOCKED_TEXT;
  for (const id of ["primary-info", "opponent-info", "prediction", "h2h"]) {
    document.getElementById(id).innerHTML = "";
  }
  refreshTimer = setTimeout(() => init(), REFRESH_MS);
}

async function init() {
  const gen = ++initGen;
  const statusEl = document.getElementById("status");
  const changeAccountBtn = document.getElementById("change-account");
  const controls = document.getElementById("controls");
  const restartBtn = document.getElementById("restart-tally");

  current = null;
  clearTimeout(refreshTimer);
  // anything still running from before can't draw over this
  syncGen++;
  renderGen++;
  document.body.classList.remove("locked");
  changeAccountBtn.hidden = true;
  controls.hidden = true;
  restartBtn.hidden = true;
  document.getElementById("h2h").innerHTML = "";
  document.getElementById("prediction").innerHTML = "";
  document.getElementById("data-as-of").textContent = "";

  document.body.classList.add("is-loading");

  try {
    // once: drop the old per-feature caches, months live in one store now
    await migrateStorage();

    const tabData = await getActiveChessTabData();
    if (gen !== initGen) return;
    console.log("[Performance] Active tab + scrape result:", tabData);

    if (!tabData) {
      statusEl.textContent =
        "Open a chess.com game or profile page, then click the extension again.";
      return;
    }

    // fair play: decided from the url and usernames alone, before anything about the
    // game is fetched or shown. a play url with no id can still carry one in its canonical link
    let page = parsePage(tabData.tab.url);
    const fromCanonical = parsePage(tabData.scraped.canonicalHref);
    if (page.kind === "play" && fromCanonical.kind === "game") page = fromCanonical;
    const saved =
      (await chrome.storage.local.get(STORAGE_KEY_PRIMARY_USERNAME))[STORAGE_KEY_PRIMARY_USERNAME] ?? null;
    const onPage = tabData.scraped.playersOnPage.map((p) => p.username);
    // the full search of stored months only has to happen once per game
    const scanCached = page.kind === "game" && !scannedGames.has(page.id);
    if (scanCached) scannedGames.add(page.id);
    const lock = await checkGameLock(page, onPage, saved, { scanCached });
    if (gen !== initGen) return;
    if (lock.locked) {
      showLocked();
      return;
    }

    const primaryUsername = await getPrimaryUsername(tabData.scraped.playersOnPage);
    if (gen !== initGen) return;

    if (!primaryUsername) {
      statusEl.textContent = "No username set - try again.";
      return;
    }

    const { mode, others } = resolveMode(primaryUsername, tabData.scraped.playersOnPage);

    // entries = who gets stats + performance, pair = who gets head-to-head
    let entries;
    let pair = null;
    switch (mode) {
      case "playing":
        statusEl.textContent = `Playing: "${primaryUsername}" vs "${others[0].username}".`;
        entries = [
          { label: "You", username: primaryUsername },
          { label: "Opponent", username: others[0].username },
        ];
        pair = [primaryUsername, others[0].username];
        break;

      case "spectating":
        statusEl.textContent = `Spectating as "${primaryUsername}": "${others[0].username}" vs "${others[1].username}".`;
        entries = [
          { label: others[0].username, username: others[0].username },
          { label: others[1].username, username: others[1].username },
        ];
        pair = [others[0].username, others[1].username];
        break;

      case "profile":
        statusEl.textContent = `Logged in as "${primaryUsername}", viewing "${others[0].username}"'s profile.`;
        entries = [
          { label: "You", username: primaryUsername },
          { label: "Profile", username: others[0].username },
        ];
        pair = [primaryUsername, others[0].username];
        break;

      default:
        statusEl.textContent = `Tracking "${primaryUsername}" — no other player found on this page.`;
        entries = [{ label: "You", username: primaryUsername }];
    }

    const settings = await loadSettings();
    document.getElementById("ctl-time").value = settings.time;
    document.getElementById("ctl-range").value = settings.range;
    document.getElementById("ctl-rated").value = settings.rated;

    changeAccountBtn.hidden = false;
    controls.hidden = false;
    restartBtn.hidden = false;

    current = { entries, pair, mode, gameRecord: lock.record, baseStatus: statusEl.textContent };
    lastSignature = null;
    // anyone shown keeps their stored data for another 30 days
    await markViewed([primaryUsername, ...entries.map((e) => e.username)]);

    // cached numbers first, instantly. then check chess.com for anything new
    if (!(await render())) statusEl.textContent = `${current.baseStatus} Loading recent games…`;
    await sync();

    // upkeep, last so it never holds anything up: old players out, a few old months rechecked.
    // if a recheck found a corrected month for someone on screen, show the new numbers
    if (gen !== initGen) return;
    const { changed } = await maintain(primaryUsername);
    if (gen === initGen && changed.some((n) => entries.some((e) => e.username === n))) {
      await render({ final: true });
    }
  } catch (err) {
    console.error("[Performance] init() failed:", err);
    statusEl.textContent = "Something went wrong - check the popup's console (right-click the extension icon > Inspect popup).";
  } finally {
    document.body.classList.remove("is-loading");
  }
}

// save the choice and redo everything with it
for (const [id, field] of [["ctl-time", "time"], ["ctl-range", "range"], ["ctl-rated", "rated"]]) {
  document.getElementById(id).addEventListener("change", async (e) => {
    const settings = await loadSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, [field]: e.target.value } });
    console.log(`[Performance] ${field} -> ${e.target.value}`);
    // everything needed is already in storage, so this makes no requests
    render({ final: true });
  });
}

// tally counts from now again, for everyone shown
document.getElementById("restart-tally").addEventListener("click", async () => {
  if (!current) return;
  const now = Date.now();
  await chrome.storage.session.set(
    Object.fromEntries(current.entries.map((e) => [`tallyStart:${e.username}`, now]))
  );
  console.log("[Performance] Restarted session tally.");
  render({ final: true });
});

// clears the saved username and asks again
document
  .getElementById("change-account")
  .addEventListener("click", async () => {
    await chrome.storage.local.remove(STORAGE_KEY_PRIMARY_USERNAME);
    console.log("[Performance] Cleared saved primary username - re-asking.");
    init();
  });

// --- views ---
// one page, one <section> per view. always opens on overview, nothing remembered
const VIEWS = ["overview", "race", "methodology"];

function showView(name) {
  for (const view of VIEWS) {
    document.getElementById(`view-${view}`).hidden = view !== name;
  }
  // the nav button for this view looks pressed. methodology has none, so none do
  for (const button of document.querySelectorAll("#views button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === name));
  }
  // no link to the page you're already on
  document.getElementById("open-methodology").hidden = name === "methodology";
}

// one paragraph per METHODOLOGY entry in performance.js
function renderMethodology() {
  const container = document.getElementById("methodology");
  container.innerHTML = "";
  for (const text of Object.values(METHODOLOGY)) {
    const p = document.createElement("p");
    p.textContent = text;
    container.appendChild(p);
  }
}

for (const button of document.querySelectorAll("#views button")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}
document.getElementById("open-methodology").addEventListener("click", () => showView("methodology"));

document.addEventListener("DOMContentLoaded", () => {
  renderMethodology();
  showView("overview");
  init();
});

// a different tab, or a new url in this one (a game starting or ending), is a different page
if (chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(() => init());
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tab.active && info.url) init();
  });
}

// suggestions:
// - "spectating" only compares the first two names found. a third name on the page gets ignored
// - typed usernames aren't checked against chess.com before saving. a typo only shows up later as "couldn't load stats"
