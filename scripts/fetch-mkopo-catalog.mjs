import fs from 'node:fs';
import path from 'node:path';

/**
 * Render/standalone deploy helper:
 * Ensure `data/device_mkopo.json` exists even when the Android `app/` folder
 * is not included in the deploy checkout.
 *
 * Source of truth is the monorepo repo/branch that contains the Android asset.
 */

const OUT_DIR = path.join(process.cwd(), 'data');
const OUT_PATH = path.join(OUT_DIR, 'device_mkopo.json');

// Use repo that contains the Android asset (adjust if you fork/rename).
const DEFAULT_URL =
  'https://raw.githubusercontent.com/savcom1/kopanow-backend/android/app/src/main/assets/device_mkopo.json';
const url = process.env.MKOPO_CATALOG_URL || DEFAULT_URL;

function log(msg) {
  // eslint-disable-next-line no-console
  console.log(`[mkopo-catalog] ${msg}`);
}

async function main() {
  if (fs.existsSync(OUT_PATH)) {
    log(`exists: ${OUT_PATH}`);
    return;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  log(`downloading: ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} fetching MKOPO catalog`);
  }
  const text = await res.text();
  if (!text.includes('"entries"')) {
    throw new Error('Downloaded MKOPO catalog did not look like expected JSON');
  }
  fs.writeFileSync(OUT_PATH, text, 'utf8');
  log(`saved: ${OUT_PATH} (${text.length} bytes)`);
}

main().catch((e) => {
  // If this fails, server may still run in monorepo dev where app asset exists.
  // On Render standalone deploy, you want this to fail fast.
  // eslint-disable-next-line no-console
  console.error('[mkopo-catalog] failed:', e?.message || String(e));
  process.exit(1);
});

