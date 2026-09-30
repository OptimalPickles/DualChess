// flow: scrape tab -> get/ask primary -> figure out mode -> stats + head-to-head -> render
// logs start with "[Performance]". popup logs: right-click icon > Inspect popup.
// scrapeChessPage logs show in the chess.com tab's own console

// Key used in chrome.storage.local to remember "you" between popup opens
const STORAGE_KEY_PRIMARY_USERNAME = "primaryUsername";
const RECENT_GAMES_SHOWN = 5;

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

  const result = { playersOnPage: Array.from(candidates.values()) };
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

  container.textContent = `${label}: ${username} — rapid: ${rapid}, blitz: ${blitz}, bullet: ${bullet}`;
}

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
    line("Couldn't load head-to-head games.");
    return;
  }
  if (!h2h.total) {
    line(`No games found between ${h2h.a} and ${h2h.b}.`);
    return;
  }

  const pct = (n, total) => Math.round((n / total) * 100);
  // chess score: win 1, draw 0.5
  const score = (t) => `${t.aWins + t.draws / 2}–${t.bWins + t.draws / 2}`;

  line(`${h2h.a} vs ${h2h.b}`, "h2h-title");
  line(`${h2h.total} games · score ${score(h2h)}`);
  line(
    `${h2h.a} wins ${h2h.aWins} (${pct(h2h.aWins, h2h.total)}%) · ` +
      `draws ${h2h.draws} (${pct(h2h.draws, h2h.total)}%) · ` +
      `${h2h.b} wins ${h2h.bWins} (${pct(h2h.bWins, h2h.total)}%)`
  );

  for (const [timeClass, t] of Object.entries(h2h.byTimeClass)) {
    line(`${timeClass}: ${t.aWins}W ${t.draws}D ${t.bWins}L (${t.total} games, ${score(t)})`, "h2h-sub");
  }

  const recent = document.createElement("ul");
  recent.className = "h2h-recent";
  for (const g of h2h.games.slice(0, RECENT_GAMES_SHOWN)) {
    const result = g.winner === h2h.a ? "W" : g.winner === h2h.b ? "L" : "D";
    const date = new Date(g.endTime * 1000).toLocaleDateString();
    const li = document.createElement("li");
    const a = document.createElement("a");
    a.href = g.url;
    a.target = "_blank";
    a.textContent = `${result} · ${g.timeClass} · ${date}`;
    li.appendChild(a);
    recent.appendChild(li);
  }
  container.appendChild(recent);
}

async function init() {
  const statusEl = document.getElementById("status");
  const primaryEl = document.getElementById("primary-info");
  const opponentEl = document.getElementById("opponent-info");
  const h2hEl = document.getElementById("h2h");
  const changeAccountBtn = document.getElementById("change-account");

  changeAccountBtn.hidden = true;
  h2hEl.innerHTML = "";

  document.body.classList.add("is-loading");

  try {
    const tabData = await getActiveChessTabData();
    console.log("[Performance] Active tab + scrape result:", tabData);

    if (!tabData) {
      statusEl.textContent =
        "Open a chess.com game or profile page, then click the extension again.";
      return;
    }

    const primaryUsername = await getPrimaryUsername(tabData.scraped.playersOnPage);

    if (!primaryUsername) {
      statusEl.textContent = "No username set - try again.";
      return;
    }

    const { mode, others } = resolveMode(primaryUsername, tabData.scraped.playersOnPage);

    // entries = who gets stats, pair = who gets head-to-head
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

    changeAccountBtn.hidden = false;

    const baseStatus = statusEl.textContent;
    const onProgress = (done, total) => {
      statusEl.textContent = `${baseStatus} Scanning games ${done}/${total} months…`;
    };

    // stats and head-to-head at the same time
    const [results, h2h] = await Promise.all([
      Promise.all(entries.map((entry) => fetchData(entry.username))),
      pair ? fetchHeadToHead(pair[0], pair[1], onProgress) : Promise.resolve(null),
    ]);
    statusEl.textContent = baseStatus;

    console.log(
      "[Performance] Final entries + fetched API data:",
      entries.map((entry, i) => ({ ...entry, data: results[i] }))
    );

    renderPlayer(primaryEl, entries[0]?.label, entries[0]?.username, results[0]);
    renderPlayer(opponentEl, entries[1]?.label, entries[1]?.username, results[1]);
    if (pair) renderHeadToHead(h2hEl, h2h);
  } catch (err) {
    console.error("[Performance] init() failed:", err);
    statusEl.textContent = "Something went wrong - check the popup's console (right-click the extension icon > Inspect popup).";
  } finally {
    document.body.classList.remove("is-loading");
  }
}

// clears the saved username and asks again
document
  .getElementById("change-account")
  .addEventListener("click", async () => {
    await chrome.storage.local.remove(STORAGE_KEY_PRIMARY_USERNAME);
    console.log("[Performance] Cleared saved primary username - re-asking.");
    init();
  });

document.addEventListener("DOMContentLoaded", init);

// suggestions:
// - filter head-to-head by rated only or by rules (chess960 etc). both are already saved per game
// - first scan for a long-time friend can be dozens of months. cached after, but a "scanning" spinner would help
// - "spectating" only compares the first two names found. a third name on the page gets ignored
// - typed usernames aren't checked against chess.com before saving. a typo only shows up later as "couldn't load stats"
