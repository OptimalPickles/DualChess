// flow: scrape tab -> fair play lock (in-progress game = show nothing) -> get/ask primary ->
// figure out mode -> render() from cache right away,
// then sync() from chess.com in the background (and every 60s), re-rendering only on changes.
// the details live in the comparison tab (compare/), which reads what sync() saves
// logs start with "[Performance]". popup logs: right-click icon > Inspect popup.
// scrapeChessPage logs show in the chess.com tab's own console

// Key used in chrome.storage.local to remember "you" between popup opens
const STORAGE_KEY_PRIMARY_USERNAME = "primaryUsername";
const REFRESH_MS = 60 * 1000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;

// what init() found, reused by every render and sync
let current = null;
let refreshTimer = null;
let refreshDelay = REFRESH_MS;

// null if the active tab isn't chess.com
async function getActiveChessTabData() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

  if (!tab || !tab.url || !tab.url.includes("chess.com")) {
    return null;
  }

  const scraped = await scrapeTab(tab.id);
  if (!scraped) return null;
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

// the popup always uses the last 20 games, rated and unrated. the comparison tab has the
// range and rated dropdowns
const POPUP_RANGE = { range: "games:20", rated: "all" };

// --- render from cache, sync from chess.com -------------------------------
// render() never touches the network. it builds everything from storage and only
// redraws when the words on screen changed. sync() is the only thing that makes requests,
// and it calls render() once new data is saved.

// the shadow needs the full history, which only the comparison tab downloads. read from
// storage once per time class, and again only when the stored games change
let shadowMemo = { key: null, window: null };
async function shadowWindowFromCache(username, timeClass, now) {
  const key = `${username}:${timeClass}:${await getRevision(username)}`;
  if (shadowMemo.key === key) return shadowMemo.window;
  let window = null;
  // null unless every finished month is stored
  if (await fetchJourney(username, timeClass, { cacheOnly: true })) {
    const records = await recentRecords(username, timeClass, 0);
    if (records) window = shadowWindow(records, 90, now, calibrateK(records)?.K ?? 16);
  }
  shadowMemo = { key, window };
  return window;
}

// one player's big number, as words: { name, level, label, inactive, official } or
// { name, problem }. p = loadPerformance, data = fetchStats
function levelModel(name, username, data, missing, p, now) {
  if (!data) {
    return { name, problem: missing ? `No chess.com player named ${username}.` : `Couldn't load ${username}'s ratings. Try again in a minute.` };
  }
  const level = currentLevel(p);
  if (!level) return { name, problem: p ? `No ${p.timeClass} rating yet.` : "No recent games saved yet." };
  // the last game in this time class: the stored 6 months, else /stats for anyone quieter
  const statsLast = data.stats[`chess_${p.timeClass}`]?.last?.date ?? null;
  return {
    name,
    level: level.rating,
    label: level.label,
    inactive: inactiveText(p.lastEndTime ?? statsLast, now),
    official: officialText(level, p.official),
  };
}

// the "More details" column for one player: the last 90 days, and stability
async function formColumn(username, timeClass, perf, now) {
  const all = await fetchPlayerGames(username, () => true, { cacheOnly: true });
  return { ...recentForm(all ? filterGames(all, { timeClass, rated: "all" }) : [], now), stability: stabilityShort(perf?.stability) };
}

