// the full comparison tab: every detail for a (and b, if there is one), from storage alone.
// the popup's sync is what fills storage, this page never asks chess.com for those numbers.
// the one thing it downloads is a full history, for the race, climb and shadow rating, and
// a big one is asked about first.
// opened from the popup as compare.html?a=<user>&b=<opponent>&tc=<time class>
// fair play: checks every open chess.com tab, and while any has a game in progress the
// page shows the lock message and nothing else

const LOCK_CHECK_MS = 60 * 1000;

// what the url asked for, plus what's worked out from it. same shape as the popup's
let current = null;

// the primary user is "You" everywhere, everyone else by username
const sayName = (name) => (current?.primary && name === current.primary ? "You" : name);

// --- players ---

function renderPlayer(container, username, data, state) {
  container.innerHTML = "";
  const heading = document.createElement("p");
  heading.className = "player-name";
  heading.textContent = username === current.primary ? `You · ${username}` : username;
  container.appendChild(heading);

  // one clear line instead of numbers next to an empty card
  if (!data) {
    const error = document.createElement("p");
    error.className = "perf-sub";
    error.textContent =
      state === "missing"
        ? `No chess.com player named ${username}. Check the spelling.`
        : `${username}'s ratings aren't saved yet. Open the extension on a chess.com page with ${username} first.`;
    container.appendChild(error);
    return;
  }

  // official ratings: Rapid / Blitz / Bullet / Daily. "—" if they've never played it
  const table = document.createElement("table");
  table.className = "ratings";
  const head = document.createElement("tr");
  const values = document.createElement("tr");
  for (const tc of ["rapid", "blitz", "bullet", "daily"]) {
    const th = document.createElement("th");
    th.textContent = tc[0].toUpperCase() + tc.slice(1);
    head.appendChild(th);
    const td = document.createElement("td");
    td.textContent = data.stats[`chess_${tc}`]?.last?.rating ?? "—";
    values.appendChild(td);
  }
  table.append(head, values);
  container.appendChild(table);
}

