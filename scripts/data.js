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
      // a warning, not an error: reloading the extension cancels in-flight requests, and the
      // caller already falls back to the cached copy
      console.warn(`[Performance] fetch ${url} -> failed`, err);
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

// --- storage upkeep ---
// lastViewed = { name: ms } for every player shown. players not viewed in 30 days lose
// their months and derived caches (they're rebuilt if viewed again). never the primary user
const EVICT_AFTER_DAYS = 30;

// which players a storage key belongs to. an h2h cache belongs to both
function playersOfKey(key) {
  const parts = key.split(":");
  switch (parts[0]) {
    case "month":
    case "monthMeta":
    case "archives":
    case "stats":
    case "rev":
      return [parts[1]];
    case "derived":
      return parts[1] === "h2h" ? [parts[2], parts[3]] : [parts[2]];
    default:
      return [];
  }
}

// players whose last view is more than 30 days old, never the primary user
function pickPlayersToEvict(names, lastViewed, primary, now) {
  const cutoff = now - EVICT_AFTER_DAYS * DAY_MS;
  return names.filter((n) => n !== primary && lastViewed[n] != null && lastViewed[n] < cutoff);
}

async function markViewed(usernames) {
  const viewed = (await chrome.storage.local.get("lastViewed")).lastViewed || {};
  const now = Date.now();
  for (const u of usernames) if (u) viewed[u.toLowerCase()] = now;
  await chrome.storage.local.set({ lastViewed: viewed });
}

// returns the evicted names
async function evictStalePlayers(primary) {
  // getKeys lists keys without loading every month into memory (chrome 130+)
  const keys = chrome.storage.local.getKeys
    ? await chrome.storage.local.getKeys()
    : Object.keys(await chrome.storage.local.get(null));
  const owners = new Map(keys.map((k) => [k, playersOfKey(k)]));
  const names = [...new Set([...owners.values()].flat())];
  const viewed = (await chrome.storage.local.get("lastViewed")).lastViewed || {};
  const now = Date.now();

  // data from before lastViewed existed starts its 30 days now, instead of vanishing at once
  let stamped = false;
  for (const n of names) {
    if (viewed[n] == null) {
      viewed[n] = now;
      stamped = true;
    }
  }

  const evict = new Set(pickPlayersToEvict(names, viewed, primary?.toLowerCase(), now));
  const doomed = keys.filter((k) => owners.get(k).some((n) => evict.has(n)));
  for (const n of evict) delete viewed[n];
  if (doomed.length) await chrome.storage.local.remove(doomed);
  if (evict.size || stamped) await chrome.storage.local.set({ lastViewed: viewed });
  if (evict.size) console.log(`[Performance] evicted ${[...evict].join(", ")} (${doomed.length} keys)`);
  return [...evict];
}

