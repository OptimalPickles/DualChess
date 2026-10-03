// run: node --test scripts/data.test.js
// offline: a fake chess.com and a fake chrome.storage, so request counts are exact
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// data.js uses monthRecords, findGame etc as globals, like in the popup
Object.assign(globalThis, require("./performance.js"), require("./fairplay.js"), require("./race.js"));

const utcMonth = (ms) => new Date(ms).toISOString().slice(0, 7).replace("-", "/");
const CURRENT = utcMonth(Date.now());
const API = "https://api.chess.com/pub/player";

// storage that outlives "popup opens"
function fakeStorage() {
  const store = {};
  const get = async (keys) => {
    if (keys === null) return { ...store };
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
  };
  return {
    store,
    local: { get, set: async (o) => Object.assign(store, o), remove: async (keys) => [].concat(keys).forEach((k) => delete store[k]) },
    session: { get: async () => ({}), set: async () => {} },
  };
}

// fake chess.com: url -> { body, etag }. honours If-None-Match like the real one
function fakeServer(routes) {
  const requests = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, options = {}) => {
    const sentEtag = options.headers?.["If-None-Match"] ?? null;
    requests.push({ url, sentEtag });
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 10)); // so requests overlap
    inFlight--;
    const route = routes[url];
    if (!route) return new Response("{}", { status: 404 });
    if (sentEtag && sentEtag === route.etag) return new Response(null, { status: 304 });
    return new Response(JSON.stringify(route.body), { status: 200, headers: { etag: route.etag } });
  };
  return { fetch, requests, maxInFlight: () => maxInFlight };
}

// pretend ms passed since everything was fetched (a real reopen is seconds later)
function age(storage, ms) {
  for (const value of Object.values(storage.store)) {
    if (value && typeof value.fetchedAt === "number") value.fetchedAt -= ms;
  }
}

// a fresh copy of data.js = a fresh popup (new in-flight map, new slots)
function openPopup(storage, server) {
  globalThis.chrome = { storage };
  globalThis.fetch = server.fetch;
  const file = path.join(__dirname, "data.js");
  delete require.cache[require.resolve(file)];
  const quiet = console.log;
  console.log = () => {};
  const mod = require(file);
  return { ...mod, restoreLog: () => (console.log = quiet) };
}

const rawGame = (t, opts = {}) => ({
  url: `https://www.chess.com/game/live/${t}`,
  end_time: t,
  time_class: "bullet",
  rated: true,
  rules: "chess",
  white: { username: "Me", result: "win", rating: 2100 },
  black: { username: "Friend", result: "timeout", rating: 2050 },
  ...opts,
});
const monthUrl = (m) => `${API}/me/games/${m}`;

test("two simultaneous fetchMonth calls for the same month make one request", async () => {
  const server = fakeServer({ [monthUrl("2020/01")]: { body: { games: [rawGame(1)] }, etag: "a" } });
  const data = openPopup(fakeStorage(), server);
  const [x, y] = await Promise.all([data.fetchMonth("me", "2020/01"), data.fetchMonth("Me", "2020/01")]);
  data.restoreLog();
  assert.equal(server.requests.length, 1);
  assert.deepEqual(x, y);
  assert.equal(x.length, 1);
});

test("a finished month is never requested twice across popup opens", async () => {
  const storage = fakeStorage();
  const server = fakeServer({ [monthUrl("2020/01")]: { body: { games: [rawGame(1)] }, etag: "a" } });
  for (let open = 0; open < 3; open++) {
    const data = openPopup(storage, server);
    await data.fetchMonth("me", "2020/01");
    data.restoreLog();
  }
  assert.equal(server.requests.length, 1);
});

test("the current month is rechecked with its etag and a 304 reuses the cache", async () => {
  const storage = fakeStorage();
  const server = fakeServer({ [monthUrl(CURRENT)]: { body: { games: [rawGame(1), rawGame(2)] }, etag: "cur" } });
  let data = openPopup(storage, server);
  await data.fetchMonth("me", CURRENT);
  data.restoreLog();
  age(storage, 10000);
  data = openPopup(storage, server);
  const games = await data.fetchMonth("me", CURRENT);
  data.restoreLog();
  assert.deepEqual(server.requests.map((r) => r.sentEtag), [null, "cur"]);
  assert.equal(games.length, 2);
});

