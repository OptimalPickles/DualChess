// run: node --test scripts/data.test.js
// offline: a fake chess.com and a fake chrome.storage, so request counts are exact
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");

// data.js uses summarizeForPlayer etc as globals, like in the popup
Object.assign(globalThis, require("./performance.js"));

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
