// chess.com rate limits parallel requests (429), so keep this small
const ARCHIVE_CONCURRENCY = 3;
const API = "https://api.chess.com/pub/player";

// { status, data, etag }. status 0 = network error.
// pass the etag we have and a 304 comes back with no body: "yours is still current".
// retries once on 429
async function fetchJson(url, etag = null) {
  // no-store: we do our own caching, so every call here is a real request
  const options = { cache: "no-store" };
  if (etag) options.headers = { "If-None-Match": etag };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, options);
      // 304 isn't an error, just log it like a 200
      const log = res.ok || res.status === 304 ? console.log : console.warn;
      log(`[Performance] fetch ${url} -> ${res.status}`);

      if (res.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      if (res.status === 304) return { status: 304, data: null, etag };
      // fetch doesn't throw on 404 etc, have to check
      if (!res.ok) return { status: res.status, data: null, etag: null };
      return { status: res.status, data: await res.json(), etag: res.headers.get("etag") };
    } catch (err) {
      console.error(`[Performance] fetch ${url} -> failed`, err);
      return { status: 0, data: null, etag: null };
    }
  }
  return { status: 429, data: null, etag: null };
}

// --- month store ---------------------------------------------------------
// one copy of every month, shared by every feature:
//   month:<name>:<YYYY/MM>      { games }  records from monthRecords(), from that player's side
//   monthMeta:<name>:<YYYY/MM>  { etag, fetchedAt, checkedAt, final } or { failedAt }
//   archives:<name>             { months, etag, fetchedAt }
//   stats:<name>                { stats, etag, fetchedAt }
//   rev:<name>                  goes up when an old month's games change,
//                               so derived caches know to rebuild
// meta is its own key so picking months to recheck doesn't load every game,
// and so two months of the same player can be saved at once without clobbering each other.
// { cacheOnly: true } on any fetcher = answer from storage, never touch the network

const DAY_MS = 86400 * 1000;
const REVALIDATE_MAX_MONTHS = 3;
const REVALIDATE_EVERY_DAYS = 30;
const STORE_VERSION = 1;
// chess.com's own cache-control max-age on months and /stats. a copy we got in the last
// 5s is as fresh as theirs, so one sync never asks for the same thing twice
const FRESH_MS = 5000;

// "YYYY/MM" in UTC, like the archive urls
const utcMonth = (ms) => new Date(ms).toISOString().slice(0, 7).replace("-", "/");

// same url asked for twice at once -> both get the one pending request
const inflight = new Map();
function shared(key, fn) {
  if (inflight.has(key)) return inflight.get(key);
  const pending = fn().finally(() => inflight.delete(key));
  inflight.set(key, pending);
  return pending;
}

// at most ARCHIVE_CONCURRENCY month requests at once, across every caller
let freeSlots = ARCHIVE_CONCURRENCY;
const waiting = [];
async function inMonthSlot(fn) {
  if (freeSlots > 0) freeSlots--;
  else await new Promise((resolve) => waiting.push(resolve));
  try {
    return await fn();
  } finally {
    // hand the slot straight to the next in line, or give it back
    const next = waiting.shift();
    if (next) next();
    else freeSlots++;
  }
}

// a player's month list. a cached list that already has this month can't be missing a newer one
async function fetchArchives(username, { cacheOnly = false } = {}) {
  const name = username.toLowerCase();
  const url = `${API}/${encodeURIComponent(name)}/games/archives`;
  const key = `archives:${name}`;
  if (cacheOnly) return (await chrome.storage.local.get(key))[key]?.months ?? null;

  return shared(url, async () => {
    const cached = (await chrome.storage.local.get(key))[key];
    if (cached?.months.includes(utcMonth(Date.now()))) return cached.months;
    if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return cached.months;

    const res = await fetchJson(url, cached?.etag);
    if (res.status === 304) {
      await chrome.storage.local.set({ [key]: { ...cached, fetchedAt: Date.now() } });
      return cached.months;
    }
    if (!res.data) return cached?.months ?? null;

    const months = res.data.archives.map((u) => u.slice(-7));
    await chrome.storage.local.set({ [key]: { months, etag: res.etag, fetchedAt: Date.now() } });
    return months;
  });
}