test("records are from that player's side, standard chess only", async () => {
  const server = fakeServer({
    [monthUrl("2020/01")]: {
      body: { games: [rawGame(1), rawGame(2, { rules: "chess960" }), rawGame(3, { rated: false })] },
      etag: "a",
    },
  });
  const data = openPopup(fakeStorage(), server);
  const games = await data.fetchMonth("me", "2020/01");
  data.restoreLog();
  assert.equal(games.length, 2);
  assert.deepEqual(games[0], {
    id: 1, t: 1, rating: 2100, oppRating: 2050,
    opponent: "friend", score: 1, rated: true, timeClass: "bullet",
  });
  assert.equal(games[1].rated, false);
});

test("never more than 3 month requests in flight", async () => {
  const months = ["2020/01", "2020/02", "2020/03", "2020/04", "2020/05", "2020/06", "2020/07", "2020/08"];
  const server = fakeServer(Object.fromEntries(months.map((m) => [monthUrl(m), { body: { games: [] }, etag: m }])));
  const data = openPopup(fakeStorage(), server);
  await Promise.all(months.map((m) => data.fetchMonth("me", m)));
  data.restoreLog();
  assert.equal(server.requests.length, 8);
  assert.equal(server.maxInFlight(), 3);
});

test("archives list isn't requested again once it includes the current month", async () => {
  const storage = fakeStorage();
  const server = fakeServer({ [`${API}/me/games/archives`]: { body: { archives: [monthUrl("2020/01"), monthUrl(CURRENT)] }, etag: "arch" } });
  for (let open = 0; open < 2; open++) {
    const data = openPopup(storage, server);
    assert.deepEqual(await data.fetchArchives("me"), ["2020/01", CURRENT]);
    data.restoreLog();
  }
  assert.equal(server.requests.length, 1);
});

test("pickMonthsToRevalidate: skips recent checks, oldest check first, max 3", () => {
  const data = openPopup(fakeStorage(), fakeServer({}));
  data.restoreLog();
  const now = Date.UTC(2026, 8, 30);
  const daysAgo = (d) => now - d * 86400 * 1000;
  const picked = data.pickMonthsToRevalidate([
    { month: "a", final: true, checkedAt: daysAgo(10) },  // checked recently, skip
    { month: "b", final: true, checkedAt: daysAgo(40) },
    { month: "c", final: true, checkedAt: daysAgo(90) },
    { month: "d", final: false, checkedAt: daysAgo(90) }, // current month, not ours to recheck
    { month: "e", final: true, checkedAt: daysAgo(35) },
    { month: "f", final: true, checkedAt: daysAgo(60) },
  ], now);
  assert.deepEqual(picked.map((m) => m.month), ["c", "f", "b"]);
});

test("revalidation: matching etag -> no rebuild; changed month -> replaced and rev goes up", async () => {
  const storage = fakeStorage();
  const routes = {
    [`${API}/me/games/archives`]: { body: { archives: [monthUrl("2020/01"), monthUrl("2020/02")] }, etag: "arch" },
    [monthUrl("2020/01")]: { body: { games: [rawGame(1)] }, etag: "jan" },
    [monthUrl("2020/02")]: { body: { games: [rawGame(2)] }, etag: "feb" },
  };
  const server = fakeServer(routes);
  let data = openPopup(storage, server);
  await data.fetchArchives("me");
  await data.fetchMonth("me", "2020/01");
  await data.fetchMonth("me", "2020/02");
  data.restoreLog();

  // pretend both were last checked 31 days ago
  for (const m of ["2020/01", "2020/02"]) storage.store[`monthMeta:me:${m}`].checkedAt -= 31 * 86400 * 1000;

  // nothing changed on the server
  data = openPopup(storage, server);
  const before = server.requests.length;
  assert.deepEqual(await data.revalidateFinishedMonths(["me"]), []);
  assert.equal(await data.getRevision("me"), 0);
  data.restoreLog();
  assert.equal(server.requests.length - before, 2);
  assert.ok(server.requests.slice(-2).every((r) => r.sentEtag)); // both sent their etag

  // february gets corrected on the server
  for (const m of ["2020/01", "2020/02"]) storage.store[`monthMeta:me:${m}`].checkedAt -= 31 * 86400 * 1000;
  routes[monthUrl("2020/02")] = { body: { games: [rawGame(2), rawGame(3)] }, etag: "feb-v2" };
  data = openPopup(storage, server);
  assert.deepEqual(await data.revalidateFinishedMonths(["me"]), ["me"]);
  assert.equal(await data.getRevision("me"), 1);
  assert.equal((await data.fetchMonth("me", "2020/02")).length, 2); // from cache, the new copy
  data.restoreLog();
});

