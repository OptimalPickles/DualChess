// fair play: chess.com doesn't allow extensions that help during a game, so while a
// game is in progress we show nothing about it or its players. everything here only
// looks at the url and usernames, never the board, moves, or clocks. pure, runs in node

// what kind of chess.com page this is, from its url alone
//   game:  /game/live/<id>, /game/daily/<id>, /game/<id>, /analysis/game/live/<id>
//   play:  /play/..., /live, or /game with no id. a game could be starting or running
//   other: profiles, home, everything else
// an optional locale prefix like /es/ is allowed
function parsePage(url) {
  let path;
  try {
    path = new URL(url).pathname;
  } catch {
    return { kind: "other" };
  }
  const game = path.match(/\/game\/(?:(live|daily)\/)?(\d+)/);
  if (game) return { kind: "game", id: Number(game[2]), type: game[1] ?? null };
  if (/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?(play|live|game)(\/|$)/i.test(path)) return { kind: "play" };
  return { kind: "other" };
}

// this page's game in a list of records, if it's there. live and daily ids are
// separate number sequences, so the kind has to match too when the url says it
function findGame(records, page) {
  return (
    records.find(
      (r) => r.id === page.id && (page.type == null || (page.type === "daily") === (r.timeClass === "daily"))
    ) ?? null
  );
}

// whose archive to look in: yours if you're in the game, so nothing gets asked about
// your opponent. otherwise (spectating) the first player on the page
function lockCheckUser(onPage, primary) {
  if (primary && onPage.includes(primary)) return primary;
  return onPage[0] ?? null;
}

// a game only counts as finished once we've found it in the archive. unsure = locked
function isGameInProgress(page, record) {
  if (page.kind === "play") return true;
  if (page.kind === "game") return !record;
  return false;
}

const LOCKED_TEXT = "Game in progress. Stats will appear when it ends.";

// node gets module.exports, the popup just gets globals from the script tag
if (typeof module !== "undefined") {
  module.exports = { parsePage, findGame, lockCheckUser, isGameInProgress, LOCKED_TEXT };
}
