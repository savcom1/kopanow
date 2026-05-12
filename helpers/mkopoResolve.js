'use strict';

/**
 * Server-side MKOPO tier resolution — keep in sync with Android [DeviceMkopoResolver]
 * and catalog file [data/device_mkopo.json] (copy of app asset device_mkopo.json).
 */

const fs = require('fs');
const path = require('path');
const { canonicalizeDeviceModel } = require('./deviceModel');

// Prefer backend-local catalog for standalone deploys (e.g. Render).
const CATALOG_PATH_BACKEND = path.join(__dirname, '..', 'data', 'device_mkopo.json');
// Monorepo fallback: Android bundled asset.
const CATALOG_PATH_MONOREPO = path.join(__dirname, '..', '..', 'app', 'src', 'main', 'assets', 'device_mkopo.json');

let cachedEntries = null;

function roundToNearest1000(tzs) {
  const n = Number(tzs);
  if (!Number.isFinite(n) || n <= 0) return Math.round(n);
  return Math.round(n / 1000) * 1000;
}

/** Match Kotlin DeviceMkopoCatalog hotfixes after JSON load. */
function applyCatalogHotfixes(list) {
  const upsert = (entry) => {
    const exists = list.some(
      (e) =>
        String(e.brand).toLowerCase() === String(entry.brand).toLowerCase() &&
        String(e.model).toLowerCase() === String(entry.model).toLowerCase()
    );
    if (!exists) list.push(entry);
  };
  upsert({ brand: 'Samsung', model: 'Galaxy A06', mkopoTzs: 20000, series: 'Galaxy A', maxAmountTzs: 20000 });
  upsert({
    brand: 'Samsung',
    model: 'Galaxy A05 (SM-A055F)',
    mkopoTzs: 20000,
    series: 'Galaxy A',
    patterns: ['SM-A055F'],
    maxAmountTzs: 20000,
  });
  list.sort((a, b) => {
    const ab = String(a.brand).localeCompare(String(b.brand));
    if (ab !== 0) return ab;
    const as = String(a.series || '').localeCompare(String(b.series || ''));
    if (as !== 0) return as;
    return String(a.model).localeCompare(String(b.model));
  });
}

function loadEntriesFromDisk() {
  const candidates = [CATALOG_PATH_BACKEND, CATALOG_PATH_MONOREPO].filter((p) => fs.existsSync(p));
  if (!candidates.length) {
    throw new Error(
      `MKOPO catalog not found. Expected one of: ${CATALOG_PATH_BACKEND} or ${CATALOG_PATH_MONOREPO}`
    );
  }
  const readVersion = (p) => {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const root = JSON.parse(raw);
      const v = Number(root.version);
      return Number.isFinite(v) ? v : 0;
    } catch (_) {
      return 0;
    }
  };
  // If both exist (dev monorepo), prefer the higher version.
  const p = candidates.sort((a, b) => readVersion(b) - readVersion(a))[0];
  const raw = fs.readFileSync(p, 'utf8');
  const root = JSON.parse(raw);
  const list = Array.isArray(root.entries) ? [...root.entries] : [];
  applyCatalogHotfixes(list);
  return list;
}

function getEntries() {
  if (!cachedEntries) {
    cachedEntries = loadEntriesFromDisk();
  }
  return cachedEntries;
}

/** For tests only */
function clearMkopoCatalogCache() {
  cachedEntries = null;
}

