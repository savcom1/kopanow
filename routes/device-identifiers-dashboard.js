'use strict';

const express = require('express');
const router = express.Router();
const supabase = require('../helpers/supabase');
const { requireAdminDashboardAuth } = require('../helpers/adminDashboardAuth');
const { fetchAllCompletedDisbursementQueueRows } = require('../helpers/fetchCompletedDisbursementQueue');

const LOAN_ID_IN_CHUNK = 150;

function normalizeSearch(raw) {
  return raw != null ? String(raw).trim().toLowerCase() : '';
}

function rowMatchesSearch(row, q) {
  if (!q) return true;
  const hay = [
    row.borrower_id,
    row.loan_id,
    row.device_id,
    row.imei,
    ...(Array.isArray(row.imeis) ? row.imeis : []),
    row.hardware_serial,
    row.device_model,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return hay.includes(q);
}

function csvEscape(value) {
  const s = value == null ? '' : String(value);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

async function loadScopedDevices(search) {
  const queueRows = await fetchAllCompletedDisbursementQueueRows(supabase, 'loan_id, borrower_id');
  const loanIds = [...new Set(queueRows.map((row) => row.loan_id).filter(Boolean))];
  if (!loanIds.length) return [];

  const devices = [];
  for (let i = 0; i < loanIds.length; i += LOAN_ID_IN_CHUNK) {
    const chunk = loanIds.slice(i, i + LOAN_ID_IN_CHUNK);
    const { data, error } = await supabase
      .from('devices')
      .select('borrower_id, loan_id, device_id, imei, imeis, hardware_serial, device_model, updated_at')
      .in('loan_id', chunk);
    if (error) throw error;
    devices.push(...(data || []));
  }

  const q = normalizeSearch(search);
  return devices
    .map((row) => ({
      ...row,
      imeis: Array.isArray(row.imeis) ? row.imeis : row.imei ? [row.imei] : [],
    }))
    .filter((row) => rowMatchesSearch(row, q))
    .sort((a, b) => String(b.updated_at || '').localeCompare(String(a.updated_at || '')));
}

router.get('/summary', requireAdminDashboardAuth, async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const pageSize = Math.min(200, Math.max(10, parseInt(req.query.page_size, 10) || 50));
    const search = req.query.search || '';
    const all = await loadScopedDevices(search);
    const total = all.length;
    const start = (page - 1) * pageSize;
    const rows = all.slice(start, start + pageSize);
    return res.json({ success: true, total, page, page_size: pageSize, rows });
  } catch (err) {
    console.error('[device-identifiers] summary', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

router.get('/export.csv', requireAdminDashboardAuth, async (req, res) => {
  try {
    const search = req.query.search || '';
    const rows = await loadScopedDevices(search);
    const header = [
      'borrower_id',
      'loan_id',
      'device_id',
      'imei',
      'imeis',
      'hardware_serial',
      'device_model',
      'updated_at',
    ];
    const lines = [header.join(',')];
    for (const row of rows) {
      lines.push(
        [
          csvEscape(row.borrower_id),
          csvEscape(row.loan_id),
          csvEscape(row.device_id),
          csvEscape(row.imei),
          csvEscape((row.imeis || []).join(';')),
          csvEscape(row.hardware_serial),
          csvEscape(row.device_model),
          csvEscape(row.updated_at),
        ].join(','),
      );
    }
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="device-identifiers.csv"');
    return res.send(`${lines.join('\n')}\n`);
  } catch (err) {
    console.error('[device-identifiers] export.csv', err.message);
    return res.status(500).json({ success: false, error: err.message || 'Internal server error' });
  }
});

module.exports = router;