// one month of records, or null if it can't be loaded and was never cached.
// finished months are downloaded once. anything else is rechecked with its etag.
// cacheOnly: the cached records, null if chess.com failed us before (known missing),
// or undefined if we've simply never loaded it (so the caller knows it's incomplete)
async function fetchMonth(username, month, { cacheOnly = false } = {}) {
  const name = username.toLowerCase();
  const url = `${API}/${encodeURIComponent(name)}/games/${month}`;
  const key = `month:${name}:${month}`;
  const metaKey = `monthMeta:${name}:${month}`;
  if (cacheOnly) {
    const stored = await chrome.storage.local.get([key, metaKey]);
    if (stored[key]) return stored[key].games;
    return stored[metaKey]?.failedAt ? null : undefined;
  }

  return shared(url, async () => {
    const stored = await chrome.storage.local.get([key, metaKey]);
    const cached = stored[key]?.games;
    const meta = stored[metaKey];

    // final = fetched after the month ended, so it has every game
    if (cached && meta?.final) return cached;
    if (cached && Date.now() - meta?.fetchedAt < FRESH_MS) return cached;

    const res = await inMonthSlot(() => fetchJson(url, cached ? meta?.etag : null));
    const now = Date.now();
    const final = month < utcMonth(now);

    if (res.status === 304) {
      await chrome.storage.local.set({ [metaKey]: { ...meta, fetchedAt: now, checkedAt: now, final } });
      return cached;
    }
    // stale beats nothing. nothing at all: remember it failed, so cacheOnly
    // readers treat it as known missing instead of "not loaded yet"
    if (!res.data) {
      if (!cached) await chrome.storage.local.set({ [metaKey]: { failedAt: now } });
      return cached ?? null;
    }

    const games = monthRecords(res.data.games, name);
    await chrome.storage.local.set({
      [key]: { games },
      [metaKey]: { etag: res.etag, fetchedAt: now, checkedAt: now, final },
    });
    return games;
  });
}

// which finished months are due a recheck: not checked in 30 days, oldest check first, max 3
function pickMonthsToRevalidate(metas, now) {
  const cutoff = now - REVALIDATE_EVERY_DAYS * DAY_MS;
  return metas
    .filter((m) => m.final && (m.checkedAt ?? 0) < cutoff)
    .sort((a, b) => (a.checkedAt ?? 0) - (b.checkedAt ?? 0))
    .slice(0, REVALIDATE_MAX_MONTHS);
}

// cheap background recheck of old months (the etag makes "nothing changed" a 0-byte 304).
// the caller decides which players. returns the players whose data changed
async function revalidateFinishedMonths(usernames) {
  const metas = [];
  for (const username of usernames) {
    const name = username.toLowerCase();
    const months = (await chrome.storage.local.get(`archives:${name}`))[`archives:${name}`]?.months || [];
    const stored = await chrome.storage.local.get(months.map((m) => `monthMeta:${name}:${m}`));
    for (const month of months) {
      const meta = stored[`monthMeta:${name}:${month}`];
      if (meta) metas.push({ name, month, ...meta });
    }
  }

  const now = Date.now();
  const changed = new Set();
  for (const m of pickMonthsToRevalidate(metas, now)) {
    const url = `${API}/${encodeURIComponent(m.name)}/games/${m.month}`;
    const res = await inMonthSlot(() => fetchJson(url, m.etag));
    console.log(`[Performance] revalidate ${m.name} ${m.month} -> ${res.status}`);
    const metaKey = `monthMeta:${m.name}:${m.month}`;
    const { name, month, ...meta } = m;

    if (res.status === 304) {
      await chrome.storage.local.set({ [metaKey]: { ...meta, checkedAt: now } });
    } else if (res.data) {
      const games = monthRecords(res.data.games, name);
      await chrome.storage.local.set({
        [`month:${name}:${month}`]: { games },
        [metaKey]: { etag: res.etag, fetchedAt: now, checkedAt: now, final: true },
      });
      if (res.etag !== meta.etag) changed.add(name);
    }
    // anything else (404, offline): leave it, it's picked again next time
  }

  for (const name of changed) {
    const key = `rev:${name}`;
    const rev = (await chrome.storage.local.get(key))[key] ?? 0;
    await chrome.storage.local.set({ [key]: rev + 1 });
  }
  return [...changed];
}

// derived caches store the rev they were built from, and rebuild when it moves
async function getRevision(username) {
  const key = `rev:${username.toLowerCase()}`;
  return (await chrome.storage.local.get(key))[key] ?? 0;
}