// appends under the player's card, after renderPlayer
function renderPerformance(container, p, now) {
  const line = (text, className) => {
    const el = document.createElement("p");
    el.textContent = text;
    el.className = className;
    container.appendChild(el);
  };

  if (!p) {
    line("Recent games aren't saved yet.", "perf-sub");
    return;
  }

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
        `${fmtCount(p.count)} game${p.count === 1 ? "" : "s"} · last game ${timeAgo(p.lastEndTime, now)}`,
      "perf-sub"
    );
  }

  // asked for n games, got fewer: say how many and how far back we looked
  if (p.requested && p.count < p.requested) {
    const since = p.searchedSince ? ` since ${fmtDate(p.searchedSince)}` : "";
    line(
      p.count
        ? `Only ${fmtCount(p.count)} of ${fmtCount(p.requested)} ${p.timeClass} games found${since}.`
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
}

// --- prediction and matchup ---

// "When you play each other: You 2027 vs legendary9000 1854 (±55)"
function renderMatchup(container, matchup) {
  container.innerHTML = "";
  if (!matchup) return;
  const line = (text, className) => {
    const el = document.createElement("p");
    el.textContent = text;
    if (className) el.className = className;
    container.appendChild(el);
  };
  const [a, b] = current.pair;
  const youA = a === current.primary;
  const say = sayName;
  const [fa, fb] = matchup.fields;
  const fieldText = (name, f) =>
    f?.perf != null ? `${say(name)} ${f.perf} ± ${Math.round(f.error)} (${f.conf?.label ?? "Low"})` : `${say(name)} —`;

  const m = matchup.blended;
  if (!m) {
    line("Not enough reliable games to rate this matchup", "h2h-title");
  } else {
    const when = youA ? "When you play each other" : `When ${a} and ${b} play each other`;
    line(`${when}: ${say(a)} ${Math.round(m.me)} vs ${say(b)} ${Math.round(m.opp)} (±${Math.round(m.error)})`, "h2h-title");
    // how each plays in this matchup compared to against everyone else. only with both
    // anchors: with one, that player's matchup rating IS their field rating (always +0),
    // and the other's field rating wasn't trusted enough to anchor in the first place
    if (m.anchors.me && m.anchors.opp) {
      const dB = Math.round(m.opp - fb.perf);
      const dA = Math.round(m.me - fa.perf);
      const theirs = `${b} plays ${dB >= 0 ? `+${dB} above` : `${-dB} below`} their field level against ${youA ? "you" : a}`;
      const mine = youA ? `you play ${dA >= 0 ? "+" : ""}${dA} vs yours` : `${a} plays ${dA >= 0 ? "+" : ""}${dA} vs theirs`;
      line(`${theirs}; ${mine}`, "h2h-sub");
    }
    const whose = (name) => (name === current.primary ? "your" : `${name}'s`);
    const anchors =
      m.anchors.me && m.anchors.opp
        ? "Anchored on both field ratings"
        : m.anchors.me
          ? `Anchored on ${whose(a)} field rating (${whose(b)} isn't reliable enough)`
          : `Anchored on ${whose(b)} field rating (${whose(a)} isn't reliable enough)`;
    line(anchors, "h2h-sub");
  }
  line(`Field ratings, without each other: ${fieldText(a, fa)} · ${fieldText(b, fb)}`, "h2h-sub");
}

// with a matchup rating, both expectations show
function renderPrediction(container, pred, h2h, matchup) {
  container.innerHTML = "";
  const line = (text, className) => {
    const el = document.createElement("p");
    el.textContent = text;
    if (className) el.className = className;
    container.appendChild(el);
  };
  if (!pred) {
    line("Not enough saved games to predict this matchup.", "h2h-sub");
    return;
  }

  let h2hText = " · h2h unavailable";
  if (h2h?.total) {
    const actual = (h2h.aWins + h2h.draws / 2) / h2h.total;
    h2hText = ` · h2h actual ${pct(actual)} (${fmtCount(h2h.total)} games)`;
  } else if (h2h) {
    h2hText = " · no h2h games yet";
  }
  const forMatchup = matchup?.blended ? ` · expected for this matchup ${pct(expectedScore(matchup.blended.me, matchup.blended.opp))}` : "";
  line(`${sayName(pred.a.username)}: expected by current level ${pct(pred.expected)}${forMatchup}${h2hText}`, "h2h-title");
  line(
    `${sayName(pred.a.username)} ${pred.a.rating} (${pred.a.source}) vs ${sayName(pred.b.username)} ${pred.b.rating} (${pred.b.source})`,
    "h2h-sub"
  );

  const v = h2h?.vsRatings;
  if (v?.games) {
    const diff = Math.round(v.actual - v.expected);
    line(
      `h2h score ${fmtScore(v.actual)} vs ${fmtCount(v.expected)} expected from ratings at the time (${diff >= 0 ? "+" : ""}${fmtCount(diff)})`,
      "h2h-sub"
    );
  }
}

// --- head-to-head ---

// everything is from h2h.a's side
function renderHeadToHead(container, h2h) {
  container.innerHTML = "";
  const line = (text, className) => {
    const p = document.createElement("p");
    p.textContent = text;
    if (className) p.className = className;
    container.appendChild(p);
    return p;
  };

  if (!h2h) {
    line("Head-to-head games aren't saved yet. Open the extension on a page with both players to load them.");
    return;
  }
  const filterText = `${h2h.opts.timeClass}${h2h.opts.rated === "all" ? "" : `, ${h2h.opts.rated}`}`;
  if (!h2h.total) {
    // say if there are games, just not in this time class / rated setting
    const other = h2h.allTotal ? ` (${fmtCount(h2h.allTotal)} in other settings)` : "";
    line(`No ${filterText} games between ${sayName(h2h.a)} and ${sayName(h2h.b)}${other}.`);
    return;
  }

  const share = (n, total) => Math.round((n / total) * 100);
  // chess score: win 1, draw 0.5
  const score = (t) => `${fmtScore(t.aWins + t.draws / 2)}–${fmtScore(t.bWins + t.draws / 2)}`;
  // "You win" reads right, "legendary9000 wins" too
  const wins = (name) => `${sayName(name)} ${sayName(name) === "You" ? "win" : "wins"}`;

  line(`${sayName(h2h.a)} vs ${sayName(h2h.b)} · ${filterText}`, "h2h-title");
  line(`${fmtCount(h2h.total)} games · score ${score(h2h)}`);
  line(
    `${wins(h2h.a)} ${fmtCount(h2h.aWins)} (${share(h2h.aWins, h2h.total)}%) · ` +
      `draws ${fmtCount(h2h.draws)} (${share(h2h.draws, h2h.total)}%) · ` +
      `${wins(h2h.b)} ${fmtCount(h2h.bWins)} (${share(h2h.bWins, h2h.total)}%)`
  );

  const t = h2h.last30;
  line(
    t.total
      ? `Last 30 days: ${fmtCount(t.aWins)}W ${fmtCount(t.draws)}D ${fmtCount(t.bWins)}L (${fmtCount(t.total)} games, ${score(t)})`
      : "Last 30 days: no games",
    "h2h-sub"
  );

  const recent = document.createElement("ul");
  recent.className = "h2h-recent";
  for (const g of h2h.games.slice(0, RECENT_GAMES_SHOWN)) {
    const result = g.score === 1 ? "W" : g.score === 0 ? "L" : "D";
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = gameUrl(g);
    a.target = "_blank";
    a.textContent = `${result} · ${g.timeClass} · ${fmtDate(g.t)}`;
    li.appendChild(a);
    recent.appendChild(li);
  }
  container.appendChild(recent);

  // a real rivalry (30+ games): how it went month by month
  if (isRivalry(h2h.games)) renderMonthly(container, h2hMonthly(h2hRows(h2h.games)).slice(0, 12));
}

// a plain table: a header row, then one row per entry
function table(className, header, rows) {
  const el = document.createElement("table");
  el.className = className;
  const row = (cells, tag) => {
    const tr = document.createElement("tr");
    for (const text of cells) {
      const cell = document.createElement(tag);
      cell.textContent = text;
      tr.appendChild(cell);
    }
    el.appendChild(tr);
  };
  row(header, "th");
  for (const cells of rows) row(cells, "td");
  return el;
}

// month, games, average gap at the time, expected %, actual %
function renderMonthly(container, months) {
  container.appendChild(
    table(
      "plain",
      ["Month", "Games", "Avg gap", "Expected", "Actual"],
      months.map((m) => [m.month, fmtCount(m.games), signed(Math.round(m.avgGap)), `${m.expectedPct.toFixed(0)}%`, `${m.actualPct.toFixed(0)}%`])
    )
  );
}

// --- the numbers that only need the cached recent games ---

async function renderDetails() {
  const { asked, names, pair, timeClass } = current;
  const opt = { cacheOnly: true };
  const settings = await loadSettings();
  const now = Date.now();
  const results = await Promise.all(asked.map((u) => fetchStats(u, opt)));
  const missing = await Promise.all(asked.map((u, i) => (results[i] ? false : playerMissing(u))));
  const perfs = await Promise.all(
    asked.map((u, i) => loadPerformance(u, results[i], now, settings, timeClass, pair ? pair[1 - i] : null))
  );

  // a card for everyone asked about, even someone chess.com says doesn't exist
  asked.forEach((u, i) => {
    const container = document.getElementById(`player-${i}`);
    renderPlayer(container, u, results[i], missing[i] ? "missing" : "notSaved");
    if (results[i]) renderPerformance(container, perfs[i], now);
  });
  const asOfs = await Promise.all(names.map((u) => dataAsOf(u)));
  document.getElementById("data-as-of").textContent = asOfs.every((t) => t != null)
    ? `Data as of ${formatAsOf(Math.min(...asOfs), now)}`
    : "";
  if (!pair) return;

  const h2hAll = await fetchHeadToHead(pair[0], pair[1], () => {}, opt);
  const h2h = filterHeadToHead(h2hAll, { timeClass, rated: settings.rated }, now);
  // the matchup rating, for a real rivalry: the gap from results, anchored on field ratings
  const matchup = h2h && isRivalry(h2h.games) ? matchupOf(perfs, h2h, now) : null;
  renderPrediction(document.getElementById("prediction"), matchupPrediction(pair, perfs), h2h, matchup);
  renderMatchup(document.getElementById("matchup"), matchup);
  renderHeadToHead(document.getElementById("h2h"), h2h);
}

// --- full history: race, data states, climb, shadow ---
// the full histories are only downloaded here, and a big one is asked about first

// asked about at this size: chess.com sends ~4 KB a game, so 10 MB is ~2,500 games
const LARGE_DOWNLOAD_BYTES = 10 * 1024 * 1024;
let historyGen = 0;
let echartsLoading = null;

// echarts is ~1 MB, so it's only loaded when there's a race to draw
function loadECharts() {
  echartsLoading ??= new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "../lib/echarts.min.js";
    script.onload = () => resolve(window.echarts);
    script.onerror = () => {
      echartsLoading = null;
      reject(new Error("couldn't load echarts"));
    };
    document.head.appendChild(script);
  });
  return echartsLoading;
}

