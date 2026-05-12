'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  computeProfit,
  profitStatusColor,
  customersOnlyDefinition,
  invoiceIsUnpaidPastDue,
} = require('./customersWorkflowKpi');

test('computeProfit is received - disbursed', () => {
  assert.equal(computeProfit(1000, 500), 500);
  assert.equal(computeProfit(500, 1000), -500);
});

test('profitStatusColor is red when negative', () => {
  assert.equal(profitStatusColor(-1), 'red');
  assert.equal(profitStatusColor(0), 'green');
  assert.equal(profitStatusColor(10), 'green');
});

test('customersOnlyDefinition includes confirmed disbursement only', () => {
  assert.deepEqual(customersOnlyDefinition(), { cash_disbursement_confirmed: true });
});

test('invoiceIsUnpaidPastDue: pending past due, pending future, overdue status', () => {
  const asOfMs = new Date('2026-05-07T12:00:00.000Z').getTime();
  assert.equal(
    invoiceIsUnpaidPastDue({ status: 'pending', due_date: '2026-05-06T00:00:00.000Z' }, asOfMs),
    true,
  );
  assert.equal(
    invoiceIsUnpaidPastDue({ status: 'pending', due_date: '2026-05-08T00:00:00.000Z' }, asOfMs),
    false,
  );
  assert.equal(
    invoiceIsUnpaidPastDue({ status: 'overdue', due_date: '2026-05-08T00:00:00.000Z' }, asOfMs),
    true,
  );
  assert.equal(invoiceIsUnpaidPastDue({ status: 'paid', due_date: '2026-05-01T00:00:00.000Z' }, asOfMs), false);
});

