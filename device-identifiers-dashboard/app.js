'use strict';

const API = '/api/admin/device-identifiers';
const KEY_STORAGE = 'kopanow_device_identifiers_key';

function $(sel) {
  return document.querySelector(sel);
}

function setKey(k) {
  try {
    if (k) localStorage.setItem(KEY_STORAGE, k);
    else localStorage.removeItem(KEY_STORAGE);
  } catch (_) {}
}

function getKey() {
  try {
    return localStorage.getItem(KEY_STORAGE) || '';
  } catch (_) {
    return '';
  }
}

function headers() {
  const h = { 'content-type': 'application/json' };
  const k = $('#admin-key').value.trim();
  if (k) h['x-admin-key'] = k;
  return h;
}

function showError(msg) {
  const el = $('#di-error');
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtIso(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

let page = 1;
const pageSize = 50;

async function fetchSummary() {
  const search = $('#search').value.trim();
  const qs = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
  if (search) qs.set('search', search);
  const res = await fetch(`${API}/summary?${qs.toString()}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}

function renderRows(rows) {
  const tbody = $('#tbl-identifiers tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const row of rows || []) {
    const tr = document.createElement('tr');
    const allImeis = Array.isArray(row.imeis) ? row.imeis.join(', ') : '—';
    tr.innerHTML =
      `<td><code>${escapeHtml(row.borrower_id || '—')}</code></td>` +
      `<td><code>${escapeHtml(row.loan_id || '—')}</code></td>` +
      `<td><code>${escapeHtml(row.device_id || '—')}</code></td>` +
      `<td><code>${escapeHtml(row.imei || '—')}</code></td>` +
      `<td><code>${escapeHtml(allImeis)}</code></td>` +
      `<td><code>${escapeHtml(row.hardware_serial || '—')}</code></td>` +
      `<td>${escapeHtml(row.device_model || '—')}</td>` +
      `<td>${escapeHtml(fmtIso(row.updated_at))}</td>`;
    tbody.appendChild(tr);
  }
}

async function refresh() {
  showError('');
  try {
    const data = await fetchSummary();
    renderRows(data.rows);
    const total = data.total || 0;
    const start = total ? (page - 1) * pageSize + 1 : 0;
    const end = Math.min(page * pageSize, total);
    $('#di-summary').textContent = total
      ? `Showing ${start}–${end} of ${total} device row(s).`
      : 'No device rows in completed-disbursement scope.';
  } catch (err) {
    showError(err.message || String(err));
  }
}

async function exportCsv() {
  showError('');
  try {
    const search = $('#search').value.trim();
    const qs = new URLSearchParams();
    if (search) qs.set('search', search);
    const res = await fetch(`${API}/export.csv?${qs.toString()}`, { headers: headers() });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || data.message || res.statusText);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'device-identifiers.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  } catch (err) {
    showError(err.message || String(err));
  }
}

function init() {
  const keyInput = $('#admin-key');
  if (keyInput) {
    keyInput.value = getKey();
    keyInput.addEventListener('change', () => setKey(keyInput.value.trim()));
  }
  $('#btn-refresh').addEventListener('click', () => {
    page = 1;
    refresh();
  });
  $('#btn-export').addEventListener('click', exportCsv);
  $('#btn-prev').addEventListener('click', () => {
    if (page > 1) {
      page -= 1;
      refresh();
    }
  });
  $('#btn-next').addEventListener('click', () => {
    page += 1;
    refresh();
  });
  $('#search').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      page = 1;
      refresh();
    }
  });
  refresh();
}

document.addEventListener('DOMContentLoaded', init);