// headline + tiles for a pair. "You" for the primary user, everywhere
async function raceSummary(pair, journeys, timeClass, counted = RACE_CONFIG.gamesCounted) {
  const labels = raceLabels();
  const say = (name) => labels[name] ?? name;
  const empty = pair.findIndex((_, i) => !journeys[i].games);
  if (empty >= 0) {
    const stats = await fetchStats(pair[empty], { cacheOnly: true });
    const other = mostPlayedTimeClass(stats?.stats);
    const lead = say(pair[empty]) === "You" ? "You have" : `${say(pair[empty])} has`;
    return { headline: `${lead} no ${timeClass} games${other && other !== timeClass ? `. Try ${other}` : ""}`, tiles: [] };
  }
  const [A, B] = pair.map((name, i) => ({ name, journey: journeys[i] }));
  const head = headlineMilestone(A, B, { counted });
  return {
    headline: headlineText(head, A, B, labels),
    tiles: tileMilestones(A, B).map((m) => tileText(raceResult(m, A, B, { counted }), labels, { counted })),
    // the milestone the chart marks first: the headline's, else the top tile's
    milestone: head?.m ?? tileMilestones(A, B).at(-1) ?? null,
  };
}

// a tile or card: the first line is its title
function renderTile(container, lines, className = "race-tile") {
  const tile = document.createElement("div");
  tile.className = className;
  lines.forEach((text, i) => {
    const p = document.createElement("p");
    p.textContent = text;
    if (i === 0) p.className = "race-tile-title";
    tile.appendChild(p);
  });
  container.appendChild(tile);
}

function renderRaceSummary(container, race) {
  container.innerHTML = "";
  if (!race) return;
  const headline = document.createElement("p");
  headline.className = "race-headline";
  headline.textContent = race.headline;
  container.appendChild(headline);
  for (const lines of race.tiles) renderTile(container, lines);
}

const formatMB = (bytes) => `${Math.max(1, Math.round(bytes / (1024 * 1024)))} MB`;

// "load it or not?": a box in the page, resolved by a button
function askToLoadHistory(large, timeClass) {
  return new Promise((resolve) => {
    const box = document.getElementById("history-prompt");
    const labels = current.primary ? { [current.primary]: "your" } : {};
    const whose = (name) => labels[name] ?? `${name}'s`;
    const parts = large.map((e) => `${whose(e.name)} full history is about ${e.missingMonths} months, ~${formatMB(e.bytes)} to download`);
    // it starts a sentence, so "your" becomes "Your"
    const list = parts.join("; ").replace(/^./, (c) => c.toUpperCase());
    const needs = current.pair ? "The race needs" : "The climb breakdown and shadow rating need";
    document.getElementById("history-prompt-text").textContent =
      `${needs} every ${timeClass} game. ${list}. It's saved after the first time. Load it?`;
    box.hidden = false;
    const finish = (answer) => {
      box.hidden = true;
      resolve(answer);
    };
    document.getElementById("history-load").addEventListener("click", () => finish(true), { once: true });
    document.getElementById("history-decline").addEventListener("click", () => finish(false), { once: true });
  });
}