test("migration removes old h2h:/games:/history: keys once and keeps the new ones", async () => {
  const storage = fakeStorage();
  Object.assign(storage.store, {
    "h2h:a:b": {}, "games:me:2020/01": {}, "history:me:2020/01": {},
    "month:me:2020/01": { games: [] }, primaryUsername: "me",
  });
  const data = openPopup(storage, fakeServer({}));
  await data.migrateStorage();
  data.restoreLog();
  assert.deepEqual(Object.keys(storage.store).sort(), ["month:me:2020/01", "primaryUsername", "storeVersion"]);
});

// --- step 3: features read the month store ---

// two players' archives. me vs friend games, plus games vs others
function twoPlayerRoutes() {
  const vs = (t, winner, opts = {}) => rawGame(t, {
    white: { username: "Me", result: winner === "me" ? "win" : winner === "draw" ? "agreed" : "resigned", rating: 2100 },
    black: { username: "Friend", result: winner === "friend" ? "win" : winner === "draw" ? "agreed" : "resigned", rating: 2050 },
    ...opts,
  });
  const other = (t) => rawGame(t, { black: { username: "Stranger", result: "resigned", rating: 1900 } });
  const fv = (m) => `${API}/friend/games/${m}`;
  return {
    [`${API}/me/games/archives`]: { body: { archives: ["2020/01", "2020/02", CURRENT].map(monthUrl) }, etag: "ma" },
    [`${API}/friend/games/archives`]: { body: { archives: ["2020/02", CURRENT].map(fv) }, etag: "fa" },
    [monthUrl("2020/01")]: { body: { games: [other(1)] }, etag: "m1" },
    [monthUrl("2020/02")]: { body: { games: [vs(10, "me"), vs(11, "friend", { time_class: "blitz" }), other(12)] }, etag: "m2" },
    [monthUrl(CURRENT)]: { body: { games: [vs(20, "draw"), other(21)] }, etag: "mc" },
    [fv("2020/02")]: { body: { games: [vs(10, "me"), vs(11, "friend", { time_class: "blitz" })] }, etag: "f2" },
    [fv(CURRENT)]: { body: { games: [vs(20, "draw")] }, etag: "fc" },
  };
}

test("head-to-head reads only the primary's months, from the primary's side", async () => {
  const server = fakeServer(twoPlayerRoutes());
  const data = openPopup(fakeStorage(), server);
  const h = await data.fetchHeadToHead("me", "friend");
  data.restoreLog();
  // both archives lists, then only me's two shared months. 2020/01 isn't shared, friend's months untouched
  assert.deepEqual(server.requests.map((r) => r.url.replace(API, "")).sort(),
    ["/friend/games/archives", "/me/games/2020/02", `/me/games/${CURRENT}`, "/me/games/archives"].sort());
  assert.equal(h.total, 3);
  assert.deepEqual([h.aWins, h.draws, h.bWins], [1, 1, 1]);
  assert.deepEqual(h.byTimeClass.blitz, { aWins: 0, bWins: 1, draws: 0, total: 1 });
});

test("head-to-head falls back to the other player's month, turned to the primary's side", async () => {
  const routes = twoPlayerRoutes();
  delete routes[monthUrl("2020/02")]; // primary's month 404s
  const server = fakeServer(routes);
  const data = openPopup(fakeStorage(), server);
  const h = await data.fetchHeadToHead("me", "friend");
  data.restoreLog();
  assert.equal(h.total, 3);
  assert.deepEqual([h.aWins, h.draws, h.bWins], [1, 1, 1]);
  const won = h.games.find((g) => g.t === 10);
  assert.deepEqual([won.score, won.rating, won.oppRating, won.opponent], [1, 2100, 2050, "friend"]);
});

test("head-to-head reopen: finished months come from the derived cache, current month is a 304", async () => {
  const storage = fakeStorage();
  const server = fakeServer(twoPlayerRoutes());
  let data = openPopup(storage, server);
  await data.fetchHeadToHead("me", "friend");
  data.restoreLog();
  age(storage, 10000);
  const before = server.requests.length;
  data = openPopup(storage, server);
  const h = await data.fetchHeadToHead("me", "friend");
  data.restoreLog();
  const again = server.requests.slice(before);
  assert.deepEqual(again.map((r) => r.url.replace(API, "")), [`/me/games/${CURRENT}`]);
  assert.equal(again[0].sentEtag, "mc");
  assert.equal(h.total, 3);
});

