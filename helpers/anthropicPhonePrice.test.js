'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { tryParseJsonObject } = require('./anthropicPhonePrice');

test('tryParseJsonObject parses a JSON object', () => {
  const obj = tryParseJsonObject('{"phone":"X","price_usd":100,"price_tzs":260000,"source":"site"}');
  assert.equal(obj.phone, 'X');
  assert.equal(obj.price_usd, 100);
});

test('tryParseJsonObject tolerates fenced json', () => {
  const obj = tryParseJsonObject('```json\n{\"phone\":\"X\",\"price_tzs\":260000}\n```');
  assert.equal(obj.phone, 'X');
  assert.equal(obj.price_tzs, 260000);
});

