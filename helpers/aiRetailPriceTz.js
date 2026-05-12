'use strict';

/**
 * Lightweight “AI” price fetcher:
 * - Uses web search (DuckDuckGo lite HTML) to find a handful of listings
 * - Scrapes pages for TZS/TSh price mentions
 * - Returns median price + confidence + sources
 *
 * Notes:
 * - No external paid APIs or keys required.
 * - Intended for ops support; always allow manual override.
 */

const DEFAULT_TIMEOUT_MS = 9000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function withTimeout(promise, ms) {
  let t = null;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(new Error('timeout')), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.toString();
  } catch (_) {
    return null;
  }
}

function decodeDdgRedirect(href) {
  const raw = String(href || '').trim();
  if (!raw) return null;

  // DuckDuckGo lite often uses relative redirect links like:
  // /l/?uddg=https%3A%2F%2Fexample.com%2F...
  try {
    const u = new URL(raw, 'https://lite.duckduckgo.com');
    const uddg = u.searchParams.get('uddg');
    if (uddg) {
      const decoded = decodeURIComponent(uddg);
      return safeUrl(decoded);
    }
  } catch (_) {
    // fall through
  }

  // Protocol-relative.
  if (raw.startsWith('//')) return safeUrl(`https:${raw}`);

  return safeUrl(raw);
}

function stripHtml(s) {
  return String(s || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseMoneyCandidates(text) {
  const t = String(text || '');

  // Examples:
  // "TSh 450,000", "TZS 450000", "450,000 TSh", "450000/= ", "Sh 450,000"
  const patterns = [
    /\b(?:TSh|TZS|Sh)\s*([0-9][0-9,.\s]{3,})\b/gi,
    /\b([0-9][0-9,.\s]{3,})\s*(?:TSh|TZS)\b/gi,
    /\b([0-9][0-9,.\s]{3,})\s*\/=\b/gi,
  ];

  const out = [];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(t))) {
      const raw = (m[1] || '').trim();
      // Remove spaces, then normalize commas/dots.
      const cleaned = raw.replace(/\s+/g, '');
      // Treat both "," and "." as thousands separators here (TZ listings often use commas).
      const digits = cleaned.replace(/[.,]/g, '');
      const n = parseInt(digits, 10);
      if (!Number.isFinite(n)) continue;
      out.push(n);
    }
  }
  return out;
}

function clampReasonableTzs(n) {
  // Hard guardrails to avoid picking RAM/storage numbers etc.
  if (!Number.isFinite(n)) return null;
  if (n < 50_000) return null;
  if (n > 20_000_000) return null;
  return n;
}

function median(nums) {
  const a = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(a.length / 2);
  if (a.length % 2 === 1) return a[mid];
  return Math.round((a[mid - 1] + a[mid]) / 2);
}

function computeConfidence(values) {
  if (!values || !values.length) return 0;
  const n = values.length;
  const m = median(values);
  const devs = values.map((v) => Math.abs(v - m));
  const mad = median(devs);
  const relSpread = m > 0 ? mad / m : 1;

  // Heuristic:
  // - more sources => higher
  // - tighter agreement => higher
  const base = Math.min(0.75, 0.25 + 0.15 * Math.min(n, 4));
  const spreadPenalty = Math.min(0.6, relSpread * 2); // relSpread 0.2 => penalty 0.4
  const conf = Math.max(0, Math.min(1, base - spreadPenalty));
  return Math.round(conf * 100) / 100;
}

async function fetchText(url, timeoutMs) {
  const res = await withTimeout(
    fetch(url, {
      redirect: 'follow',
      headers: {
        // Simple UA to reduce blocks; keep generic.
        'user-agent': 'Mozilla/5.0 (compatible; KopanowPriceBot/1.0; +https://kopanow.local)',
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    }),
    timeoutMs,
  );
  // Some search providers return 202 with an interstitial/challenge HTML.
  // Treat that as a failure so we can fallback to another provider.
  if (!res.ok || res.status === 202) throw new Error(`http_${res.status}`);
  const txt = await res.text();
  // Hard size cap to avoid huge pages slowing the server.
  return txt.slice(0, 250_000);
}

function extractDdgLiteUrls(html, { limit = 5 } = {}) {
  const urls = [];

  // DuckDuckGo lite typically:
  // <a rel="nofollow" class="result-link" href="/l/?uddg=...">
  // but we also accept absolute URLs.
  const re = /class="result-link"[^>]*href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(String(html || '')))) {
    const u = decodeDdgRedirect(m[1]);
    if (!u) continue;
    urls.push(u);
    if (urls.length >= limit) break;
  }

  return urls;
}