test("fetchPlayerHistory: every month, one time class, oldest first, shares the store", async () => {
  const storage = fakeStorage();
  const server = fakeServer(twoPlayerRoutes());
  let data = openPopup(storage, server);
  await data.fetchHeadToHead("me", "friend"); // loads two of me's months
  data.restoreLog();
  age(storage, 10000);
  const before = server.requests.length;
  data = openPopup(storage, server);
  const { games, missingMonths } = await data.fetchPlayerHistory("me", "bullet");
  data.restoreLog();
  // only 2020/01 was new. archives cached, 2020/02 final, current month rechecked
  assert.deepEqual(server.requests.slice(before).map((r) => r.url.replace(API, "")).sort(),
    ["/me/games/2020/01", `/me/games/${CURRENT}`].sort());
  assert.deepEqual(games.map((g) => g.t), [1, 10, 12, 20, 21]);
  assert.deepEqual(missingMonths, []);
});

// --- step 4: cacheOnly reads and /stats ---

test("cacheOnly never makes a request, and says 'never loaded' (undefined) vs 'failed' (null)", async () => {
  const storage = fakeStorage();
  const routes = twoPlayerRoutes();
  delete routes[monthUrl("2020/01")]; // chess.com fails on this one
  const server = fakeServer(routes);
  let data = openPopup(storage, server);
  const opt = { cacheOnly: true };
  // empty storage: nothing to answer with, and no requests
  assert.equal(await data.fetchArchives("me", opt), null);
  assert.equal(await data.fetchMonth("me", "2020/02", opt), undefined);
  assert.equal(await data.fetchStats("me", opt), null);
  assert.equal(await data.fetchPlayerGames("me", () => true, opt), null);
  assert.equal(await data.fetchHeadToHead("me", "friend", () => {}, opt), null);
  assert.equal(server.requests.length, 0);

  // load for real, 2020/01 fails
  await data.fetchPlayerGames("me", () => true);
  data.restoreLog();
  const loaded = server.requests.length;

  data = openPopup(storage, server);
  assert.equal(await data.fetchMonth("me", "2020/01", opt), null); // known missing
  assert.equal((await data.fetchMonth("me", "2020/02", opt)).length, 3);
  // a known-missing month is skipped, not "incomplete"
  assert.equal((await data.fetchPlayerGames("me", () => true, opt)).length, 5);
  data.restoreLog();
  assert.equal(server.requests.length, loaded);
});

test("cacheOnly head-to-head is null until every shared month was loaded, then exact", async () => {
  const storage = fakeStorage();
  const server = fakeServer(twoPlayerRoutes());
  let data = openPopup(storage, server);
  await data.fetchArchives("me");
  await data.fetchArchives("friend");
  await data.fetchMonth("me", CURRENT); // 2020/02 not loaded yet
  assert.equal(await data.fetchHeadToHead("me", "friend", () => {}, { cacheOnly: true }), null);
  await data.fetchHeadToHead("me", "friend");
  data.restoreLog();
  const before = server.requests.length;
  data = openPopup(storage, server);
  const h = await data.fetchHeadToHead("me", "friend", () => {}, { cacheOnly: true });
  data.restoreLog();
  assert.equal(h.total, 3);
  assert.equal(server.requests.length, before);
});

test("/stats lives in local storage and is revalidated with its etag", async () => {
  const storage = fakeStorage();
  const statsUrl = `${API}/me/stats`;
  const server = fakeServer({ [statsUrl]: { body: { chess_bullet: { last: { rating: 2100 } } }, etag: "s1" } });
  let data = openPopup(storage, server);
  const first = await data.fetchStats("me");
  data.restoreLog();
  assert.equal(first.stats.chess_bullet.last.rating, 2100);
  assert.ok(storage.store["stats:me"]); // local, survives a browser restart

  age(storage, 10000);
  data = openPopup(storage, server);
  await data.fetchStats("me");
  data.restoreLog();
  assert.deepEqual(server.requests.map((r) => r.sentEtag), [null, "s1"]); // second one is a 304
});