// background upkeep, once everything is on screen: drop players not viewed in 30 days,
// then recheck a few old months for the primary user and anyone viewed recently.
// returns { evicted, changed }, changed = players whose old months turned out different
async function maintain(primary) {
  const evicted = await evictStalePlayers(primary);
  const viewed = (await chrome.storage.local.get("lastViewed")).lastViewed || {};
  const players = Object.keys(viewed);
  if (primary && !players.includes(primary.toLowerCase())) players.push(primary.toLowerCase());
  const changed = await revalidateFinishedMonths(players);
  return { evicted, changed };
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

// --- pre-game ratings over the month store ---
// derived cache derived:pre:<name> = { rev, ends: { "YYYY/MM": { bullet: 2100, ... } } }:
// the last rated rating per time class at the end of each finished month, so the first
// game of any month knows the rating before it. tagged with rev like derived:h2h

// state at the end of `month`, carried on from the month before it in the archive.
// complete = every month back to the first one was loaded. a gap means we don't know
// the ratings from there, and only complete states get cached (so a gap filled in later counts)
async function monthEndState(name, month, months, cache, current) {
  if (cache.ends[month]) return { state: cache.ends[month], complete: true };
  const records = await fetchMonth(name, month, { cacheOnly: true });
  if (!records) return { state: {}, complete: false };
  const i = months.indexOf(month);
  const before =
    i > 0
      ? await monthEndState(name, months[i - 1], months, cache, current)
      : { state: {}, complete: i === 0 };
  const state = { ...before.state, ...lastRatedByTimeClass(records) };
  if (before.complete && month < current) cache.ends[month] = state;
  return { state, complete: before.complete };
}

// pre-game numbers for some of a player's months. byMonth: month -> records from fetchMonth,
// months: their archive list. returns month -> { records, complete }, where complete = the
// month's starting ratings were all known (so a derived cache can keep it)
async function withPreGame(username, months, byMonth) {
  const name = username.toLowerCase();
  const key = `derived:pre:${name}`;
  const rev = await getRevision(name);
  let cache = (await chrome.storage.local.get(key))[key];
  if (cache?.rev !== rev) cache = { rev, ends: {} };
  const current = utcMonth(Date.now());

  const out = {};
  let carry = null; // the month just done, so back-to-back months don't reread storage
  for (const month of Object.keys(byMonth).sort()) {
    const i = months.indexOf(month);
    let start;
    if (i === 0) start = { state: {}, complete: true };
    else if (i < 0) start = { state: {}, complete: false };
    else if (carry?.month === months[i - 1]) start = carry.end;
    else start = await monthEndState(name, months[i - 1], months, cache, current);

    const { records, end } = preGamePass(byMonth[month], start.state);
    out[month] = { records, complete: start.complete };
    carry = { month, end: { state: end, complete: start.complete } };
    if (start.complete && month < current) cache.ends[month] = end;
  }
  await chrome.storage.local.set({ [key]: cache });
  return out;
}

// when we last confirmed this player's numbers with chess.com: the older of their /stats
// check and their current month check (a 304 counts, it confirms nothing changed).
// a month with no games yet was never fetched, so then it's /stats alone. null = never
async function dataAsOf(username) {
  const name = username.toLowerCase();
  const keys = [`stats:${name}`, `monthMeta:${name}:${utcMonth(Date.now())}`];
  const stored = await chrome.storage.local.get(keys);
  const times = keys.map((k) => stored[k]?.fetchedAt).filter((t) => typeof t === "number");
  return times.length ? Math.min(...times) : null;
}

// wins/draws from a's side, overall and per time class. games are records from a's side.
// expected = what the pre-game ratings of each game predicted for a
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
    if (g.myPre != null && g.oppPre != null) {
      expected += expectedScore(g.myPre, g.oppPre);
      actual += g.score;
      ratedGames++;
    }
  }
  return { a, b, ...totals, byTimeClass, games, vsRatings: { expected, actual, games: ratedGames } };
}