// one-time cleanup of the old per-feature caches, now that months live in one place
async function migrateStorage() {
  const { storeVersion } = await chrome.storage.local.get("storeVersion");
  if (storeVersion === STORE_VERSION) return;
  const all = await chrome.storage.local.get(null);
  const old = Object.keys(all).filter((k) => /^(h2h|games|history):/.test(k));
  await chrome.storage.local.remove(old);
  await chrome.storage.local.set({ storeVersion: STORE_VERSION });
  console.log(`[Performance] storage migrated, removed ${old.length} old keys`);
}

// a player's /stats (ratings per time class). revalidated with its etag and kept in
// local storage, so it survives browser restarts. returns { stats, fetchedAt }
async function fetchStats(username, { cacheOnly = false } = {}) {
  const name = username.toLowerCase();
  const url = `${API}/${encodeURIComponent(name)}/stats`;
  const key = `stats:${name}`;
  const view = (c) => (c ? { stats: c.stats, fetchedAt: c.fetchedAt } : null);
  if (cacheOnly) return view((await chrome.storage.local.get(key))[key]);

  return shared(url, async () => {
    const cached = (await chrome.storage.local.get(key))[key];
    const res = await fetchJson(url, cached?.etag);
    const now = Date.now();
    if (res.status === 304) {
      await chrome.storage.local.set({ [key]: { ...cached, fetchedAt: now } });
      return view({ ...cached, fetchedAt: now });
    }
    if (!res.data) return view(cached);

    const fresh = { stats: res.data, etag: res.etag, fetchedAt: now };
    await chrome.storage.local.set({ [key]: fresh });
    return view(fresh);
  });
}

// wins/draws from a's side, overall and per time class. games are records from a's side.
// expected = what the ratings recorded in each game predicted for a
function tallyHeadToHead(a, b, games) {
  const empty = () => ({ aWins: 0, bWins: 0, draws: 0, total: 0 });
  const totals = empty();
  const byTimeClass = {};
  let expected = 0;
  let actual = 0;
  let ratedGames = 0;

  for (const g of games) {
    const tc = (byTimeClass[g.timeClass] ||= empty());
    for (const t of [totals, tc]) {
      t.total++;
      if (g.score === 1) t.aWins++;
      else if (g.score === 0) t.bWins++;
      else t.draws++;
    }
    if (g.rating != null && g.oppRating != null) {
      expected += expectedScore(g.rating, g.oppRating);
      actual += g.score;
      ratedGames++;
    }
  }
  return { a, b, ...totals, byTimeClass, games, vsRatings: { expected, actual, games: ratedGames } };
}

// a record from the other player's side, turned around to a's side
function flipSide(r, other) {
  return { ...r, rating: r.oppRating, oppRating: r.rating, opponent: other, score: 1 - r.score };
}

// every game between a and b, read from a's months (every game between them is in a's
// archive). only falls back to b's month if a's won't load.
// derived cache: games from finished months are kept per month, and thrown away if
// either player's rev moves. only the current month is reread each time
async function fetchHeadToHead(a, b, onProgress = () => {}, { cacheOnly = false } = {}) {
  a = a?.toLowerCase();
  b = b?.toLowerCase();
  if (!a || !b || a === b) return null;

  const [monthsA, monthsB] = await Promise.all([
    fetchArchives(a, { cacheOnly }),
    fetchArchives(b, { cacheOnly }),
  ]);
  if (!monthsA) return null;
  // only months both played can have games between them. if b's list failed, check all of a's
  const bHas = monthsB ? new Set(monthsB) : null;
  const shared = monthsA.filter((m) => !bHas || bHas.has(m));
  const current = utcMonth(Date.now());

  const key = `derived:h2h:${a}:${b}`;
  const revs = `${await getRevision(a)}:${await getRevision(b)}`;
  let cache = (await chrome.storage.local.get(key))[key];
  if (cache?.revs !== revs) cache = { revs, months: {} };

  const toRead = shared.filter((m) => !cache.months[m]);
  const fresh = {};
  const missing = [];
  let incomplete = false;
  let done = 0;
  await Promise.all(
    toRead.map(async (month) => {
      let vs = null;
      const mine = await fetchMonth(a, month, { cacheOnly });
      if (mine) {
        vs = mine.filter((g) => g.opponent === b);
      } else {
        const theirs = await fetchMonth(b, month, { cacheOnly });
        if (theirs) vs = theirs.filter((g) => g.opponent === a).map((g) => flipSide(g, b));
        // cacheOnly: a month neither side has ever loaded
        if (mine === undefined && theirs === undefined) incomplete = true;
      }
      if (!vs) missing.push(month);
      else if (month < current) cache.months[month] = vs;
      else fresh[month] = vs;
      onProgress(++done, toRead.length);
    })
  );
  await chrome.storage.local.set({ [key]: cache });
  // from storage alone, a never-loaded month would make the numbers quietly wrong
  if (incomplete) return null;

  const games = shared
    .flatMap((m) => cache.months[m] || fresh[m] || [])
    .sort((x, y) => y.t - x.t);

  if (missing.length) console.warn(`[Performance] h2h ${a} vs ${b}: couldn't load ${missing.join(", ")}`);
  console.log(`[Performance] h2h ${a} vs ${b}: ${shared.length} shared months, ${toRead.length} read`);
  const result = tallyHeadToHead(a, b, games);
  console.log(`[Performance] h2h ${a} vs ${b}:`, result);
  return result;
}