async function ddgLiteSearchUrls(query, { limit = 5, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const q = encodeURIComponent(query);
  const url = `https://lite.duckduckgo.com/lite/?q=${q}`;
  const html = await fetchText(url, timeoutMs);
  return extractDdgLiteUrls(html, { limit });
}

function decodeBingRedirect(href) {
  const raw = String(href || '').trim().replace(/&amp;/g, '&');
  if (!raw) return null;

  // Many Bing links are /ck/a?...&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS8...
  // where u is base64url-ish with an 'a1' prefix.
  try {
    const u = new URL(raw, 'https://www.bing.com');
    const encoded = u.searchParams.get('u');
    if (encoded) {
      const s = String(encoded);
      const payload = s.startsWith('a1') ? s.slice(2) : s;
      // base64url -> base64
      const b64 = payload.replace(/-/g, '+').replace(/_/g, '/');
      const pad = '='.repeat((4 - (b64.length % 4)) % 4);
      const decoded = Buffer.from(b64 + pad, 'base64').toString('utf8');
      return safeUrl(decoded);
    }
  } catch (_) {
    // fall through
  }

  return safeUrl(raw);
}

function extractBingUrls(html, { limit = 5 } = {}) {
  const urls = [];
  const h = String(html || '');

  // Typical snippet:
  // <li class="b_algo" ...><h2><a ... href="...">
  const re = /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]*href="([^"]+)"/gi;
  let m;
  while ((m = re.exec(h))) {
    const u = decodeBingRedirect(m[1]);
    if (!u) continue;
    urls.push(u);
    if (urls.length >= limit) break;
  }

  return urls;
}

async function bingSearchUrls(query, { limit = 5, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const q = encodeURIComponent(query);
  const url = `https://www.bing.com/search?q=${q}`;
  const html = await fetchText(url, timeoutMs);
  return extractBingUrls(html, { limit });
}

/**
 * @param {{ manufacturer?: string, brand?: string, device_model?: string }} args
 * @returns {Promise<{ ok: true, price_tzs: number, confidence: number, sources: any[] } | { ok: false, error: string }>}
 */
async function fetchAiRetailPriceTzs(args) {
  try {
    const man = String(args?.manufacturer || '').trim();
    const br = String(args?.brand || '').trim();
    const mod = String(args?.device_model || '').trim();
    const label = [br || man, mod].filter(Boolean).join(' ').trim();
    if (!label) return { ok: false, error: 'missing_device_label' };

    // Try multiple search providers; DuckDuckGo is often blocked server-side (202 interstitial).
    // Bing tends to return a full HTML SERP without JS.
    const query = `${label} price Tanzania TSh`;
    let urls = [];
    try {
      urls = await ddgLiteSearchUrls(query, { limit: 5 });
    } catch (_) {}
    if (!urls.length) {
      try {
        urls = await bingSearchUrls(query, { limit: 5 });
      } catch (_) {}
    }
    if (!urls.length) return { ok: false, error: 'no_search_results' };

    const sources = [];
    const picked = [];

    for (const u of urls) {
      try {
        // Small delay to be polite.
        await sleep(250);
        const html = await fetchText(u, DEFAULT_TIMEOUT_MS);
        const text = stripHtml(html);
        const candidates = parseMoneyCandidates(text)
          .map(clampReasonableTzs)
          .filter(Boolean);
        if (!candidates.length) continue;

        // Pick the best candidate for this page as its median.
        const pagePrice = median(candidates);
        picked.push(pagePrice);

        // Title (best-effort) from <title>.
        const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
        const title = titleMatch ? stripHtml(titleMatch[1]).slice(0, 140) : '';

        sources.push({
          title: title || null,
          url: u,
          amount: pagePrice,
          currency: 'TZS',
          price_tzs: pagePrice,
          captured_at: new Date().toISOString(),
        });
      } catch (_) {
        // Ignore individual source failure; keep trying other pages.
      }
      if (sources.length >= 5) break;
    }

    if (!picked.length) return { ok: false, error: 'no_prices_found' };

    const price = median(picked);
    const confidence = computeConfidence(picked);

    return { ok: true, price_tzs: price, confidence, sources };
  } catch (e) {
    return { ok: false, error: e?.message || String(e) };
  }
}

module.exports = {
  fetchAiRetailPriceTzs,
  // exported for unit testing / debugging
  extractDdgLiteUrls,
  extractBingUrls,
};