test("/stats tells 'no such player' (404) apart from a failed request", async () => {
  const storage = fakeStorage();
  const goneUrl = `${API}/typo/stats`;
  const downUrl = `${API}/me/stats`;
  const server = fakeServer({}); // 404 for everything
  const failing = async (url) => {
    if (url === downUrl) throw new TypeError("Failed to fetch");
    return server.fetch(url);
  };
  let data = openPopup(storage, { ...server, fetch: failing });
  globalThis.fetch = failing;
  assert.equal(await data.fetchStats("typo"), null);
  assert.equal(await data.fetchStats("me"), null);
  assert.equal(await data.playerMissing("typo"), true);
  assert.equal(await data.playerMissing("me"), false); // network failure: not "missing"
  assert.equal(await data.fetchStats("typo", { cacheOnly: true }), null);
  data.restoreLog();

  // the account shows up later (typo fixed on chess.com's side, or a new account)
  age(storage, 10000);
  const later = fakeServer({ [goneUrl]: { body: { chess_bullet: { last: { rating: 900 } } }, etag: "t1" } });
  data = openPopup(storage, later);
  assert.equal((await data.fetchStats("typo")).stats.chess_bullet.last.rating, 900);
  assert.equal(await data.playerMissing("typo"), false);
  assert.equal(later.requests[0].sentEtag, null); // a not-found entry has no etag to send
  data.restoreLog();
});

test("one sync never asks for the same current month twice (5s freshness)", async () => {
  const server = fakeServer(twoPlayerRoutes());
  const data = openPopup(fakeStorage(), server);
  await data.fetchPlayerGames("me", () => true); // what sync does first
  const before = server.requests.length;
  await data.fetchHeadToHead("me", "friend");    // then h2h, right after
  data.restoreLog();
  const urls = server.requests.slice(before).map((r) => r.url.replace(API, ""));
  // only friend's archives list. me's current month was fetched a moment ago
  assert.deepEqual(urls, ["/friend/games/archives"]);
});

// --- phase 2: fair play lock ---

const PREVIOUS = (() => { const d = new Date(); return utcMonth(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1)); })();
const livePage = (id) => ({ kind: "game", id, type: "live" });

// me's current month has game 101 (finished). 202 is still being played
function lockRoutes() {
  return {
    [monthUrl(CURRENT)]: { body: { games: [rawGame(1, { url: "https://www.chess.com/game/live/101" })] }, etag: "c1" },
    [monthUrl(PREVIOUS)]: { body: { games: [] }, etag: "p1" },
    [`${API}/me/games/archives`]: { body: { archives: [monthUrl("2020/01"), monthUrl(PREVIOUS), monthUrl(CURRENT)] }, etag: "a" },
    [monthUrl("2020/01")]: { body: { games: [rawGame(2, { url: "https://www.chess.com/game/live/55" })] }, etag: "old" },
  };
}

test("lock: game id in your current month -> unlocked, with its own record", async () => {
  const server = fakeServer(lockRoutes());
  const data = openPopup(fakeStorage(), server);
  const lock = await data.checkGameLock(livePage(101), ["me", "friend"], "me");
  data.restoreLog();
  assert.equal(lock.locked, false);
  assert.equal(lock.record.id, 101);
  assert.equal(lock.record.timeClass, "bullet"); // where "auto" gets this game's time class
});

test("lock: game id not in the archive -> locked, and nothing asked about the opponent", async () => {
  const server = fakeServer(lockRoutes());
  const data = openPopup(fakeStorage(), server);
  const lock = await data.checkGameLock(livePage(202), ["friend", "me"], "me"); // opponent shown first
  data.restoreLog();
  assert.equal(lock.locked, true);
  assert.equal(lock.record, null);
  assert.ok(server.requests.length > 0);
  assert.ok(server.requests.every((r) => r.url.startsWith(`${API}/me/`)), server.requests.map((r) => r.url).join(", "));
});

test("lock: play page with no game id -> locked, no requests at all", async () => {
  const server = fakeServer(lockRoutes());
  const data = openPopup(fakeStorage(), server);
  const lock = await data.checkGameLock({ kind: "play" }, ["me", "friend"], "me");
  data.restoreLog();
  assert.equal(lock.locked, true);
  assert.equal(server.requests.length, 0);
});