// whatever's saved shows right away, then the rest is loaded (asking first if it's big)
async function loadHistories() {
  const gen = ++historyGen;
  const stale = () => gen !== historyGen;
  const status = document.getElementById("history-status");
  const { names, timeClass } = current;
  document.getElementById("history-prompt").hidden = true;
  // the chart needs it next, so it starts loading now, in the background
  if (current.pair) loadECharts().catch((err) => console.warn("[Performance] echarts:", err));

  const cached = await Promise.all(names.map((u) => fetchJourney(u, timeClass, { cacheOnly: true })));
  if (stale()) return;
  if (!cached.includes(null)) await showHistories(cached, gen);

  status.textContent = "Checking how much history this needs…";
  const estimates = await Promise.all(names.map((u) => estimateHistory(u)));
  if (stale()) return;
  const approved = (await chrome.storage.session.get("raceApproved")).raceApproved || {};
  const large = estimates.filter((e) => e && e.bytes >= LARGE_DOWNLOAD_BYTES && !approved[e.name]);
  console.log("[Performance] history estimates:", estimates);
  if (large.length) {
    status.textContent = "";
    const ok = await askToLoadHistory(large, timeClass);
    if (stale()) return;
    if (!ok) {
      status.textContent = cached.includes(null)
        ? "Full history not loaded. Reload this page whenever you're ready."
        : "Showing what's already saved. Reload this page to load the rest.";
      return;
    }
    // asked once per browser session, not every time
    for (const e of large) approved[e.name] = true;
    await chrome.storage.session.set({ raceApproved: approved });
  }

  const progress = {};
  const onProgress = (name) => (done, total) => {
    progress[name] = [done, total];
    const [d, t] = Object.values(progress).reduce(([a, b], [x, y]) => [a + x, b + y], [0, 0]);
    if (!stale() && t > 1) status.textContent = `Loading full history… ${d}/${t} months`;
  };
  const journeys = await Promise.all(names.map((u) => fetchJourney(u, timeClass, { onProgress: onProgress(u) })));
  if (stale()) return;
  if (journeys.includes(null)) {
    status.textContent = "Couldn't load the full history. Try again in a minute.";
    return;
  }
  await showHistories(journeys, gen);
  const missingMonths = journeys.flatMap((j) => j.missingMonths || []);
  status.textContent = missingMonths.length
    ? `chess.com couldn't send ${missingMonths.length} month${missingMonths.length === 1 ? "" : "s"}, so some games may be missing.`
    : "";
}

// everything that needs the full history. each player's games in this time class, with
// pre-game numbers, are read from storage once and shared by the cards, states, climb, shadow
async function showHistories(journeys, gen) {
  const { names, timeClass } = current;
  const players = await Promise.all(
    names.map(async (name, i) => ({ name, journey: journeys[i], records: await recentRecords(name, timeClass, 0) }))
  );
  if (gen !== historyGen) return;
  const now = Date.now();

  if (current.pair) {
    const summary = await raceSummary(current.pair, journeys, timeClass);
    if (gen !== historyGen) return;
    current.race = { timeClass, journeys, milestone: summary.milestone };
    renderRaceSummary(document.getElementById("race-summary"), summary);
    await showRace(players, gen);
  }
  renderStates(players, now);
  renderClimbs(players);
  renderShadow(players, now);
}

// --- race chart ---
// the app's colors: you are blue and solid, the other player amber and dashed, so the chart
// still reads in grayscale and for colorblind readers. spectating: the first player is blue
const RACE_COLORS = { primary: "#2563eb", other: "#d97706" };
const PLACEMENT_GAMES = RACE_CONFIG.placementGames;
// the chart's settings, set by the race controls. kept for this page, not saved
const raceOptions = { x: "days", view: "rating", smoothed: true, counted: RACE_CONFIG.gamesCounted, milestone: null, key: null };
let raceChart = null;

const raceLabels = () => (current.primary ? { [current.primary]: "You" } : {});
const racePlayers = () => current.pair.map((name, i) => ({ name, journey: current.race.journeys[i] }));

// a race is on screen: controls, the chosen milestone's race, chart, cards, footer
async function showRace(players, gen) {
  const [A, B] = racePlayers();
  // a new race starts on its own headline milestone. the other settings carry over
  const key = `${current.pair.join(":")}:${current.race.timeClass}`;
  if (raceOptions.key !== key) {
    raceOptions.key = key;
    raceOptions.milestone = current.race.milestone;
  }
  const select = document.getElementById("race-milestone");
  select.innerHTML = "";
  for (const m of milestoneOptions(A, B)) {
    const option = document.createElement("option");
    option.value = String(m);
    option.textContent = `Race to ${m}`;
    select.appendChild(option);
  }
  if (raceOptions.milestone != null) select.value = String(raceOptions.milestone);
  document.getElementById("race-x").value = raceOptions.x;
  document.getElementById("race-view").value = raceOptions.view;
  document.getElementById("race-smoothed").checked = raceOptions.smoothed;
  document.getElementById("race-counted").value = raceOptions.counted;
  document.getElementById("race-controls").hidden = false;

  renderSelectedRace();
  drawRaceChart();
  renderRaceCards(players);
  await renderRaceFooter(gen);
}

// the race for the milestone in the dropdown, as a tile. there's no milestone in the gain view
function renderSelectedRace() {
  const container = document.getElementById("race-selected");
  container.innerHTML = "";
  document.getElementById("race-milestone").disabled = raceOptions.view === "gain";
  if (raceOptions.view === "gain" || raceOptions.milestone == null) return;
  const [A, B] = racePlayers();
  const lines = tileText(raceResult(raceOptions.milestone, A, B, { counted: raceOptions.counted }), raceLabels(), { counted: raceOptions.counted });
  renderTile(container, lines, "race-tile selected");
}

// one volatility card per player
function renderRaceCards(players) {
  const container = document.getElementById("race-cards");
  const now = Date.now();
  container.innerHTML = "";
  for (const { name, journey, records } of players) {
    if (!records) {
      renderTile(container, [`${sayName(name)} · Not enough sessions`, "Couldn't read their games"], "race-card");
      continue;
    }
    const rust = rustCheck(records, journey, now);
    const lines = volatilityText(sayName(name), volatilityOf(records, now), rust);
    // placing, inactive, returning, sparse: said right under the name. the rust line already
    // says "back from a 117-day break", so "returning" isn't said twice
    const states = statesText(dataStates(records, journey, now).filter((st) => !(rust && st === "returning")), journey, now);
    if (states) lines.splice(1, 0, states);
    renderTile(container, lines, "race-card");
  }
}

