// reading chess.com tabs: the usernames on a page, and the fair play check for it.
// used by the popup (the tab it was opened on) and the comparison tab (every chess.com tab)

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

  // fallback: chess.com's user tagline component in the rendered page. not on a profile:
  // it lists friends and recent opponents too, which would look like two other players
  if (!canonicalMatch) {
    document.querySelectorAll("[data-username]").forEach((el) => {
      addCandidate(el.getAttribute("data-username"));
    });
    document
      .querySelectorAll('[data-test-element="user-tagline-username"]')
      .forEach((el) => {
        addCandidate(el.textContent);
      });
  }

  const result = { playersOnPage: Array.from(candidates.values()), canonicalHref };
  console.log("[Performance] scrapeChessPage() found:", result);
  return result;
}

// the usernames on a tab, or null if the page can't be read (still loading, discarded)
async function scrapeTab(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, func: scrapeChessPage });
    return result ?? null;
  } catch (err) {
    console.warn(`[Performance] couldn't read tab ${tabId}:`, err);
    return null;
  }
}

// game ids whose stored months were already searched once, see findGameInArchive
const scannedGames = new Set();

// fair play for one tab, from its url and usernames alone. a play url with no id can still
// carry one in its canonical link. no usernames (an unreadable page) means a game page
// can't be checked, so it stays locked
async function tabLock(url, scraped, primary) {
  let page = parsePage(url);
  const fromCanonical = parsePage(scraped?.canonicalHref ?? "");
  if (page.kind === "play" && fromCanonical.kind === "game") page = fromCanonical;
  const onPage = (scraped?.playersOnPage ?? []).map((p) => p.username);
  // the full search of stored months only has to happen once per game
  const scanCached = page.kind === "game" && !scannedGames.has(page.id);
  if (scanCached) scannedGames.add(page.id);
  return checkGameLock(page, onPage, primary, { scanCached });
}

// true if any open chess.com tab has a game in progress (or might: unsure = locked).
// only play and game pages are read, the rest can't hold a game
async function anyTabLocked(primary) {
  const tabs = await chrome.tabs.query({ url: "https://www.chess.com/*" });
  for (const tab of tabs) {
    if (!tab.url || parsePage(tab.url).kind === "other") continue;
    const scraped = await scrapeTab(tab.id);
    if ((await tabLock(tab.url, scraped, primary)).locked) return true;
  }
  return false;
}