// everything the popup shows, as words and numbers, from storage alone
async function buildView() {
  const { entries, pair, mode, primary } = current;
  const opt = { cacheOnly: true };
  const settings = { ...(await loadSettings()), ...POPUP_RANGE };
  const now = Date.now();
  // you, for the Me view, plus whoever's on the page (spectating: two other people)
  const people = [...new Set([primary, ...entries.map((e) => e.username)])];
  const stats = Object.fromEntries(await Promise.all(people.map(async (u) => [u, await fetchStats(u, opt)])));
  const missing = Object.fromEntries(await Promise.all(people.map(async (u) => [u, stats[u] ? false : await playerMissing(u)])));
  const { timeClass, source } = await resolveTimeClass(settings, entries.map((e) => stats[e.username]));

  const perfOf = (u, opponent) => loadPerformance(u, stats[u], now, settings, timeClass, opponent);
  const mePerf = await perfOf(primary, null);
  const view = {
    timeClass,
    autoText: timeClass && source ? `auto (${timeClass}, ${source})` : "auto",
    complete: people.every((u) => missing[u] || stats[u]) && (!timeClass || mePerf),
  };

  const asOfs = await Promise.all(people.map((u) => dataAsOf(u)));
  view.updated = asOfs.every((t) => t != null) ? `Updated ${formatAsOf(Math.min(...asOfs), now)}` : "";

  view.me = {
    ...levelModel(null, primary, stats[primary], missing[primary], mePerf, now),
    today: todayParts(mePerf?.session, now),
    shadow: timeClass && stats[primary] ? shadowLine(await shadowWindowFromCache(primary, timeClass, now)) : null,
  };
  if (!pair) return view;

  // the two columns, left to right. profile and playing: you on the left
  const perfs = await Promise.all(pair.map((u, i) => perfOf(u, pair[1 - i])));
  view.complete = view.complete && perfs.every((p, i) => p || missing[pair[i]] || !timeClass);
  const names = pair.map((u) => (u === primary ? "You" : u));
  view.columns = pair.map((u, i) => levelModel(names[i], u, stats[u], missing[u], perfs[i], now));

  // the head-to-head in this time class only, rated and unrated
  const h2hAll = await fetchHeadToHead(pair[0], pair[1], () => {}, opt);
  const h2h = filterHeadToHead(h2hAll, { timeClass, rated: POPUP_RANGE.rated }, now);
  const matchup = h2h && isRivalry(h2h.games) ? matchupOf(perfs, h2h, now) : null;
  // the matchup's own expectation when there is one, else by current level
  const expected = matchup?.blended
    ? expectedScore(matchup.blended.me, matchup.blended.opp)
    : matchupPrediction(pair, perfs)?.expected;
  view.prediction = expected == null ? null : { ...predictionParts(names[0], expected, h2h, !current.h2hSynced), share: expected };
  view.compareToday = mode === "playing" ? todayParts(perfs[0]?.session, now) : null;

  // folded away: a table of the last 90 days and stability, then the pair's own lines
  const cols = timeClass ? await Promise.all(pair.map((u, i) => formColumn(u, timeClass, perfs[i], now))) : [];
  view.more = {
    names,
    rows: cols.length === 2
      ? [
          ["Games, last 90 days", "games"],
          ["Win · draw · loss", "wdl"],
          ["Peak, last 90 days", "peak"],
          ["Average opponent", "avgOpp"],
          ["Stability", "stability"],
        ].map(([label, key]) => [label, cols[0][key], cols[1][key]])
      : [],
    lines: [
      ...(matchup?.blended ? [matchupLine(pair[0], pair[1], primary, matchup.blended)] : []),
      ...(h2h ? [last30Text(h2h.last30)] : []),
    ],
    recent: (h2h?.games ?? []).slice(0, RECENT_GAMES_SHOWN).map((g) => ({
      text: `${g.score === 1 ? "W" : g.score === 0 ? "L" : "D"} · ${g.timeClass} · ${fmtDate(g.t)}`,
      url: gameUrl(g),
    })),
  };
  return view;
}

let renderGen = 0;
let lastSignature = null;

const el = (tag, text, className) => {
  const node = document.createElement(tag);
  if (text != null) node.textContent = text;
  if (className) node.className = className;
  return node;
};