// "Bullet · rated games · as of Oct 2, 2026": the older of the two players' confirmed times
async function renderRaceFooter(gen) {
  const times = await Promise.all(current.pair.map((u) => dataAsOf(u)));
  if (gen !== historyGen) return;
  const asOf = times.every((t) => t != null) ? Math.min(...times) : Date.now();
  document.getElementById("race-footer-text").textContent = footerText(current.race.timeClass, asOf / 1000);
  document.getElementById("race-footer").hidden = false;
}

// controls: redraw from what's already loaded, no requests
function onRaceControl() {
  raceOptions.x = document.getElementById("race-x").value;
  raceOptions.view = document.getElementById("race-view").value;
  raceOptions.smoothed = document.getElementById("race-smoothed").checked;
  raceOptions.milestone = Number(document.getElementById("race-milestone").value) || raceOptions.milestone;
  raceOptions.counted = document.getElementById("race-counted").value;
  if (!current?.race) return;
  renderSelectedRace();
  drawRaceChart();
  // the tiles' game counts follow the games toggle too
  raceSummary(current.pair, current.race.journeys, current.race.timeClass, raceOptions.counted).then((race) =>
    renderRaceSummary(document.getElementById("race-summary"), race)
  );
}

async function drawRaceChart() {
  if (!current?.race || !current.pair) return;
  let echarts;
  try {
    echarts = await loadECharts();
  } catch {
    document.getElementById("history-status").textContent = "Couldn't load the chart.";
    return;
  }
  const el = document.getElementById("race-chart");
  if (!raceChart) {
    raceChart = echarts.init(el);
    // the chart follows its box's width
    new ResizeObserver(() => raceChart.resize()).observe(el);
    raceChart.on("datazoom", () => endLabels());
  }
  const option = raceChartOption();
  // lastX and player ride along on the series for endLabels(), echarts ignores them
  raceSeriesInfo = option.series.filter((sr) => sr.player).map((sr) => ({ name: sr.name, lastX: sr.lastX, player: sr.player, line: sr.line }));
  raceChart.setOption(option, true);
  endLabels();
  document.getElementById("race-full").hidden = option.dataZoom == null;
}

let raceSeriesInfo = [];

// what a line's end says: their current rating, or in the gain view what they've gained
function endText(player, line) {
  if (raceOptions.view !== "gain") return `${player.name} ${player.journey.now?.rating ?? ""}`;
  const gained = Math.round(line.at(-1)?.y ?? 0);
  return `${player.name} ${gained >= 0 ? "+" : ""}${gained}`;
}

// end labels follow the zoom: the current rating when the line's real end is on screen,
// just the name and an arrow when it carries on past the edge (the line at the edge isn't
// at their current rating, so printing it there would mislead)
function endLabels() {
  const [, visibleEnd] = raceChart.getModel().getComponent("xAxis", 0).axis.scale.getExtent();
  raceChart.setOption({
    series: raceSeriesInfo.map((info) => ({
      name: info.name,
      endLabel: {
        formatter: info.lastX <= visibleEnd ? endText(info.player, info.line) : `${info.player.name} →`,
      },
    })),
  });
}