// a record from the other player's side, turned around to a's side. their estimate of
// my pre-game rating becomes my pre-game rating, and the other way round
function flipSide(r, other) {
  return {
    ...r,
    rating: r.oppRating,
    oppRating: r.rating,
    myPre: r.oppPre,
    oppPre: r.myPre,
    myChange: r.myChange == null ? null : -r.myChange,
    opponent: other,
    score: 1 - r.score,
  };
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
  // "pre:" so caches from before the pre-game numbers get rebuilt once
  const revs = `pre:${await getRevision(a)}:${await getRevision(b)}`;
  let cache = (await chrome.storage.local.get(key))[key];
  if (cache?.revs !== revs) cache = { revs, months: {} };

  const toRead = shared.filter((m) => !cache.months[m]);
  const mineByMonth = {};
  const theirsByMonth = {};
  const missing = [];
  let incomplete = false;
  let done = 0;
  await Promise.all(
    toRead.map(async (month) => {
      const mine = await fetchMonth(a, month, { cacheOnly });
      if (mine) {
        mineByMonth[month] = mine;
      } else {
        const theirs = await fetchMonth(b, month, { cacheOnly });
        if (theirs) theirsByMonth[month] = theirs;
        else missing.push(month);
        // cacheOnly: a month neither side has ever loaded
        if (mine === undefined && theirs === undefined) incomplete = true;
      }
      onProgress(++done, toRead.length);
    })
  );

  // pre-game numbers need every one of the player's games that month, not just the ones vs
  // each other, so they're worked out on the whole month and filtered after
  const fresh = {};
  const keep = (month, vs, complete) => {
    if (month < current && complete) cache.months[month] = vs;
    else fresh[month] = vs;
  };
  for (const [month, m] of Object.entries(await withPreGame(a, monthsA, mineByMonth))) {
    keep(month, m.records.filter((g) => g.opponent === b), m.complete);
  }
  for (const [month, m] of Object.entries(await withPreGame(b, monthsB || [], theirsByMonth))) {
    keep(month, m.records.filter((g) => g.opponent === a).map((g) => flipSide(g, b)), m.complete);
  }
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

// newest months first, at most 6, with pre-game numbers. needMore(gamesSoFar, month) says
// whether to load an older one. cacheOnly: null if any month it needs was never loaded,
// rather than a short list
async function fetchPlayerGames(username, needMore, { cacheOnly = false } = {}) {
  const months = await fetchArchives(username, { cacheOnly });
  if (!months) return null;

  const byMonth = {};
  let raw = [];
  for (const month of [...months].reverse().slice(0, GAMES_MAX_MONTHS)) {
    const got = await fetchMonth(username, month, { cacheOnly });
    if (got === undefined) return null;
    // a month chess.com failed on stays out, so the next month doesn't think it had no games
    if (got) byMonth[month] = got;
    raw = raw.concat(got || []);
    if (!needMore(raw, month)) break;
  }

  const annotated = await withPreGame(username, months, byMonth);
  const games = Object.keys(annotated)
    .sort()
    .reverse()
    .flatMap((m) => annotated[m].records);

  console.log(`[Performance] fetchPlayerGames("${username}"): ${games.length} games`);
  return games;
}

// fair play gate. is the game on this page finished? only if its id is in a player's
// archive: this month and last, straight from chess.com (an empty month is just
// { games: [] }, and last month is cached for good once it's over), plus, the first time
// we see a page, every other month already in storage (no requests). returns the record or null
async function findGameInArchive(username, page, { scanCached = false } = {}) {
  const now = new Date();
  const current = utcMonth(now.getTime());
  const previous = utcMonth(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  for (const month of [current, previous]) {
    const found = findGame((await fetchMonth(username, month)) || [], page);
    if (found) return found;
  }
  if (!scanCached) return null;

  const listed = (await fetchArchives(username, { cacheOnly: true })) || [];
  for (const month of listed) {
    if (month === current || month === previous) continue;
    const found = findGame((await fetchMonth(username, month, { cacheOnly: true })) || [], page);
    if (found) return found;
  }
  return null;
}

// { locked, record } for the page on screen. only one player's archive is checked:
// yours when you're playing, so a locked game never makes requests about your opponent
async function checkGameLock(page, onPage, primary, opts = {}) {
  if (page.kind === "other") return { locked: false, record: null };
  if (page.kind === "play") return { locked: true, record: null };
  const user = lockCheckUser(onPage, primary);
  const record = user ? await findGameInArchive(user, page, opts) : null;
  console.log(`[Performance] fair play: game ${page.id} ${record ? "finished" : "in progress (locked)"}, checked ${user}`);
  return { locked: isGameInProgress(page, record), record };
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

// every game a player has played in one time class, oldest first.
// preGame: with myPre/oppPre (volatility, rust check, and the climb breakdown need them)
async function fetchPlayerHistory(username, timeClass, onProgress = () => {}, { preGame = false } = {}) {
  const months = await fetchArchives(username);
  if (!months) return null;

  let done = 0;
  const missingMonths = [];
  const byMonth = {};
  await Promise.all(
    months.map(async (month) => {
      const games = await fetchMonth(username, month);
      if (games) byMonth[month] = games;
      else missingMonths.push(month);
      onProgress(++done, months.length);
    })
  );

  // pre-game numbers need the whole month (every time class), so they come before the filter
  const annotated = preGame ? await withPreGame(username, months, byMonth) : null;
  const games = Object.keys(byMonth)
    .flatMap((m) => (annotated ? annotated[m].records : byMonth[m]))
    .filter((g) => g.timeClass === timeClass)
    .sort((x, y) => x.t - y.t || x.id - y.id);

  if (missingMonths.length) {
    console.warn(`[Performance] history ${username}: couldn't load ${missingMonths.join(", ")}`);
  }
  console.log(`[Performance] history ${username} ${timeClass}: ${games.length} games`);
  return { games, missingMonths };
}

// a player's journey in one time class (race.js), kept as a derived cache:
//   derived:journey:<name>:<timeClass> = { rev, through, state }
// state = the fold as of the end of month `through`, the last finished month folded.
// an update only adds the months after it, and the current month is added on a copy and
// never saved (it's still changing). rev moving means everything is rebuilt
async function fetchJourney(username, timeClass, { cacheOnly = false, onProgress = () => {} } = {}) {
  const name = username.toLowerCase();
  const months = await fetchArchives(name, { cacheOnly });
  if (!months) return null;

  const key = `derived:journey:${name}:${timeClass}`;
  const rev = await getRevision(name);
  let cache = (await chrome.storage.local.get(key))[key];
  if (cache?.rev !== rev) cache = { rev, through: null, state: newJourneyState() };

  const now = Date.now();
  const current = utcMonth(now);
  const finished = months.filter((m) => m < current && (cache.through == null || m > cache.through));

  // load in parallel (3 at a time through inMonthSlot), fold in order
  let done = 0;
  const loaded = await Promise.all(
    finished.map(async (m) => {
      const games = await fetchMonth(name, m, { cacheOnly });
      onProgress(++done, finished.length);
      return games;
    })
  );
  // from storage alone, a never-loaded month would quietly drop games from the journey
  if (cacheOnly && loaded.includes(undefined)) return null;

  const inOrder = (games) =>
    games.filter((g) => g.timeClass === timeClass).sort((a, b) => a.t - b.t || a.id - b.id);
  const state = cache.state;
  let saved = null; // the state to save: up to the month before the first gap, if any
  let through = cache.through;
  const missingMonths = [];
  for (let i = 0; i < finished.length; i++) {
    if (!loaded[i]) {
      // keep going for this answer, but don't save past a gap, so it's refolded once it loads
      if (!saved) saved = { through, state: structuredClone(state) };
      missingMonths.push(finished[i]);
      continue;
    }
    for (const g of inOrder(loaded[i])) journeyStep(state, g);
    if (!saved) through = finished[i];
  }
  if (finished.length) {
    await chrome.storage.local.set({ [key]: { rev, ...(saved ?? { through, state }) } });
  }

  // the current month, on a copy
  const withCurrent = structuredClone(state);
  if (months.includes(current)) {
    const games = await fetchMonth(name, current, { cacheOnly });
    if (games === undefined && cacheOnly) return null;
    for (const g of inOrder(games || [])) journeyStep(withCurrent, g);
  }

  const journey = finishJourney(withCurrent, now);
  console.log(`[Performance] journey ${name} ${timeClass}: ${finished.length} new finished months folded, through ${through}`);
  return { ...journey, missingMonths };
}

// node gets module.exports (for tests), the popup just gets globals from the script tag
if (typeof module !== "undefined") {
  module.exports = {
    fetchJson, fetchArchives, fetchMonth, pickMonthsToRevalidate,
    revalidateFinishedMonths, getRevision, migrateStorage, fetchStats,
    tallyHeadToHead, flipSide, fetchHeadToHead, fetchPlayerGames, withPreGame, dataAsOf,
    playersOfKey, pickPlayersToEvict, markViewed, evictStalePlayers, maintain, fetchJourney,
    latestHeadToHeadTimeClass, fetchPlayerHistory, findGameInArchive, checkGameLock,
  };
}