// a player's level. solo (Me): the number with its details beside it. a column (Compare):
// name on top. the dot always comes with its word (High / Medium / Low)
function renderLevel(container, m, { solo = false } = {}) {
  container.innerHTML = "";
  container.classList.toggle("player--low", m.label === "Low");
  if (m.name) container.appendChild(el("div", m.name, "name"));
  if (m.problem) {
    container.appendChild(el("div", m.problem, "official"));
    return;
  }
  container.appendChild(el("div", String(m.level), "level"));
  const meta = solo ? el("div", null, "meta") : container;
  meta.appendChild(el("div", m.label, `conf conf--${{ High: "high", Medium: "med", Low: "low" }[m.label]}`));
  meta.appendChild(el("div", m.official, "official"));
  if (m.inactive) meta.appendChild(el("div", m.inactive, "stale"));
  if (solo) container.appendChild(meta);
}

// "Today: 4W 1D 1L · 70 above your usual" and "Shadow 2165 · ...", key muted, figure bold
function line(key, bold, rest, caveat) {
  const li = el("li", null, "line");
  li.append(el("span", key, "k"), " ", el("b", bold), rest);
  if (caveat) li.appendChild(el("p", caveat, "caveat"));
  return li;
}

function renderLines(id, lines) {
  const list = document.getElementById(id);
  list.innerHTML = "";
  for (const li of lines) list.appendChild(li);
  list.hidden = !lines.length;
}

// the details table: a column per player, in their colors, then the pair's own lines
function renderMore(more) {
  const table = document.getElementById("more-table");
  table.innerHTML = "";
  const head = el("tr");
  head.append(el("th"), el("th", more.names[0], "you"), el("th", more.names[1], "opp"));
  table.appendChild(el("thead")).appendChild(head);
  const body = table.appendChild(el("tbody"));
  for (const [label, a, b] of more.rows) {
    const tr = el("tr");
    tr.append(el("th", label), el("td", a), el("td", b));
    body.appendChild(tr);
  }
  const extra = document.getElementById("more-extra");
  extra.innerHTML = "";
  for (const text of more.lines) extra.appendChild(el("p", text));
  if (more.recent.length) {
    const list = el("ul", null, "recent");
    for (const g of more.recent) {
      const a = el("a", g.text);
      a.href = g.url;
      a.target = "_blank";
      list.appendChild(el("li")).appendChild(a);
    }
    extra.appendChild(list);
  }
}

// final = sync has run, so missing numbers are real failures, not "still loading".
// returns true if there's something to show
async function render({ final = false } = {}) {
  if (!current) return false;
  const gen = ++renderGen;
  const view = await buildView();
  // a newer render started while this one was reading storage
  if (gen !== renderGen) return false;
  // nothing cached yet: keep "loading" up
  if (!view.complete && !final) return false;

  // the view is already words, so "changed" means the words changed
  const signature = JSON.stringify(view);
  if (signature === lastSignature) return true;
  lastSignature = signature;
  console.log("[Performance] render:", view);

  document.querySelector('#ctl-time option[value="auto"]').textContent = view.autoText;
  document.getElementById("updated").textContent = view.updated;
  current.timeClass = view.timeClass;

  // Me
  renderLevel(document.getElementById("me-level"), view.me, { solo: true });
  const me = [];
  if (view.me.today) me.push(line("Today:", view.me.today.wdl, view.me.today.rest));
  if (view.me.shadow) me.push(line("Shadow", view.me.shadow.level, view.me.shadow.rest, view.me.shadow.flags.join(". ")));
  renderLines("me-lines", me);
  document.getElementById("open-stats").hidden = !view.timeClass;

  // Compare
  if (view.columns) {
    view.columns.forEach((m, i) => renderLevel(document.getElementById(`col-${i}`), m));
    // a long username doesn't fit half the width: one row per player instead
    document.getElementById("players").classList.toggle("players--stacked", view.columns.some((m) => m.name.length > 13));
    const pred = view.prediction;
    document.getElementById("prediction").hidden = !pred;
    if (pred) {
      const text = document.getElementById("prediction-text");
      text.innerHTML = "";
      text.append(pred.lead, el("strong", pred.pct), pred.tail);
      document.getElementById("bar-you").style.width = `${Math.round(pred.share * 100)}%`;
    }
    const today = view.compareToday;
    renderLines("compare-lines", today ? [line("Today:", today.wdl, today.rest)] : []);
    renderMore(view.more);
    document.getElementById("open-compare").hidden = !view.timeClass;
  }

  document.body.classList.remove("is-loading");
  return true;
}

