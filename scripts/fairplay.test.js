// run: node --test scripts/fairplay.test.js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const f = require("./fairplay.js");

test("parsePage: game pages, with or without a type or locale", () => {
  assert.deepEqual(f.parsePage("https://www.chess.com/game/live/174288275536"), { kind: "game", id: 174288275536, type: "live" });
  assert.deepEqual(f.parsePage("https://www.chess.com/game/daily/993746602"), { kind: "game", id: 993746602, type: "daily" });
  assert.deepEqual(f.parsePage("https://www.chess.com/game/180016177348?move=3"), { kind: "game", id: 180016177348, type: null });
  assert.deepEqual(f.parsePage("https://www.chess.com/analysis/game/live/173848441914"), { kind: "game", id: 173848441914, type: "live" });
  assert.deepEqual(f.parsePage("https://www.chess.com/es/game/live/1"), { kind: "game", id: 1, type: "live" });
});

test("parsePage: play pages with no game id lock", () => {
  for (const url of [
    "https://www.chess.com/play/online",
    "https://www.chess.com/play/computer",
    "https://www.chess.com/live",
    "https://www.chess.com/game",
    "https://www.chess.com/es/play/online",
  ]) {
    assert.equal(f.parsePage(url).kind, "play", url);
    assert.equal(f.isGameInProgress(f.parsePage(url), null), true, url);
  }
});

test("parsePage: everything else is not a game", () => {
  for (const url of [
    "https://www.chess.com/member/hikaru",
    "https://www.chess.com/games/archive/hikaru",
    "https://www.chess.com/home",
    "",
    undefined,
  ]) {
    assert.equal(f.parsePage(url).kind, "other", String(url));
  }
});

test("findGame matches the id, and live vs daily when the url says which", () => {
  const records = [
    { id: 5, timeClass: "bullet" },
    { id: 7, timeClass: "daily" },
  ];
  assert.equal(f.findGame(records, { id: 5, type: "live" }).id, 5);
  assert.equal(f.findGame(records, { id: 5, type: "daily" }), null); // same number, other sequence
  assert.equal(f.findGame(records, { id: 7, type: "daily" }).id, 7);
  assert.equal(f.findGame(records, { id: 7, type: null }).id, 7); // /game/<id> doesn't say
  assert.equal(f.findGame(records, { id: 9, type: "live" }), null);
});

test("lockCheckUser: your own archive when you're playing, else the first player shown", () => {
  assert.equal(f.lockCheckUser(["friend", "me"], "me"), "me");
  assert.equal(f.lockCheckUser(["a", "b"], "me"), "a");
  assert.equal(f.lockCheckUser(["a", "b"], null), "a");
  assert.equal(f.lockCheckUser([], "me"), null);
});

test("isGameInProgress: a game page unlocks only with its record found", () => {
  const page = { kind: "game", id: 5, type: "live" };
  assert.equal(f.isGameInProgress(page, null), true);
  assert.equal(f.isGameInProgress(page, { id: 5 }), false);
  assert.equal(f.isGameInProgress({ kind: "other" }, null), false);
});
