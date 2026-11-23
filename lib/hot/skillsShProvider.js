/**
 * skills.sh leaderboard adapter.
 *
 * The site is a Next.js app: the leaderboard arrives as a server-rendered RSC
 * payload (`self.__next_f.push([1,"..."])`) instead of a public API. Everything
 * that knows about that shape lives here, so an upstream change breaks exactly
 * one module and the rest of the app keeps working on cached or bundled data.
 *
 * Deliberate constraints:
 *   - Fixed upstream URLs only. No caller-supplied URL ever reaches the fetch.
 *   - 5 s timeout, 2 MB response cap, `text/html` only.
 *   - Parse the embedded JSON; never eval, never execute upstream script.
 */

export const PAGE_URLS = {
  hot: 'https://skills.sh/hot',
  trending: 'https://skills.sh/trending',
  home: 'https://skills.sh/'
};

/** Cache TTLs from the design: the ranking page turns over fastest. */
export const PAGE_TTL_MS = {
  hot: 60_000,
  trending: 300_000,
  home: 600_000
};

export const LEADERBOARD_PAGES = Object.keys(PAGE_URLS);

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_./-]{1,200}$/;

/**
 * Fetch one leaderboard page and normalize its entries.
 *
 * `fetchImpl` is injectable so tests never touch the network.
 */
export async function fetchLeaderboardPage(page, options = {}) {
  const url = PAGE_URLS[page];
  if (!url) throw new Error(`Unknown leaderboard page: ${page}`);

  const {
    fetchImpl = globalThis.fetch,
    userAgent = 'skillcaddy',
    signal,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES
  } = options;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const abortUpstream = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', abortUpstream, { once: true });
  }

  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': userAgent, accept: 'text/html' },
      redirect: 'follow',
      signal: controller.signal
    });

    if (!response.ok) {
      const error = new Error(`Leaderboard ${page} responded ${response.status}`);
      error.status = response.status;
      error.retryAfterMs = parseRetryAfter(response.headers?.get?.('retry-after'));
      throw error;
    }

    const contentType = response.headers?.get?.('content-type') || '';
    if (!contentType.includes('text/html')) {
      throw new Error(`Leaderboard ${page} returned ${contentType || 'no content type'}`);
    }

    const html = await readCapped(response, maxBytes);
    const entries = parseLeaderboardHtml(html);
    if (entries.length === 0) {
      throw new Error(`Leaderboard ${page} payload has no skills`);
    }

    return { page, fetchedAt: new Date().toISOString(), entries };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener?.('abort', abortUpstream);
  }
}

/** Parse the `initialSkills` array out of an RSC payload. Exported for fixtures. */
export function parseLeaderboardHtml(html) {
  if (typeof html !== 'string' || !html) return [];
  const joined = extractFlightChunks(html).join('');
  const array = extractInitialSkills(joined);
  if (!array) return [];

  const seen = new Set();
  const entries = [];
  for (const raw of array) {
    const entry = normalizeEntry(raw);
    if (!entry || seen.has(entry.key)) continue;
    seen.add(entry.key);
    entries.push(entry);
  }
  return entries;
}

function extractFlightChunks(html) {
  const chunks = [];
  const pattern = /self\.__next_f\.push\(\[1,("(?:[^"\\]|\\.)*")\]\)/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    chunks.push(decodeJsonString(match[1]));
  }
  return chunks;
}

function decodeJsonString(literal) {
  try {
    return JSON.parse(literal);
  } catch {
    return literal.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
  }
}

function extractInitialSkills(text) {
  const marker = '"initialSkills":';
  const markerAt = text.indexOf(marker);
  if (markerAt === -1) return null;

  const start = text.indexOf('[', markerAt + marker.length);
  if (start === -1) return null;

  const end = findArrayEnd(text, start);
  if (end === -1) return null;

  try {
    const parsed = JSON.parse(text.slice(start, end));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Bracket matcher that respects JSON strings so `]` inside a name cannot end it. */
function findArrayEnd(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const source = typeof raw.source === 'string' ? raw.source.trim() : '';
  const skillId = typeof raw.skillId === 'string' ? raw.skillId.trim() : '';
  if (!SAFE_IDENTIFIER.test(source) || !SAFE_IDENTIFIER.test(skillId)) return null;

  const installs = toCount(raw.installs);
  if (installs === null) return null;

  const name = typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim() : skillId;
  const change = toCount(raw.change);
  const weeklyInstalls = toWeeklyInstalls(raw.weeklyInstalls);

  return {
    key: `${source}/${skillId}`,
    source,
    skillId,
    name: name.slice(0, 200),
    installs,
    change,
    weeklyInstalls,
    isOfficial: raw.isOfficial === true
  };
}

function toCount(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return null;
  return Math.trunc(value);
}

function toWeeklyInstalls(value) {
  if (!Array.isArray(value)) return null;
  const buckets = value
    .filter((item) => typeof item === 'number' && Number.isFinite(item) && item >= 0)
    .map((item) => Math.trunc(item));
  return buckets.length === value.length && buckets.length > 0 ? buckets.slice(-8) : null;
}

function parseRetryAfter(header) {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  return null;
}

async function readCapped(response, maxBytes) {
  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error('Leaderboard response exceeded the size cap');
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new Error('Leaderboard response exceeded the size cap');
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks).toString('utf8');
}