function raceChartOption() {
  const { pair, primary } = current;
  const { timeClass, journeys } = current.race;
  const { x, view, smoothed, counted, milestone } = raceOptions;
  const tc = timeClass[0].toUpperCase() + timeClass.slice(1);
  const youIndex = pair.indexOf(primary);
  const players = pair.map((name, i) => {
    const isPrimary = youIndex >= 0 ? i === youIndex : i === 0;
    return { name, journey: journeys[i], color: isPrimary ? RACE_COLORS.primary : RACE_COLORS.other, dashed: !isPrimary };
  });
  const lines = players.map((pl) => chartSeries(pl.journey, { x, counted, view, smoothed }));
  // the x of a daily point, the same way chartSeries works it out (gain view starts at game 60)
  const xOf = (i, p) => {
    const line = lines[i];
    if (!line.length) return null;
    const first = line[0];
    const offset = (x === "games" ? gamesBy(first.p, counted) : first.p.day) - first.x;
    return (x === "games" ? gamesBy(p, counted) : p.day) - offset;
  };
  const point = (pt) => ({ value: [pt.x, pt.y], p: pt.p });
  const series = [];

  players.forEach((pl, i) => {
    const line = lines[i];
    if (!line.length) return;
    // placement games: the first 60 rated games, dashed and lighter. the gain view starts after them
    const cut = line.findIndex((pt) => pt.p.ratedGames >= PLACEMENT_GAMES);
    const placement = view === "gain" ? [] : line.slice(0, cut === -1 ? line.length : cut + 1);
    const settled = view === "gain" ? line : cut === -1 ? [] : line.slice(cut);
    if (placement.length) {
      series.push({
        name: `${pl.name} placement`,
        type: "line",
        data: placement.map(point),
        showSymbol: false,
        lineStyle: { color: pl.color, width: 1.5, type: "dashed", opacity: 0.35 },
        itemStyle: { color: pl.color },
        // said once, on the first player's
        endLabel: i === 0 ? { show: true, formatter: "Placement games", color: "#999", fontSize: 10 } : undefined,
      });
    }

    const markPoints = [];
    const markLines = [];
    const markAreas = [];
    // the crossing, for the highlighted milestone only: "2000 · day 410"
    const reached = view === "rating" ? pl.journey.milestones[milestone]?.reached : null;
    if (reached) {
      const at = xOf(i, reached);
      markPoints.push({
        coord: [at, milestone],
        symbol: "circle",
        symbolSize: 7,
        label: { show: true, position: i === 0 ? "top" : "bottom", fontSize: 10, color: pl.color,
          formatter: `${milestone} · ${x === "games" ? `game ${at.toLocaleString("en-US")}` : `day ${at.toLocaleString("en-US")}`}` },
      });
    }
    // breaks of 30+ days: shaded in the player's color (on a games axis a break has no width,
    // so a line). words only on their 3 longest 90+ day ones, or a player with 14 breaks
    // buries the chart
    const labeled = new Set(
      [...pl.journey.breaks].filter((b) => b.days >= RACE_CONFIG.raceBreakDays).sort((p, q) => q.days - p.days).slice(0, 3)
    );
    for (const b of pl.journey.breaks) {
      const before = [...pl.journey.daily].reverse().find((p) => p.day <= b.fromDay);
      if (!before) continue;
      const from = xOf(i, before);
      const label = {
        show: labeled.has(b),
        formatter: `${b.days}-day break`,
        fontSize: 9,
        color: pl.color,
        position: i === 0 ? "insideTop" : "insideBottom",
      };
      if (x === "games") markLines.push({ xAxis: from, label, lineStyle: { color: "#bbb", type: "dotted" } });
      // from the last game before the break to the first one after it
      else markAreas.push([{ xAxis: from, label }, { xAxis: from + (b.toDay - before.day) }]);
    }

    series.push({
      name: pl.name,
      type: "line",
      data: (settled.length ? settled : placement.slice(-1)).map(point),
      showSymbol: false,
      sampling: "lttb",
      lineStyle: { color: pl.color, width: 2, type: pl.dashed ? "dashed" : "solid" },
      itemStyle: { color: pl.color },
      // the end says whose line it is, no legend to look away to. see endLabels() for the
      // zoomed-in case
      endLabel: { show: true, color: pl.color, fontWeight: "bold", formatter: endText(pl, line) },
      lastX: (settled.length ? settled : placement.slice(-1)).at(-1)?.x,
      player: pl,
      line,
      // two labels landing on the same spot: hide the later one instead of overprinting
      labelLayout: { hideOverlap: true },
      markPoint: markPoints.length ? { data: markPoints, symbolKeepAspect: true } : undefined,
      markLine: markLines.length ? { symbol: "none", silent: true, data: markLines } : undefined,
      markArea: markAreas.length ? { silent: true, itemStyle: { color: pl.color, opacity: 0.06 }, data: markAreas } : undefined,
    });

    // the projection: a dotted continuation, labeled as an estimate (days and rating only)
    const proj = view === "rating" && x === "days" && smoothed ? projectionOf(pl.journey) : null;
    if (proj?.daysToNext) {
      const start = pl.journey.currentDay;
      const end = start + Math.min(proj.daysToNext, 365);
      const pts = [];
      for (let d = start; d <= end; d += Math.max(1, Math.round((end - start) / 30))) pts.push([d, projectAt(proj, d)]);
      series.push({
        name: `${pl.name} estimate`,
        type: "line",
        data: pts,
        showSymbol: false,
        silent: true,
        lineStyle: { color: pl.color, width: 1.5, type: "dotted", opacity: 0.6 },
        endLabel: { show: true, formatter: "Estimate", color: "#999", fontSize: 10 },
        tooltip: { show: false },
      });
    }
  });

  // lead changes: "<username> takes the lead". only once both are past placement, where
  // ratings jump around too much for the lead to mean anything
  const settledOnly = lines.map((line) => line.filter((pt) => view === "gain" || pt.p.ratedGames >= PLACEMENT_GAMES));
  if (settledOnly[0].length && settledOnly[1].length) {
    for (const change of leadChanges(settledOnly[0], settledOnly[1])) {
      const pl = players[change.leader === "a" ? 0 : 1];
      const target = series.find((sr) => sr.name === pl.name);
      target.markPoint ??= { data: [] };
      target.markPoint.data.push({
        coord: [change.x, change.y],
        symbol: "pin",
        symbolSize: 18,
        itemStyle: { color: pl.color },
        label: { show: true, position: "top", fontSize: 9, color: pl.color, formatter: `${pl.name} takes the lead`, offset: [0, -8] },
      });
    }
  }

  // the highlighted milestone as a faint level, so the crossings have something to cross
  if (view === "rating" && milestone) {
    const first = series.find((sr) => sr.name === players[0].name);
    first.markLine ??= { symbol: "none", silent: true, data: [] };
    first.markLine.data.push({ yAxis: milestone, lineStyle: { color: "#ccc", type: "dashed" }, label: { show: false } });
  }

  // the gain view starts at rated game 60 for both, so there's no long career to zoom past
  const zoomEnd = view === "gain" ? null : defaultZoomEnd(...players.map((pl) => ({ name: pl.name, journey: pl.journey })), { x, counted });
  const gamesName = { rated: "Rated games played", unrated: "Unrated games played", both: "Games played" }[counted];
  return {
    animation: false,
    grid: { left: 56, right: 150, top: 24, bottom: 64 },
    xAxis: {
      type: "value",
      name: view === "gain"
        ? (x === "games" ? `${gamesName} since rated game 60` : "Days since rated game 60")
        : (x === "games" ? gamesName : `Days since first ${timeClass} game`),
      nameLocation: "middle",
      nameGap: 28,
      splitLine: { show: false },
      axisLabel: { formatter: (v) => v.toLocaleString("en-US") },
    },
    yAxis: {
      type: "value",
      name: view === "gain" ? "Rating gained since start" : `${tc} rating`,
      scale: true,
      // room above the top line for its labels
      max: (v) => Math.ceil((v.max + 60) / 100) * 100,
      // faint horizontal gridlines only
      splitLine: { lineStyle: { color: "#f0f0f0" } },
    },
    tooltip: {
      trigger: "axis",
      // stays inside the chart instead of running off the edge
      confine: true,
      // "Day 214 · Sep 12, 2025 · 1,742 · game 1,318", one line per player
      formatter: (params) =>
        params
          .filter((pr) => pr.data?.p && !pr.seriesName.endsWith(" estimate"))
          .map((pr) => {
            const p = pr.data.p;
            const y = Math.round(pr.data.value[1]);
            const shown = view === "gain" ? `${y >= 0 ? "+" : ""}${y}` : y.toLocaleString("en-US");
            return `<b>${pr.seriesName.replace(/ placement$/, "")}</b>: Day ${p.day.toLocaleString("en-US")} · ${fmtDate(p.t)} · ${shown} · game ${gamesBy(p, counted).toLocaleString("en-US")}`;
          })
          .join("<br>"),
    },
    dataZoom: zoomEnd == null ? undefined : [
      { type: "inside", filterMode: "none", startValue: 0, endValue: zoomEnd },
      { type: "slider", filterMode: "none", startValue: 0, endValue: zoomEnd, height: 16, bottom: 6 },
    ],
    series,
  };
}