function resolveCanonicalBrands(manufacturer, brand, model) {
  const m = String(manufacturer || '').toLowerCase();
  const b = String(brand || '').toLowerCase();
  const mo = String(model || '').toLowerCase();
  /** @type {string[]} */
  const out = [];

  const add = (s) => {
    if (s && !out.includes(s)) out.push(s);
  };

  if (mo.startsWith('sm-')) add('Samsung');
  if (m.includes('samsung') || b.includes('samsung')) add('Samsung');
  if (m.includes('google') || b.includes('google') || mo.includes('pixel')) add('Google');
  if (
    m.includes('xiaomi') ||
    b.includes('xiaomi') ||
    m.includes('redmi') ||
    b.includes('redmi') ||
    mo.includes('redmi') ||
    m.includes('poco') ||
    b.includes('poco') ||
    mo.includes('poco')
  ) {
    add('Xiaomi');
  }
  if (m.includes('huawei') || b.includes('huawei')) add('Huawei');
  if (m.includes('honor') || b.includes('honor')) add('Honor');
  if (m.includes('oneplus') || b.includes('oneplus')) add('OnePlus');
  if (m.includes('oppo') || b.includes('oppo')) add('Oppo');
  if (m.includes('realme') || b.includes('realme')) add('Realme');
  if (m.includes('vivo') || b.includes('vivo') || m.includes('iqoo') || mo.includes('iqoo')) add('Vivo');
  if (m.includes('sony') || b.includes('sony')) add('Sony');
  if (m.includes('motorola') || b.includes('motorola')) add('Motorola');
  if (m.includes('nokia') || m.includes('hmd') || b.includes('hmd')) add('Nokia (HMD)');
  if (m.includes('nothing') || b.includes('nothing')) add('Nothing');
  if (m.includes('asus') || b.includes('asus')) add('Asus');
  if (m.includes('tecno') || b.includes('tecno')) add('Tecno');
  if (m.includes('infinix') || b.includes('infinix')) add('Infinix');
  if (m.includes('itel') || b.includes('itel')) add('Itel');
  if (m.includes('lenovo') || b.includes('lenovo')) add('Lenovo');
  if (m.includes('lg') || m.includes('lge')) add('LG');
  if (m.includes('meizu') || b.includes('meizu')) add('Meizu');
  if (m.includes('micromax') || b.includes('micromax')) add('Micromax');
  if (m.includes('nubia') || b.includes('nubia')) add('nubia');
  if (m.includes('sharp') || b.includes('sharp')) add('Sharp');
  if (m.includes('tcl') || b.includes('tcl')) add('TCL');
  if (m.includes('zte') || b.includes('zte')) add('ZTE');
  if (m.includes('alcatel') || b.includes('alcatel') || m.includes('tcl')) add('Alcatel');
  if (m.includes('blackberry') || b.includes('blackberry')) add('BlackBerry');
  if (m.includes('blackview') || b.includes('blackview')) add('Blackview');
  if (m.includes('blu')) add('BLU');
  if (m.includes('doogee') || b.includes('doogee')) add('Doogee');
  if (m.includes('fairphone') || b.includes('fairphone')) add('Fairphone');
  if (m.includes('ulefone') || b.includes('ulefone')) add('Ulefone');

  if (out.length === 0 && manufacturer && String(manufacturer).trim()) {
    const guess = String(manufacturer).trim().replace(/^./, (c) => c.toUpperCase());
    add(guess);
  }

  return out;
}