let syncGen = 0;

// the only place that asks chess.com for anything (besides the fair play check): /stats,
// the newest 6 months of each player, and the h2h months. mostly 304s after the first time.
// the comparison tab reads all of it from storage
async function sync() {
  if (!current) return;
  const gen = ++syncGen;
  const stale = () => gen !== syncGen;
  clearTimeout(refreshTimer);

  const { entries, pair, primary } = current;
  const statusEl = document.getElementById("status");
  // you (for the Me view) plus whoever's on the page
  const people = [...new Set([primary, ...entries.map((e) => e.username)])];
  let ok = true;

  try {
    const stats = await Promise.all(people.map((u) => fetchStats(u)));
    const games = await Promise.all(people.map((u) => fetchPlayerGames(u, () => true)));
    if (stale()) return;
    ok = stats.every(Boolean) && games.every(Boolean);
    statusEl.textContent = "";
    await render({ final: true });

    if (pair) {
      // a first scan can be dozens of months. a reopen is just this month, no need to say so
      const onProgress = (done, total) => {
        if (total > 1 && !stale()) statusEl.textContent = `Scanning games ${done}/${total} months…`;
      };
      const h2h = await fetchHeadToHead(pair[0], pair[1], onProgress);
      if (stale()) return;
      ok = ok && Boolean(h2h);
      current.h2hSynced = true;
      statusEl.textContent = "";
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

// fair play lock: both views are replaced by one line, and the only thing still running
// is the lock check itself, every 60s (and on tab changes)
// the header stays, but says nothing about the game: no "auto (bullet, this game)", no
// updated time, nothing to switch to
function showLocked() {
  current = null;
  document.getElementById("status").textContent = "";
  document.getElementById("main").hidden = false;
  document.getElementById("lock").hidden = false;
  for (const id of ["view-me", "view-compare", "no-opponent"]) document.getElementById(id).hidden = true;
  document.getElementById("updated").textContent = "";
  document.querySelector('#ctl-time option[value="auto"]').textContent = "auto";
  document.getElementById("ctl-time").disabled = true;
  for (const button of document.querySelectorAll("#views button")) button.disabled = true;
  refreshTimer = setTimeout(() => init(), REFRESH_MS);
}

// --- views ---
// Me: just you. Compare: you (or the left player) and whoever else is on the page

function showView(name) {
  for (const view of ["me", "compare"]) document.getElementById(`view-${view}`).hidden = view !== name;
  for (const button of document.querySelectorAll("#views button")) {
    button.setAttribute("aria-pressed", String(button.dataset.view === name));
  }
}

async function init() {
  const gen = ++initGen;
  const statusEl = document.getElementById("status");
  const main = document.getElementById("main");

  current = null;
  clearTimeout(refreshTimer);
  // anything still running from before can't draw over this
  syncGen++;
  renderGen++;
  main.hidden = true;
  document.getElementById("lock").hidden = true;
  document.getElementById("ctl-time").disabled = false;
  for (const button of document.querySelectorAll("#views button")) button.disabled = false;
  statusEl.textContent = "Loading…";
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
    // game is fetched or shown
    const saved =
      (await chrome.storage.local.get(STORAGE_KEY_PRIMARY_USERNAME))[STORAGE_KEY_PRIMARY_USERNAME] ?? null;
    const lock = await tabLock(tabData.tab.url, tabData.scraped, saved);
    if (gen !== initGen) return;
    if (lock.locked) {
      showLocked();
      return;
    }

    statusEl.textContent = "";
    const primaryUsername = await getPrimaryUsername(tabData.scraped.playersOnPage);
    if (gen !== initGen) return;

    if (!primaryUsername) {
      statusEl.textContent = "No username set - try again.";
      return;
    }

    const { mode, others } = resolveMode(primaryUsername, tabData.scraped.playersOnPage);

    // entries = who's on the page and gets stats, pair = the two in Compare (left, right).
    // playing and profile: you on the left. spectating: the first player on the page
    let pair = null;
    if (mode === "playing" || mode === "profile") pair = [primaryUsername, others[0].username];
    else if (mode === "spectating") pair = [others[0].username, others[1].username];
    const entries = (pair ?? [primaryUsername]).map((username) => ({ username }));

    const settings = await loadSettings();
    document.getElementById("ctl-time").value = settings.time;

    current = { entries, pair, mode, primary: primaryUsername, gameRecord: lock.record };
    lastSignature = null;

    // Compare when there's someone to compare with, Me otherwise
    const compareBtn = document.querySelector('#views button[data-view="compare"]');
    compareBtn.disabled = !pair;
    document.getElementById("no-opponent").hidden = Boolean(pair);
    showView(pair ? "compare" : "me");
    main.hidden = false;

    // anyone shown keeps their stored data for another 30 days
    await markViewed([primaryUsername, ...entries.map((e) => e.username)]);

    // cached numbers first, instantly. then check chess.com for anything new
    if (!(await render())) statusEl.textContent = "Loading recent games…";
    await sync();

    // upkeep, last so it never holds anything up: old players out, a few old months rechecked.
    // if a recheck found a corrected month for someone on screen, show the new numbers
    if (gen !== initGen) return;
    const { changed } = await maintain(primaryUsername);
    if (gen === initGen && changed.some((n) => n === primaryUsername || entries.some((e) => e.username === n))) {
      await render({ final: true });
    }
  } catch (err) {
    console.error("[Performance] init() failed:", err);
    statusEl.textContent = "Something went wrong - check the popup's console (right-click the extension icon > Inspect popup).";
  } finally {
    document.body.classList.remove("is-loading");
  }
}

// save the choice and redo everything with it. both views use it
document.getElementById("ctl-time").addEventListener("change", async (e) => {
  const settings = await loadSettings();
  await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, time: e.target.value } });
  console.log(`[Performance] time -> ${e.target.value}`);
  // everything needed is already in storage, so this makes no requests
  await render({ final: true });
});