// --- data states, climb, shadow: plain tables ---

const STATES = ["placing", "inactive", "returning", "sparse"];

// one row per player: each state in words, or "—"
function renderStates(players, now) {
  const container = document.getElementById("states");
  container.innerHTML = "";
  const rows = players.map(({ name, journey, records }) => {
    if (!records) return [sayName(name), "Couldn't read their games", "", "", ""];
    const states = dataStates(records, journey, now);
    if (states.includes("none")) return [sayName(name), `No ${current.timeClass} games`, "", "", ""];
    return [sayName(name), ...STATES.map((st) => (states.includes(st) ? statesText([st], journey, now) : "—"))];
  });
  container.appendChild(table("plain", ["Player", "Placing", "Inactive", "Returning", "Sparse"], rows));
}

function renderClimbs(players) {
  const container = document.getElementById("climb");
  container.innerHTML = "";
  for (const { name, journey, records } of players) {
    if (records) renderClimb(container, sayName(name), climbBreakdown(records, journey));
  }
}

// one player's climb, 100 points at a time
function renderClimb(container, who, { steps, summary }) {
  const title = document.createElement("h3");
  title.textContent = `${who === "You" ? "Your" : `${who}'s`} climb, 100 points at a time`;
  container.appendChild(title);
  const note = (text) => {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = text;
    container.appendChild(p);
  };
  if (!steps.length) {
    note("No full 100-point steps above where they settled yet.");
    return;
  }

  // counts get commas, ratings don't ("3,937 games", "1817 → 1861")
  const n = (x) => (x == null ? "—" : fmtCount(x));
  const rating = (x) => (x == null ? "—" : String(Math.round(x)));
  const sn = (x) => (x == null ? "—" : signed(Math.round(x)));
  const pm = (p) => (p?.perf == null ? "—" : `${Math.round(p.perf)} ± ${Math.round(p.error)}`);
  container.appendChild(
    table(
      "plain",
      ["Step", "Days", "Active", "Rated", "Unrated", "Rated perf", "Unrated level", "Change", "Per 1,000", "Lag", "Agree"],
      steps.map((st) => [
        `${st.from}–${st.to}`,
        n(st.days),
        n(st.activeDays),
        n(st.ratedGames),
        n(st.unratedGames),
        pm(st.ratedPerf),
        st.unratedPerfStart ? `${rating(st.unratedPerfStart.perf)} → ${rating(st.unratedPerfEnd.perf)}` : "—",
        sn(st.unratedChange),
        sn(st.per1000),
        sn(st.ratingLag),
        st.agree == null ? "—" : st.agree ? "yes" : "no",
      ])
    )
  );

  // the latest step with unrated numbers, in words: what happened, not what caused it
  const latest = [...steps].reverse().find((st) => st.unratedChange != null);
  if (latest) {
    // "Improved by +56", "Dropped by 124" (a minus and "dropped" would say it twice)
    const moved = latest.unratedChange >= 0 ? `Improved by ${sn(latest.unratedChange)}` : `Dropped by ${n(-latest.unratedChange)}`;
    note(`${latest.from} → ${latest.to}: ${moved} during ${n(latest.unratedCount)} unrated games`);
  }
  if (summary?.compared) {
    note(
      `Rated and unrated agreed in ${summary.agreed} of ${summary.compared} steps · ` +
        `on average rated was ${Math.abs(Math.round(summary.avgDiff))} ${summary.avgDiff >= 0 ? "above" : "below"} unrated`
    );
  }
  note("Lag = unrated level at the start of a step minus the official rating then.");
}