test("lock: the game shows up on the next refresh -> unlocks", async () => {
  const storage = fakeStorage();
  const routes = lockRoutes();
  const server = fakeServer(routes);
  let data = openPopup(storage, server);
  assert.equal((await data.checkGameLock(livePage(202), ["me"], "me")).locked, true);
  data.restoreLog();

  // game 202 ends, a minute later the next check runs
  routes[monthUrl(CURRENT)] = {
    body: { games: [rawGame(1, { url: "https://www.chess.com/game/live/101" }), rawGame(3, { url: "https://www.chess.com/game/live/202" })] },
    etag: "c2",
  };
  age(storage, 60000);
  data = openPopup(storage, server);
  const lock = await data.checkGameLock(livePage(202), ["me"], "me");
  data.restoreLog();
  assert.equal(lock.locked, false);
  assert.equal(lock.record.id, 202);
});

test("lock: an old finished game is found in stored months once, with no request for that month", async () => {
  const storage = fakeStorage();
  const server = fakeServer(lockRoutes());
  let data = openPopup(storage, server);
  await data.fetchArchives("me");
  await data.fetchMonth("me", "2020/01"); // in storage from earlier use
  data.restoreLog();
  const before = server.requests.length;
  age(storage, 10000);
  data = openPopup(storage, server);
  const lock = await data.checkGameLock(livePage(55), ["me"], "me", { scanCached: true });
  data.restoreLog();
  assert.equal(lock.locked, false);
  assert.ok(!server.requests.slice(before).some((r) => r.url.endsWith("/2020/01")));
});

// --- pre-game ratings over the month store ---

// me: a rated bullet game at 2092 in 2020/01, then a win to 2100 vs friend (recorded 1692) in 2020/02
function preRoutes() {
  const g = (t, myRating, oppRating, opts = {}) => rawGame(t, {
    url: `https://www.chess.com/game/live/${t}`,
    white: { username: "Me", result: "win", rating: myRating },
    black: { username: "Friend", result: "resigned", rating: oppRating },
    ...opts,
  });
  return {
    [`${API}/me/games/archives`]: { body: { archives: ["2020/01", "2020/02", "2020/03"].map(monthUrl) }, etag: "a" },
    [`${API}/friend/games/archives`]: { body: { archives: ["2020/01", "2020/02"].map((m) => `${API}/friend/games/${m}`) }, etag: "fa" },
    [monthUrl("2020/01")]: { body: { games: [g(1, 2092, 2000)] }, etag: "1" },
    [monthUrl("2020/02")]: { body: { games: [g(2, 2100, 1692)] }, etag: "2" },
    [monthUrl("2020/03")]: { body: { games: [g(3, 2105, 1800)] }, etag: "3" },
  };
}

test("pre-game numbers carry across months, cached as derived:pre tagged with rev", async () => {
  const storage = fakeStorage();
  const data = openPopup(storage, fakeServer(preRoutes()));
  const games = await data.fetchPlayerGames("me", () => true);
  data.restoreLog();
  const byT = Object.fromEntries(games.map((g) => [g.t, g]));
  assert.equal(byT[1].myPre, null); // first rated game ever
  assert.deepEqual([byT[2].myPre, byT[2].myChange, byT[2].oppPre], [2092, 8, 1700]); // from 2020/01's end
  assert.equal(byT[3].myPre, 2100);
  assert.deepEqual(storage.store["derived:pre:me"].ends["2020/01"], { bullet: 2092 });
  assert.equal(storage.store["derived:pre:me"].rev, 0);
});

test("h2h expected total uses pre-game ratings and skips a first rated game", async () => {
  const data = openPopup(fakeStorage(), fakeServer(preRoutes()));
  const h = await data.fetchHeadToHead("me", "friend");
  data.restoreLog();
  assert.equal(h.total, 2);
  assert.equal(h.vsRatings.games, 1); // the 2020/01 game has no rating before it
  const expected = 1 / (1 + Math.pow(10, (1700 - 2092) / 400));
  assert.ok(Math.abs(h.vsRatings.expected - expected) < 1e-9);
});

test("a month chess.com failed on breaks the chain instead of counting as 'no games'", async () => {
  const routes = preRoutes();
  delete routes[monthUrl("2020/02")];
  const storage = fakeStorage();
  const data = openPopup(storage, fakeServer(routes));
  const games = await data.fetchPlayerGames("me", () => true);
  data.restoreLog();
  const march = games.find((g) => g.t === 3);
  assert.equal(march.myPre, null); // february unknown, so march's starting rating is unknown
  assert.equal(storage.store["derived:pre:me"].ends["2020/03"], undefined); // not cached as if complete
});

