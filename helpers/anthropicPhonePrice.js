'use strict';

const USD_TO_TZS = 2600;

function extractFirstTextBlock(content) {
  if (!Array.isArray(content)) return '';
  const b = content.find((x) => x && x.type === 'text' && typeof x.text === 'string');
  return b ? String(b.text) : '';
}

function tryParseJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  // Strip common fences just in case the model violates instruction.
  const clean = raw.replace(/```json|```/g, '').trim();
  try {
    return JSON.parse(clean);
  } catch (_) {
    // Try extracting the first {...} block.
    const m = clean.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]);
    } catch (_) {
      return null;
    }
  }
}

/**
 * Anthropic web-search based phone price lookup.
 *
 * @param {{ phone: string }} args
 * @returns {Promise<
 *   | { ok: true, phone: string, price_usd: number|null, price_tzs: number|null, source: string|null, raw: any }
 *   | { ok: false, error: string, raw?: any }
 * >}
 */
async function fetchAnthropicPhonePrice(args) {
  const phone = String(args?.phone || '').trim();
  if (!phone) return { ok: false, error: 'missing_phone' };

  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  if (!key) return { ok: false, error: 'missing_anthropic_api_key' };

  const body = {
    model: 'claude-sonnet-4-20250514',
    max_tokens: 700,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    system: `You are a phone price lookup assistant. Search the web for the current retail price of the phone the user asks about.
Reply ONLY with a raw JSON object (no markdown):
{
  "phone": "full model name",
  "price_usd": 299,
  "price_tzs": 777400,
  "source": "website name"
}
If price not found, return: {"error": "not found"}
Convert to TZS using: 1 USD = ${USD_TO_TZS} TZS`,
    messages: [{ role: 'user', content: `Find the current retail price of: ${phone}` }],
  };

  let res;
  let data;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
    });
    data = await res.json().catch(() => ({}));
  } catch (e) {
    return { ok: false, error: e?.message || 'anthropic_fetch_failed' };
  }

  if (!res?.ok) {
    const msg = data?.error?.message || data?.message || `http_${res?.status || 'unknown'}`;
    return { ok: false, error: msg, raw: data };
  }

  const text = extractFirstTextBlock(data?.content);
  const parsed = tryParseJsonObject(text);
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'anthropic_invalid_json', raw: data };
  }
  if (parsed.error) {
    return { ok: false, error: String(parsed.error), raw: parsed };
  }

  const outPhone = parsed.phone != null ? String(parsed.phone).trim() : phone;
  const priceUsd = parsed.price_usd != null ? Number(parsed.price_usd) : null;
  const priceTzs = parsed.price_tzs != null ? Number(parsed.price_tzs) : null;
  const source = parsed.source != null ? String(parsed.source).trim().slice(0, 200) : null;

  return {
    ok: true,
    phone: outPhone,
    price_usd: Number.isFinite(priceUsd) ? priceUsd : null,
    price_tzs: Number.isFinite(priceTzs) ? priceTzs : null,
    source: source || null,
    raw: parsed,
  };
}

module.exports = {
  USD_TO_TZS,
  fetchAnthropicPhonePrice,
  // exported for tests
  tryParseJsonObject,
};