// yours only: the card, then how it moved over each window next to the official rating
function renderShadow(players, now) {
  const container = document.getElementById("shadow");
  container.innerHTML = "";
  const me = players.find((pl) => pl.name === current.primary);
  if (!me) {
    const p = document.createElement("p");
    p.className = "note";
    p.textContent = "The shadow rating is only worked out for you.";
    container.appendChild(p);
    return;
  }
  if (!me.records) return;
  renderTile(container, shadowText(shadowSummary(me.records)), "race-card shadow");

  const r = (x) => String(Math.round(x));
  const move = (m) => `${r(m.start)} → ${r(m.now)} (${signed(Math.round(m.change))})`;
  const rows = shadowWindows(me.records, now).map(({ label, result: w }) => {
    if (w.empty) return [label, "No games in this period", "", "", "", ""];
    if (w.noRated) return [label, "No rated games to start from", "", "", "", ""];
    return [
      label,
      `${fmtDate(w.anchor.t)} · ${w.anchor.rating}`,
      move(w.shadow),
      move(w.official),
      `${fmtCount(w.replayed.rated)} rated · ${fmtCount(w.replayed.unrated)} unrated`,
      w.flags.length ? w.flags.join(". ") : "—",
    ];
  });
  container.appendChild(table("plain", ["Window", "Starts from", "Shadow", "Official", "Games replayed", "Notes"], rows));
  const p = document.createElement("p");
  p.className = "note";
  p.textContent =
    "Each window starts from your last rated game before it, replays every game since, and compares where the shadow was when the window opened with where it is now.";
  container.appendChild(p);
}

// one paragraph per METHODOLOGY entry in performance.js and race.js
function renderMethodology() {
  const container = document.getElementById("methodology");
  container.innerHTML = "";
  for (const text of [...Object.values(METHODOLOGY), ...Object.values(RACE_METHODOLOGY)]) {
    const p = document.createElement("p");
    p.textContent = text;
    container.appendChild(p);
  }
}

// --- fair play ---

let locked = false;

// a game in progress in any chess.com tab: everything about the players goes, not just
// hidden, and only the lock check keeps running. when it ends, the page starts over
async function checkLock() {
  let lockedNow;
  try {
    lockedNow = await anyTabLocked(current?.primary ?? null);
  } catch (err) {
    // unsure = locked
    console.warn("[Performance] lock check failed:", err);
    lockedNow = true;
  }
  if (lockedNow && !locked) {
    locked = true;
    historyGen++;
    raceChart?.dispose();
    raceChart = null;
    document.getElementById("content")?.remove();
    document.getElementById("controls")?.remove();
    document.getElementById("status").textContent = LOCKED_TEXT;
  } else if (!lockedNow && locked) {
    location.reload();
  }
  return lockedNow;
}

// --- start ---

async function start() {
  const params = new URLSearchParams(location.search);
  const a = params.get("a")?.toLowerCase();
  const b = params.get("b")?.toLowerCase() || null;
  const status = document.getElementById("status");
  if (!a) {
    status.textContent = "Nothing to compare. Open this from the extension's popup.";
    return;
  }
  const primary = (await chrome.storage.local.get("primaryUsername")).primaryUsername ?? null;
  const asked = b ? [a, b] : [a];
  // someone chess.com says doesn't exist only gets their card: no matchup, race, or history
  const missing = await Promise.all(asked.map((u) => playerMissing(u)));
  const names = asked.filter((_, i) => !missing[i]);
  current = { primary, asked, names, pair: names.length === 2 ? names : null, timeClass: params.get("tc") };

  // nothing about anyone shows before the first lock check
  status.textContent = "Checking for games in progress…";
  if (await checkLock()) return;

  // no time class in the url: what they've played most lately
  if (!current.timeClass) {
    const stats = await Promise.all(current.names.map((u) => fetchStats(u, { cacheOnly: true })));
    current.timeClass = pickTimeClass(stats[0]?.stats) ?? pickTimeClass(stats[1]?.stats);
  }
  if (!current.timeClass) {
    status.textContent = "No games saved for these players yet. Open the extension on their page first.";
    return;
  }

  const who = b ? `${sayName(a)} vs ${sayName(b)}` : sayName(a);
  status.textContent = `${who} · ${current.timeClass}`;
  document.title = `${who} · Performance`;
  // with no b (or a b who doesn't exist), only the sections about a
  for (const id of ["prediction-section", "h2h-section", "race-section"]) document.getElementById(id).hidden = !current.pair;
  document.getElementById("player-1").hidden = !b;

  const settings = await loadSettings();
  document.getElementById("ctl-range").value = settings.range;
  document.getElementById("ctl-rated").value = settings.rated;
  document.getElementById("content").hidden = false;
  document.getElementById("controls").hidden = false;

  renderMethodology();
  await renderDetails();
  if (names.length) loadHistories();
  else for (const id of ["states", "climb", "shadow"]) document.getElementById(id).innerHTML = "";
}

// range and rated: saved, shared with the popup, and only change the numbers from recent games
for (const [id, field] of [["ctl-range", "range"], ["ctl-rated", "rated"]]) {
  document.getElementById(id).addEventListener("change", async (e) => {
    const settings = await loadSettings();
    await chrome.storage.local.set({ [SETTINGS_KEY]: { ...settings, [field]: e.target.value } });
    if (!locked) renderDetails();
  });
}
for (const id of ["race-x", "race-view", "race-smoothed", "race-milestone", "race-counted"]) {
  document.getElementById(id).addEventListener("change", onRaceControl);
}
document.getElementById("race-full").addEventListener("click", () => {
  raceChart?.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
});
document.getElementById("race-methodology").addEventListener("click", () => {
  document.getElementById("methodology-section").scrollIntoView({ behavior: "smooth" });
});

// a game can start in another tab while this one is open: check on every chess.com page
// change, and every minute
setInterval(() => current && checkLock(), LOCK_CHECK_MS);
chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  // a new url, or a page that just finished loading (its usernames can be read now)
  if (current && (info.url || info.status === "complete") && tab.url?.includes("chess.com")) checkLock();
});
chrome.tabs.onRemoved.addListener(() => current && locked && checkLock());

document.addEventListener("DOMContentLoaded", () => start());