// --- step 1.4: data as of ---

test("dataAsOf: the older of /stats and the current month, /stats alone if no games this month", async () => {
  const storage = fakeStorage();
  const data = openPopup(storage, fakeServer({}));
  assert.equal(await data.dataAsOf("me"), null); // never fetched
  storage.store["stats:me"] = { stats: {}, fetchedAt: 2000 };
  assert.equal(await data.dataAsOf("me"), 2000); // no current month yet
  storage.store[`monthMeta:me:${CURRENT}`] = { fetchedAt: 1500 };
  assert.equal(await data.dataAsOf("Me"), 1500); // the older one
  data.restoreLog();
});

// --- step 1.5: storage limits ---

test("playersOfKey: whose data each key is", () => {
  const data = openPopup(fakeStorage(), fakeServer({}));
  data.restoreLog();
  assert.deepEqual(data.playersOfKey("month:me:2020/01"), ["me"]);
  assert.deepEqual(data.playersOfKey("monthMeta:me:2020/01"), ["me"]);
  assert.deepEqual(data.playersOfKey("archives:me"), ["me"]);
  assert.deepEqual(data.playersOfKey("stats:me"), ["me"]);
  assert.deepEqual(data.playersOfKey("rev:me"), ["me"]);
  assert.deepEqual(data.playersOfKey("derived:pre:me"), ["me"]);
  assert.deepEqual(data.playersOfKey("derived:h2h:me:friend"), ["me", "friend"]);
  assert.deepEqual(data.playersOfKey("primaryUsername"), []);
  assert.deepEqual(data.playersOfKey("perfSettings"), []);
});

test("eviction: 31 days unviewed -> removed, 29 kept, the primary never, settings untouched", async () => {
  const storage = fakeStorage();
  const now = Date.now();
  const daysAgo = (d) => now - d * 86400 * 1000;
  const playerKeys = (n) => ({
    [`month:${n}:2020/01`]: { games: [] }, [`monthMeta:${n}:2020/01`]: { final: true },
    [`archives:${n}`]: { months: [] }, [`stats:${n}`]: { stats: {} }, [`derived:pre:${n}`]: { ends: {} },
  });
  Object.assign(storage.store, playerKeys("me"), playerKeys("old"), playerKeys("recent"), {
    "derived:h2h:me:old": { months: {} }, "derived:h2h:me:recent": { months: {} },
    primaryUsername: "me", perfSettings: { time: "auto" },
    lastViewed: { me: daysAgo(90), old: daysAgo(31), recent: daysAgo(29) },
  });
  const data = openPopup(storage, fakeServer({}));
  const evicted = await data.evictStalePlayers("me");
  data.restoreLog();
  assert.deepEqual(evicted, ["old"]);
  const keys = Object.keys(storage.store);
  assert.ok(!keys.some((k) => k.includes("old")), keys.join(", ")); // incl. the h2h vs old
  assert.ok(keys.includes("month:me:2020/01")); // primary, even at 90 days
  assert.ok(keys.includes("derived:h2h:me:recent"));
  assert.ok(keys.includes("perfSettings") && keys.includes("primaryUsername"));
  assert.equal(storage.store.lastViewed.old, undefined);
});

test("eviction: data with no lastViewed yet (from before this existed) gets 30 days, not deleted", async () => {
  const storage = fakeStorage();
  Object.assign(storage.store, { "month:legacy:2020/01": { games: [] }, "stats:legacy": { stats: {} } });
  const data = openPopup(storage, fakeServer({}));
  assert.deepEqual(await data.evictStalePlayers("me"), []);
  data.restoreLog();
  assert.ok(storage.store["month:legacy:2020/01"]);
  assert.ok(Date.now() - storage.store.lastViewed.legacy < 5000);
});

