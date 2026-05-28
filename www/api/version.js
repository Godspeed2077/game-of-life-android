// Vercel Serverless Function: /api/version?channel=stable|beta
// Returns { version, download_url, channel } pulled from the latest GitHub release.
// Used by forgepointrelay.com's download button and any other client that wants
// to know what build to fetch.

const REPO = 'Godspeed2077/game-of-life-android';
const ASSET_NAME = 'game-of-life.apk';

// Soft cache so we don't hammer the GitHub API
let cache = { stable: null, beta: null, fetchedAt: 0 };
const TTL_MS = 5 * 60 * 1000;

async function fetchLatestRelease(includePrerelease) {
  // For "stable" we want includePrerelease=false; GitHub's /releases/latest already excludes prereleases.
  // For "beta" we read /releases and grab the most recent prerelease, falling back to latest if none.
  if (!includePrerelease) {
    const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
      headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'forgepoint-relay-version-api' }
    });
    if (!r.ok) throw new Error('github_latest_' + r.status);
    return await r.json();
  }
  const r = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=10`, {
    headers: { 'Accept': 'application/vnd.github+json', 'User-Agent': 'forgepoint-relay-version-api' }
  });
  if (!r.ok) throw new Error('github_list_' + r.status);
  const list = await r.json();
  const pre = list.find(x => x.prerelease) || list[0];
  return pre;
}

function shape(release, channel) {
  if (!release) return { channel, version: null, download_url: null };
  const asset = (release.assets || []).find(a => a.name === ASSET_NAME)
             || (release.assets || []).find(a => /\.apk$/i.test(a.name));
  return {
    channel,
    version: release.tag_name || release.name || null,
    download_url: asset ? asset.browser_download_url : null,
    published_at: release.published_at || null
  };
}

export default async function handler(req, res) {
  const channel = (req.query && req.query.channel) === 'beta' ? 'beta' : 'stable';
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');

  try {
    const now = Date.now();
    if (now - cache.fetchedAt > TTL_MS || !cache[channel]) {
      const [stable, beta] = await Promise.all([
        fetchLatestRelease(false).catch(() => null),
        fetchLatestRelease(true).catch(() => null)
      ]);
      cache = {
        stable: shape(stable, 'stable'),
        beta: shape(beta, 'beta'),
        fetchedAt: now
      };
    }
    res.status(200).json(cache[channel]);
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e), channel });
  }
}