function entryMatchesBuild(entry, hayLower) {
  const patterns = entry.patterns;
  if (Array.isArray(patterns)) {
    for (const p of patterns) {
      if (p && hayLower.includes(String(p).toLowerCase())) return true;
    }
  }
  const modelLower = String(entry.model || '').toLowerCase();
  if (modelLower.length >= 4 && hayLower.includes(modelLower)) return true;

  const noGalaxy = String(entry.model || '').replace(/(Samsung\s+|Galaxy\s+)/gi, '').trim();
  if (noGalaxy.length >= 3 && hayLower.includes(noGalaxy.toLowerCase())) return true;

  const parts = String(entry.model || '')
    .split(/[\s+/]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  const significant = parts.filter(
    (part) =>
      part.length >= 2 &&
      !/^samsung$/i.test(part) &&
      !/^galaxy$/i.test(part)
  );
  if (significant.length >= 2 && significant.every((t) => hayLower.includes(t.toLowerCase()))) return true;

  return false;
}

function suggestFromBuildEntries(entries, manufacturer, brand, model, device) {
  const canonical = resolveCanonicalBrands(manufacturer, brand, model);

  const canonicalModelStr = canonicalizeDeviceModel({
    manufacturer,
    brand,
    model,
  });
  const hay = `${manufacturer} ${brand} ${model} ${device} ${canonicalModelStr}`.toLowerCase();

  /** @type {typeof entries} */
  const matches = [];
  for (const b of canonical) {
    const candidates = entries.filter((e) => String(e.brand).toLowerCase() === String(b).toLowerCase());
    for (const e of candidates) {
      if (entryMatchesBuild(e, hay)) matches.push(e);
    }
  }
  for (const e of entries) {
    const patterns = e.patterns;
    if (!Array.isArray(patterns) || !patterns.length) continue;
    for (const p of patterns) {
      if (p && hay.includes(String(p).toLowerCase())) {
        matches.push(e);
        break;
      }
    }
  }
  const rowKey = (e) => `${String(e.brand).toLowerCase()}|${String(e.model).toLowerCase()}`;
  const seen = new Set();
  const uniq = [];
  for (const e of matches) {
    const k = rowKey(e);
    if (!seen.has(k)) {
      seen.add(k);
      uniq.push(e);
    }
  }
  function effectiveMaxRounded(entry) {
    const mk = Number(entry.mkopoTzs) || 0;
    const cap = entry.maxAmountTzs != null ? Number(entry.maxAmountTzs) : mk;
    return roundToNearest1000(Math.max(cap, mk));
  }

  const bestMatch = uniq.length ? uniq.reduce((a, c) => (c.mkopoTzs < a.mkopoTzs ? c : a)) : null;
  if (bestMatch) {
    const rounded = roundToNearest1000(bestMatch.mkopoTzs);
    return {
      amountTzsRounded: rounded,
      amountMaxTzsRounded: effectiveMaxRounded(bestMatch),
      label: `${bestMatch.brand} ${bestMatch.model}`,
      entry: bestMatch,
    };
  }

  let fallback = null;
  for (const b of canonical) {
    const list = entries.filter((e) => String(e.brand).toLowerCase() === String(b).toLowerCase());
    const min = list.length ? list.reduce((a, c) => (c.mkopoTzs < a.mkopoTzs ? c : a)) : null;
    if (!min) continue;
    if (!fallback || min.mkopoTzs < fallback.mkopoTzs) fallback = min;
  }

  if (fallback) {
    const rounded = roundToNearest1000(fallback.mkopoTzs);
    return {
      amountTzsRounded: rounded,
      amountMaxTzsRounded: effectiveMaxRounded(fallback),
      label: `${fallback.brand} (default)`,
      entry: fallback,
    };
  }

  return null;
}

function suggestFromBrand(entries, manufacturer, brand) {
  const canonical = resolveCanonicalBrands(manufacturer, brand, '');
  if (!canonical.length) return null;

  let fallback = null;
  for (const b of canonical) {
    const list = entries.filter((e) => String(e.brand).toLowerCase() === String(b).toLowerCase());
    const min = list.length ? list.reduce((a, c) => (c.mkopoTzs < a.mkopoTzs ? c : a)) : null;
    if (!min) continue;
    if (!fallback || min.mkopoTzs < fallback.mkopoTzs) fallback = min;
  }
  if (!fallback) return null;
  const rounded = roundToNearest1000(fallback.mkopoTzs);
  const mk = Number(fallback.mkopoTzs) || 0;
  const cap = fallback.maxAmountTzs != null ? Number(fallback.maxAmountTzs) : mk;
  const amountMaxTzsRounded = roundToNearest1000(Math.max(cap, mk));
  return {
    amountTzsRounded: rounded,
    amountMaxTzsRounded,
    label: `${fallback.brand} (default)`,
    entry: fallback,
  };
}

/**
 * Resolved MKOPO for loan validation — same chain as RegistrationActivity on Android.
 * @returns {{ amountTzsRounded: number, amountMaxTzsRounded: number, label: string, entry?: object } | null}
 */
function resolveMkopoForDevice({ manufacturer, brand, model, device }) {
  const entries = getEntries();
  return (
    suggestFromBuildEntries(entries, manufacturer || '', brand || '', model || '', device || '') ||
    suggestFromBrand(entries, manufacturer || '', brand || '')
  );
}

function resolveMkopoForDeviceStrict({ manufacturer, brand, model, device }) {
  const entries = getEntries();
  // No brand list restriction here — allow pattern-led SKU matches across the whole catalog.
  // This is used for loan request enforcement, where brand-default fallbacks must NOT apply.
  const canonicalModelStr = canonicalizeDeviceModel({ manufacturer, brand, model });
  const hay = `${manufacturer || ''} ${brand || ''} ${model || ''} ${device || ''} ${canonicalModelStr || ''}`.toLowerCase();

  const matches = [];
  for (const e of entries) {
    const patterns = e.patterns;
    if (!Array.isArray(patterns) || !patterns.length) continue;
    for (const p of patterns) {
      if (p && hay.includes(String(p).toLowerCase())) {
        matches.push(e);
        break;
      }
    }
  }
  const bestMatch = matches.length ? matches.reduce((a, c) => (c.mkopoTzs < a.mkopoTzs ? c : a)) : null;
  if (!bestMatch) return null;

  const mk = Number(bestMatch.mkopoTzs) || 0;
  const cap = bestMatch.maxAmountTzs != null ? Number(bestMatch.maxAmountTzs) : mk;
  return {
    amountTzsRounded: roundToNearest1000(mk),
    amountMaxTzsRounded: roundToNearest1000(Math.max(cap, mk)),
    label: `${bestMatch.brand} ${bestMatch.model}`,
    entry: bestMatch,
  };
}

module.exports = {
  resolveMkopoForDeviceStrict,
  resolveMkopoForDevice,
  getEntries,
  clearMkopoCatalogCache,
  roundToNearest1000,
  /** exposed for tests */
  suggestFromBuildEntries,
  suggestFromBrand,
  resolveCanonicalBrands,
  entryMatchesBuild,
};