test("markViewed + maintain: rechecks old months only for the primary and players still kept", async () => {
  const storage = fakeStorage();
  const server = fakeServer(twoPlayerRoutes());
  let data = openPopup(storage, server);
  await data.fetchPlayerGames("me", () => true);
  await data.fetchHeadToHead("me", "friend");
  await data.fetchPlayerGames("friend", () => true);
  await data.markViewed(["me", "Friend"]);
  data.restoreLog();
  // both players' old months were last checked 31 days ago, friend last viewed 31 days ago
  for (const [k, v] of Object.entries(storage.store)) if (k.startsWith("monthMeta:")) v.checkedAt = Date.now() - 31 * 86400 * 1000;
  storage.store.lastViewed.friend = Date.now() - 31 * 86400 * 1000;

  data = openPopup(storage, server);
  const before = server.requests.length;
  const { evicted, changed } = await data.maintain("me");
  data.restoreLog();
  assert.deepEqual(evicted, ["friend"]);
  assert.deepEqual(changed, []);
  const rechecked = server.requests.slice(before).map((r) => r.url.replace(API, ""));
  assert.ok(rechecked.length > 0 && rechecked.every((u) => u.startsWith("/me/")), rechecked.join(", "));
});

// --- race: journey as a derived cache ---

// me's bullet games: 70 rated in 2020/01, a climb in 2020/02, a few more this month
function journeyRoutes() {
  let n = 0;
  const g = (t, rating, opts = {}) => rawGame(t, {
    url: `https://www.chess.com/game/live/${++n}`, time_class: "bullet",
    white: { username: "Me", result: "win", rating }, black: { username: "Friend", result: "resigned", rating: 1500 },
    ...opts,
  });
  const jan = Array.from({ length: 70 }, (_, i) => g(1577836800 + i * 3600, 1500 + (i % 3)));
  const feb = Array.from({ length: 40 }, (_, i) => g(1580515200 + i * 3600, 1500 + i * 15));
  const nowS = Math.floor(Date.now() / 1000);
  const cur = [g(nowS - 7200, 2090), g(nowS - 3600, 2110), g(nowS - 1800, 2105, { rated: false })];
  return {
    [`${API}/me/games/archives`]: { body: { archives: ["2020/01", "2020/02", CURRENT].map(monthUrl) }, etag: "a" },
    [monthUrl("2020/01")]: { body: { games: jan }, etag: "j" },
    [monthUrl("2020/02")]: { body: { games: feb }, etag: "f" },
    [monthUrl(CURRENT)]: { body: { games: cur }, etag: "c" },
  };
}

test("journey cache: saved through the last finished month, reopen only adds the current month", async () => {
  const storage = fakeStorage();
  const server = fakeServer(journeyRoutes());
  let data = openPopup(storage, server);
  const first = await data.fetchJourney("me", "bullet");
  data.restoreLog();
  const cached = storage.store["derived:journey:me:bullet"];
  assert.equal(cached.through, "2020/02");
  assert.equal(cached.state.ratedCount, 110); // jan + feb, not the current month
  assert.deepEqual([first.ratedCount, first.unratedCount], [112, 1]);

  // the same answer as folding every game from scratch
  const all = [];
  for (const m of ["2020/01", "2020/02", CURRENT]) all.push(...(await openPopup(storage, server).fetchMonth("me", m, { cacheOnly: true })));
  const { rated, ...scratch } = journeyOf(all, Date.now());
  const { missingMonths, ...fromCache } = first;
  delete scratch.currentDay; delete fromCache.currentDay; delete fromCache.rated;
  assert.deepEqual(fromCache, scratch);

  // reopen 10s later: only the current month is checked (a 304)
  age(storage, 10000);
  const before = server.requests.length;
  data = openPopup(storage, server);
  const again = await data.fetchJourney("me", "bullet");
  data.restoreLog();
  const urls = server.requests.slice(before).map((r) => r.url.replace(API, ""));
  assert.deepEqual(urls.filter((u) => /\/games\/\d/.test(u)), [`/me/games/${CURRENT}`]);
  assert.equal(again.ratedCount, 112);
});

test("journey cache: a rev change rebuilds it, a failed month stops the save point", async () => {
  const storage = fakeStorage();
  const routes = journeyRoutes();
  delete routes[monthUrl("2020/02")];
  let data = openPopup(storage, fakeServer(routes));
  const j = await data.fetchJourney("me", "bullet");
  data.restoreLog();
  assert.deepEqual(j.missingMonths, ["2020/02"]);
  assert.equal(storage.store["derived:journey:me:bullet"].through, "2020/01"); // not past the gap

  storage.store["rev:me"] = 1; // an old month was corrected
  data = openPopup(storage, fakeServer(journeyRoutes()));
  await data.fetchJourney("me", "bullet");
  data.restoreLog();
  const after = storage.store["derived:journey:me:bullet"];
  assert.deepEqual([after.rev, after.through], [1, "2020/02"]);
});
