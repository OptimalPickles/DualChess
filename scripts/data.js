const STATS_CACHE_TTL_MS = 5 * 60 * 1000;
// chess.com rate limits parallel requests (429), so keep this small
const ARCHIVE_CONCURRENCY = 3;
const API = "https://api.chess.com/pub/player";

// json or null. retries once on 429
async function fetchJson(url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url);
      if (res.status === 429 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 1000));
        continue;
      }
      // fetch doesn't throw on 404 etc, have to check
      if (!res.ok) {
        console.warn(`[Performance] ${res.status} from ${url}`);
        return null;
      }
      return await res.json();
    } catch (err) {
      console.error(`[Performance] fetch failed: ${url}`, err);
      return null;
    }
  }
  return null;
}

// profile + ratings for one player
async function fetchData(username) {
  if (!username) return null;
  const name = encodeURIComponent(username.toLowerCase());

  // session storage clears on browser restart
  const cacheKey = `statsCache:${name}`;
  const cached = (await chrome.storage.session.get(cacheKey))[cacheKey];
  if (cached && Date.now() - cached.fetchedAt < STATS_CACHE_TTL_MS) {
    console.log(`[Performance] fetchData("${username}") cached:`, cached.data);
    return cached.data;
  }

  const [profile, stats] = await Promise.all([
    fetchJson(`${API}/${name}`),
    fetchJson(`${API}/${name}/stats`),
  ]);
  if (!profile || !stats) return null;

  const data = { profile, stats };
  console.log(`[Performance] fetchData("${username}") fresh:`, data);
  await chrome.storage.session.set({ [cacheKey]: { data, fetchedAt: Date.now() } });
  return data;
}

// winner "win", everything else on both sides is a draw
function summarizeGame(g) {
  const winner =
    g.white.result === "win" ? g.white.username
    : g.black.result === "win" ? g.black.username
    : null;
  return {
    url: g.url,
    endTime: g.end_time,
    timeClass: g.time_class,
    rated: g.rated,
    rules: g.rules,
    white: g.white.username.toLowerCase(),
    black: g.black.username.toLowerCase(),
    winner: winner ? winner.toLowerCase() : null, // null = draw
  };
}

// wins/draws from a's side, overall and per time class
function tallyHeadToHead(a, b, games) {
  const empty = () => ({ aWins: 0, bWins: 0, draws: 0, total: 0 });
  const totals = empty();
  const byTimeClass = {};

  for (const g of games) {
    const tc = (byTimeClass[g.timeClass] ||= empty());
    for (const t of [totals, tc]) {
      t.total++;
      if (g.winner === a) t.aWins++;
      else if (g.winner === b) t.bWins++;
      else t.draws++;
    }
  }
  return { a, b, ...totals, byTimeClass, games };
}

// every game between a and b, from the monthly archives
async function fetchHeadToHead(a, b, onProgress = () => {}) {
  a = a?.toLowerCase();
  b = b?.toLowerCase();
  if (!a || !b || a === b) return null;

  const [archA, archB] = await Promise.all([
    fetchJson(`${API}/${encodeURIComponent(a)}/games/archives`),
    fetchJson(`${API}/${encodeURIComponent(b)}/games/archives`),
  ]);
  if (!archA || !archB) return null;

  // archive urls end in "YYYY/MM". only months both played can have games between them
  const monthOf = (url) => url.slice(-7);
  const monthsB = new Set(archB.archives.map(monthOf));
  const shared = archA.archives.map(monthOf).filter((m) => monthsB.has(m));

  // finished months never change so they're cached for good.
  // a month fetched while it was still going gets refetched
  const pairKey = [a, b].sort().join(":");
  const cacheKey = `h2h:${pairKey}`;
  const cache = (await chrome.storage.local.get(cacheKey))[cacheKey] || { months: {} };
  const currentMonth = new Date().toISOString().slice(0, 7).replace("-", "/");
  const toFetch = shared.filter((m) => !cache.months[m]?.complete);

  console.log(
    `[Performance] h2h ${a} vs ${b}: ${shared.length} shared months, ${toFetch.length} to fetch`
  );

  let done = 0;
  const queue = [...toFetch];
  const worker = async () => {
    while (queue.length) {
      const month = queue.shift();
      // same games are in both archives. chess.com sometimes errors on one
      // (seen on huge months), so fall back to the other player's
      const data =
        (await fetchJson(`${API}/${encodeURIComponent(a)}/games/${month}`)) ||
        (await fetchJson(`${API}/${encodeURIComponent(b)}/games/${month}`));
      if (data) {
        const games = data.games
          .filter(
            (g) =>
              [g.white.username.toLowerCase(), g.black.username.toLowerCase()]
                .sort()
                .join(":") === pairKey
          )
          .map(summarizeGame);
        cache.months[month] = { games, complete: month < currentMonth };
        // save as we go so closing the popup mid-scan doesn't lose progress
        await chrome.storage.local.set({ [cacheKey]: cache });
      } else {
        console.warn(`[Performance] h2h: couldn't load ${month} from either player`);
      }
      onProgress(++done, toFetch.length);
    }
  };
  await Promise.all(Array.from({ length: ARCHIVE_CONCURRENCY }, worker));

  const games = shared
    .flatMap((m) => cache.months[m]?.games || [])
    .sort((x, y) => y.endTime - x.endTime);

  const result = tallyHeadToHead(a, b, games);
  console.log(`[Performance] h2h ${a} vs ${b}:`, result);
  return result;
}
