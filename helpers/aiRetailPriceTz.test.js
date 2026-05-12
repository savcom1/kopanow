'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { fetchAiRetailPriceTzs, extractDdgLiteUrls, extractBingUrls } = require('./aiRetailPriceTz');

test('fetchAiRetailPriceTzs rejects missing device label', async () => {
  const res = await fetchAiRetailPriceTzs({ manufacturer: '', brand: '', device_model: '' });
  assert.equal(res.ok, false);
  assert.equal(res.error, 'missing_device_label');
});

test('extractDdgLiteUrls decodes /l/?uddg= redirect links', () => {
  const html = `
    <a rel="nofollow" class="result-link" href="/l/?uddg=https%3A%2F%2Fexample.com%2Fphone%2Fprice">Example</a>
  `;
  const urls = extractDdgLiteUrls(html, { limit: 5 });
  assert.deepEqual(urls, ['https://example.com/phone/price']);
});

test('extractBingUrls decodes bing /ck/a? u= redirect links', () => {
  const b64 = Buffer.from('https://example.com/p', 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  const html = `
    <li class="b_algo"><h2><a href="https://www.bing.com/ck/a?!&amp;&amp;u=a1${b64}&amp;ntb=1">x</a></h2></li>
  `;
  const urls = extractBingUrls(html, { limit: 5 });
  assert.deepEqual(urls, ['https://example.com/p']);
});

