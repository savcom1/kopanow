'use strict';

const API = '/api/admin/unpaid-invoices';
const KEY_STORAGE = 'kopanow_unpaid_invoices_dashboard_key';
const POLL_MS = 30000;

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
  const el = $('#uid-error');
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

function tzs(n) {
  return `TZS ${(Number(n) || 0).toLocaleString()}`;
}

function toIsoFromDatetimeLocal(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

function formatDefinition(definition) {
  if (!definition || typeof definition !== 'object') return '—';
  return Object.entries(definition)
    .map(([key, value]) => `${key}: ${value}`)
    .join(' · ');
}

function formatLoanIds(loanIds) {
  const list = Array.isArray(loanIds) ? loanIds : [];
  if (!list.length) return '—';
  const joined = list.join(', ');
  if (joined.length <= 48) return joined;
  return `${list.slice(0, 2).join(', ')} +${list.length - 2} more`;
}

function renderBorrowers(rows) {
  const tbody = $('#tbl-borrowers tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const row of rows || []) {
    const tr = document.createElement('tr');
    const fcmLabel = row.has_fcm_token ? 'Yes' : 'No';
    const fcmClass = row.has_fcm_token ? 'uid-pill uid-pill--ok' : 'uid-pill uid-pill--warn';
    tr.innerHTML =
      `<td>${escapeHtml(row.full_name || row.borrower_id || '—')}</td>` +
      `<td>${escapeHtml(row.phone || '—')}</td>` +
      `<td>${escapeHtml(row.overdue_installment_count ?? '—')}</td>` +
      `<td>${escapeHtml(tzs(row.total_amount_due))}</td>` +
      `<td>${escapeHtml(row.max_days_past_due ?? '—')}</td>` +
      `<td><span class="${fcmClass}">${escapeHtml(fcmLabel)}</span></td>` +
      `<td><code>${escapeHtml(formatLoanIds(row.loan_ids))}</code></td>`;
    tbody.appendChild(tr);
  }
}

function renderSummary(data) {
  const counts = data.counts || {};
  const metricBorrowers = $('#metric-borrowers');
  const metricWithFcm = $('#metric-with-fcm');
  const metricWithoutFcm = $('#metric-without-fcm');
  const metricRows = $('#metric-rows');
  const lastUpdated = $('#last-updated');
  const definition = $('#uid-definition');
  const truncation = $('#uid-truncation');

  if (metricBorrowers) metricBorrowers.textContent = String(counts.borrower_count ?? '—');
  if (metricWithFcm) metricWithFcm.textContent = String(counts.with_fcm_token_count ?? '—');
  if (metricWithoutFcm) metricWithoutFcm.textContent = String(counts.without_fcm_token_count ?? '—');
  if (metricRows) metricRows.textContent = String(counts.overdue_installment_rows_considered ?? '—');
  if (lastUpdated) lastUpdated.textContent = fmtIso(data.generated_at);
  if (definition) definition.textContent = formatDefinition(data.definition);

  if (truncation) {
    const flags = data.truncation || {};
    const parts = [];
    if (flags.invoices_truncated) parts.push('invoice query truncated');
    if (flags.customer_loan_ids_truncated) parts.push('customer loan scope truncated');
    if (parts.length) {
      truncation.hidden = false;
      truncation.textContent = `Warning: ${parts.join('; ')}.`;
    } else {
      truncation.hidden = true;
      truncation.textContent = '';
    }
  }

  renderBorrowers(data.borrowers);
}

async function apiFetch(path) {
  const res = await fetch(`${API}${path}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}

let inFlight = false;
let timer = null;

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  showError('');
  try {
    const qs = new URLSearchParams();
    const asOfIso = toIsoFromDatetimeLocal($('#as-of')?.value || '');
    if (asOfIso) qs.set('as_of', asOfIso);
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    const data = await apiFetch(`/summary${suffix}`);
    renderSummary(data);
  } catch (err) {
    console.error('[unpaid-invoices refresh]', err);
    showError(err.message || 'Failed to load summary');
  } finally {
    inFlight = false;
  }
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (document.visibilityState === 'visible') refresh();
  }, POLL_MS);
}

function init() {
  const keyInput = $('#admin-key');
  if (keyInput) {
    keyInput.value = getKey();
    keyInput.addEventListener('change', () => setKey(keyInput.value.trim()));
    keyInput.addEventListener('blur', () => setKey(keyInput.value.trim()));
  }

  $('#btn-refresh')?.addEventListener('click', () => refresh());
  $('#as-of')?.addEventListener('change', () => refresh());

  refresh();
  startPolling();
}

document.addEventListener('DOMContentLoaded', init);