const GAMES_MAX_MONTHS = 6;

// newest months first, at most 6. needMore(gamesSoFar, month) says whether to load an older one.
// cacheOnly: null if any month it needs was never loaded, rather than a short list
async function fetchPlayerGames(username, needMore, { cacheOnly = false } = {}) {
  const months = await fetchArchives(username, { cacheOnly });
  if (!months) return null;

  let games = [];
  for (const month of [...months].reverse().slice(0, GAMES_MAX_MONTHS)) {
    const got = await fetchMonth(username, month, { cacheOnly });
    if (got === undefined) return null;
    games = games.concat(got || []);
    if (!needMore(games, month)) break;
  }

  console.log(`[Performance] fetchPlayerGames("${username}"): ${games.length} games`);
  return games;
}

// time class of one live game by id. undocumented endpoint, but it works for
// games still in progress (not in the archives yet). cached per game
async function fetchGameTimeClass(gameId, { cacheOnly = false } = {}) {
  const key = `gameTc:${gameId}`;
  const cached = (await chrome.storage.session.get(key))[key];
  if (cached || cacheOnly) return cached ?? null;

  const { data } = await fetchJson(`https://www.chess.com/callback/live/game/${gameId}`);
  const timeClass = classifyTimeControl(data?.game?.pgnHeaders?.TimeControl);
  console.log(`[Performance] game ${gameId} time class:`, timeClass);
  if (timeClass) await chrome.storage.session.set({ [key]: timeClass });
  return timeClass;
}

// time class of the latest game between a and b.
// a's recent months first, then whatever an earlier h2h scan cached
async function latestHeadToHeadTimeClass(a, b, { cacheOnly = false } = {}) {
  a = a.toLowerCase();
  b = b.toLowerCase();
  const newestVsB = (games) =>
    games.filter((g) => g.opponent === b).sort((x, y) => y.t - x.t)[0];

  const recent = await fetchPlayerGames(a, (games) => !newestVsB(games), { cacheOnly });
  let latest = newestVsB(recent || []);

  if (!latest) {
    const key = `derived:h2h:${a}:${b}`;
    const cache = (await chrome.storage.local.get(key))[key];
    if (cache) latest = newestVsB(Object.values(cache.months).flat());
  }

  console.log(`[Performance] latest ${a} vs ${b} game:`, latest ?? "none");
  return latest?.timeClass ?? null;
}

// every game a player has played in one time class, oldest first
async function fetchPlayerHistory(username, timeClass, onProgress = () => {}) {
  const months = await fetchArchives(username);
  if (!months) return null;

  let done = 0;
  const missingMonths = [];
  const byMonth = await Promise.all(
    months.map(async (month) => {
      const games = await fetchMonth(username, month);
      if (!games) missingMonths.push(month);
      onProgress(++done, months.length);
      return games || [];
    })
  );

  const games = byMonth
    .flat()
    .filter((g) => g.timeClass === timeClass)
    .sort((x, y) => x.t - y.t);

  if (missingMonths.length) {
    console.warn(`[Performance] history ${username}: couldn't load ${missingMonths.join(", ")}`);
  }
  console.log(`[Performance] history ${username} ${timeClass}: ${games.length} games`);
  return { games, missingMonths };
}

// node gets module.exports (for tests), the popup just gets globals from the script tag
if (typeof module !== "undefined") {
  module.exports = {
    fetchJson, fetchArchives, fetchMonth, pickMonthsToRevalidate,
    revalidateFinishedMonths, getRevision, migrateStorage, fetchStats,
    tallyHeadToHead, flipSide, fetchHeadToHead, fetchPlayerGames,
    latestHeadToHeadTimeClass, fetchPlayerHistory,
  };
}