for (const button of document.querySelectorAll("#views button")) {
  button.addEventListener("click", () => showView(button.dataset.view));
}

// the details, in their own tab, on this time class
function openCompareTab(a, b) {
  if (!current?.timeClass) return;
  const params = new URLSearchParams({ a });
  if (b) params.set("b", b);
  params.set("tc", current.timeClass);
  chrome.tabs.create({ url: chrome.runtime.getURL(`compare/compare.html?${params}`) });
}
document.getElementById("open-stats").addEventListener("click", () => openCompareTab(current?.primary));
document.getElementById("open-compare").addEventListener("click", () => current?.pair && openCompareTab(...current.pair));

// clears the saved username and asks again
document
  .getElementById("change-account")
  .addEventListener("click", async () => {
    await chrome.storage.local.remove(STORAGE_KEY_PRIMARY_USERNAME);
    console.log("[Performance] Cleared saved primary username - re-asking.");
    init();
  });

document.addEventListener("DOMContentLoaded", () => init());

// a different tab, or a new url in this one (a game starting or ending), is a different page
if (chrome.tabs?.onActivated) {
  chrome.tabs.onActivated.addListener(() => init());
  chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
    if (tab.active && info.url) init();
  });
}

// suggestions:
// - "spectating" only compares the first two names found. a third name on the page gets ignored
