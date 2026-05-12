'use strict';

const API = '/api/admin/collections';
const KEY_STORAGE = 'kopanow_collections_dashboard_key';
const HISTORY_KEY = 'collections_chart_history';
const SIDEBAR_COLLAPSED_KEY = 'collections_sidebar_collapsed';
const HISTORY_CAP = 24;
const POLL_MS = 10 * 60 * 1000;

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

async function apiFetch(path) {
  const res = await fetch(`${API}${path}`, { headers: headers() });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}

function tzs(n) {
  return `TZS ${(Number(n) || 0).toLocaleString()}`;
}

/** API may return numbers or numeric strings (with commas). */
function numFromApi(v) {
  if (v == null) return 0;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const n = parseFloat(String(v).replace(/,/g, '').trim());
  return Number.isFinite(n) ? n : 0;
}

function setText(sel, value) {
  const el = $(sel);
  if (el) el.textContent = value;
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

const FCM_WITHOUT_CATEGORY_ORDER = [
  'admin_removed',
  'suspended',
  'withdrawn',
  'locked',
  'active_missing_token',
  'no_device_row',
];

function fcmReachabilityLoaded(fcm) {
  return !!fcm && fcm.customers_total != null;
}

function renderCustomerFcmReachability(fcm) {
  const loaded = fcmReachabilityLoaded(fcm);
  if (!loaded) {
    setText('#cd-fcm-without', '—');
    setText('#cd-fcm-with', '—');
    setText('#cd-fcm-without-sub', 'FCM reachability unavailable');
    setText('#cd-fcm-with-sub', 'Restart the backend serving this page');
    setText('#cd-fcm-overdue-without', '—');
    setText('#cd-fcm-admin-removed', '—');
    setText('#cd-fcm-admin-removed-sub', 'No FCM token · device admin removed');
    renderFcmWithoutReport(null);
    return false;
  }

  const adminRemovedCount = Number(fcm.without_fcm_by_category?.admin_removed || 0);
  setText('#cd-fcm-without', Number(fcm.without_fcm_token_count || 0).toLocaleString());
  setText('#cd-fcm-with', Number(fcm.with_fcm_token_count || 0).toLocaleString());
  setText('#cd-fcm-admin-removed', adminRemovedCount.toLocaleString());
  setText(
    '#cd-fcm-admin-removed-sub',
    `Of ${Number(fcm.without_fcm_token_count || 0).toLocaleString()} without FCM token`,
  );
  setText(
    '#cd-fcm-without-sub',
    `Of ${Number(fcm.customers_total || 0).toLocaleString()} cash-sent customers`,
  );
  setText(
    '#cd-fcm-with-sub',
    `Of ${Number(fcm.customers_total || 0).toLocaleString()} cash-sent customers`,
  );
  setText(
    '#cd-fcm-overdue-without',
    Number(fcm.overdue_unpaid?.without_fcm_token_count || 0).toLocaleString(),
  );
  renderFcmWithoutReport(fcm);
  return true;
}

function renderFcmWithoutReport(fcm) {
  const categoryGrid = $('#cd-fcm-category-grid');
  const tbody = $('#cd-fcm-report-body');
  const emptyEl = $('#cd-fcm-report-empty');
  const tableWrap = document.querySelector('.cd-fcm-report__table-wrap');
  if (!fcmReachabilityLoaded(fcm)) {
    if (categoryGrid) categoryGrid.innerHTML = '';
    if (tbody) tbody.innerHTML = '';
    if (emptyEl) emptyEl.hidden = true;
    if (tableWrap) tableWrap.hidden = true;
    setText(
      '#cd-fcm-report-sub',
      'FCM reachability unavailable — refresh after the backend on this host is updated.',
    );
    return;
  }

  const report = fcm.without_fcm_report || {};
  const labels = fcm.without_fcm_category_labels || {};
  const byCategory = fcm.without_fcm_by_category || {};
  const withoutTotal = Number(fcm.without_fcm_token_count || 0);
  const customersTotal = Number(fcm.customers_total || 0);

  setText(
    '#cd-fcm-report-sub',
    withoutTotal > 0
      ? `${withoutTotal.toLocaleString()} of ${customersTotal.toLocaleString()} cash-sent customers · grouped by device state`
      : 'Cash-sent customers unreachable by push · grouped by device state',
  );

  if (categoryGrid) {
    const cards = FCM_WITHOUT_CATEGORY_ORDER.map((key) => {
      const count = Number(byCategory[key] || 0);
      if (!count) return '';
      const label = labels[key] || key;
      return `<article class="cd-mini-stat"><div class="cd-mini-stat__label">${escapeHtml(label)}</div><div class="cd-mini-stat__value">${count.toLocaleString()}</div><div class="cd-mini-stat__sub">No FCM token</div></article>`;
    }).filter(Boolean);
    categoryGrid.innerHTML = cards.join('');
  }

  const rows = Array.isArray(report.rows) ? report.rows : [];
  if (tbody) {
    tbody.innerHTML = rows
      .map((row) => {
        const loanIds = Array.isArray(row.loan_ids) ? row.loan_ids.join(', ') : '—';
        return `<tr>
          <td>${escapeHtml(row.category_label || row.category || '—')}</td>
          <td><code>${escapeHtml(row.borrower_id || '—')}</code></td>
          <td><code>${escapeHtml(loanIds)}</code></td>
          <td>${escapeHtml(row.device_status || '—')}</td>
          <td>${escapeHtml(row.loan_device_status || '—')}</td>
          <td>${escapeHtml(fmtIso(row.device_updated_at))}</td>
        </tr>`;
      })
      .join('');
  }

  const showEmpty = withoutTotal <= 0;
  if (emptyEl) emptyEl.hidden = !showEmpty;
  if (tableWrap) tableWrap.hidden = showEmpty;
  if (tbody && tbody.parentElement) tbody.parentElement.hidden = showEmpty;
}

function toIsoFromDatetimeLocal(v) {
  if (!v) return '';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString();
}

/** Fill datetime-local from an ISO string (mirrors server cut-off in local time). */
function isoToDatetimeLocalValue(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function applyIcons() {
  if (typeof lucide !== 'undefined' && lucide.createIcons) {
    lucide.createIcons();
  }
}

function readHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch (_) {
    return [];
  }
}

function writeHistory(arr) {
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(arr.slice(-HISTORY_CAP)));
  } catch (_) {}
}

function pushHistoryPoint(point) {
  const arr = readHistory();
  const last = arr[arr.length - 1];
  if (
    last &&
    last.received === point.received &&
    last.rolling === point.rolling &&
    last.scheduled === point.scheduled &&
    last.matchPct === point.matchPct
  ) {
    return arr;
  }
  arr.push(point);
  writeHistory(arr);
  return arr;
}

function trendArrow(curr, prev, invert) {
  if (prev == null || Number.isNaN(prev) || Number.isNaN(curr)) return { text: '—', cls: '' };
  const eps = 1e-6;
  if (Math.abs(curr - prev) < eps) return { text: 'Flat', cls: '' };
  const up = curr > prev;
  const good = invert ? !up : up;
  const arrow = up ? '↑' : '↓';
  return {
    text: `${arrow} ${Math.abs(curr - prev).toLocaleString(undefined, { maximumFractionDigits: 0 })}`,
    cls: good ? 'cd-kpi__trend--up' : 'cd-kpi__trend--down',
  };
}

function renderSparkline(svgEl, values) {
  if (!svgEl) return;
  const v = (values || []).map(Number).filter((x) => Number.isFinite(x));
  if (v.length < 2) {
    svgEl.innerHTML = '';
    return;
  }
  const min = Math.min(...v);
  const max = Math.max(...v);
  const pad = 2;
  const W = 120;
  const H = 36;
  const span = max - min || 1;
  const pts = v.map((val, i) => {
    const x = pad + (i / (v.length - 1)) * (W - pad * 2);
    const y = pad + (1 - (val - min) / span) * (H - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  svgEl.innerHTML = `<polyline points="${pts.join(' ')}" />`;
}

function renderAreaChart(svgEl, history) {
  const canvas = document.querySelector('.cd-chart--primary .cd-chart__canvas');
  if (!svgEl || !canvas) return;
  const h = (history || []).filter((p) => p && Number.isFinite(p.received));
  if (h.length < 2) {
    canvas.classList.remove('cd-chart__canvas--has-data');
    return;
  }
  canvas.classList.add('cd-chart__canvas--has-data');
  const W = 640;
  const H = 220;
  const padL = 48;
  const padR = 16;
  const padT = 16;
  const padB = 36;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const recv = h.map((p) => p.received);
  const roll = h.map((p) => p.rolling);
  const min = Math.min(...recv, ...roll, 0);
  const max = Math.max(...recv, ...roll, 1);
  const span = max - min || 1;
  const n = h.length;
  const xAt = (i) => padL + (i / (n - 1)) * innerW;
  const yAt = (val) => padT + (1 - (val - min) / span) * innerH;

  const lineRecv = h.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.received).toFixed(1)}`).join(' ');
  const lineRoll = h.map((p, i) => `${xAt(i).toFixed(1)},${yAt(p.rolling).toFixed(1)}`).join(' ');
  const areaD = `M ${xAt(0).toFixed(1)} ${padT + innerH} L ${h.map((p, i) => `${xAt(i).toFixed(1)} ${yAt(p.received).toFixed(1)}`).join(' L ')} L ${xAt(n - 1).toFixed(1)} ${padT + innerH} Z`;

  svgEl.innerHTML = `
    <defs>
      <linearGradient id="cdAreaFill" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#2dd4bf" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#2dd4bf" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${W}" height="${H}" fill="transparent" />
    <path d="${areaD}" fill="url(#cdAreaFill)" stroke="none" />
    <polyline points="${lineRecv}" fill="none" stroke="#2dd4bf" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
    <polyline points="${lineRoll}" fill="none" stroke="rgba(139,147,167,0.9)" stroke-width="1.5" stroke-dasharray="6 4" stroke-linecap="round" />
    <text x="${padL}" y="${H - 8}" fill="#8b93a7" font-size="11" font-family="DM Sans,system-ui,sans-serif">All Lipa received (accent) · Rolling (dashed)</text>
  `;
}

function renderDonut(svgEl, legendEl, sliceA, sliceB, opts) {
  const o = opts || {};
  const labelA = o.labelA || 'Received';
  const labelB = o.labelB || 'Scheduled';
  const centerLine = o.centerLine || 'slice A share';
  const accentIsFirst = o.accentIsFirst !== false;
  const wrap = document.querySelector('.cd-chart__canvas--donut');
  const empty = $('#cd-chart-donut-empty');
  if (!svgEl || !wrap) return;
  const a = Math.max(0, Number(sliceA) || 0);
  const b = Math.max(0, Number(sliceB) || 0);
  const sum = a + b;
  if (sum <= 0) {
    svgEl.innerHTML = '';
    if (legendEl) legendEl.textContent = '';
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  const fracA = a / sum;
  const C = 2 * Math.PI * 70;
  const lenA = fracA * C;
  const lenB = C - lenA;
  const strokeFirst = accentIsFirst ? 'var(--cd-accent)' : 'rgba(139,147,167,0.75)';
  const strokeSecond = accentIsFirst ? 'rgba(139,147,167,0.75)' : 'var(--cd-accent)';
  svgEl.innerHTML = `
    <g transform="translate(100,100) rotate(-90)">
      <circle r="70" cx="0" cy="0" fill="none" stroke="rgba(139,147,167,0.35)" stroke-width="22" />
      <circle r="70" cx="0" cy="0" fill="none" stroke="${strokeFirst}" stroke-width="22"
        stroke-dasharray="${lenA} ${C}" stroke-linecap="butt" />
      <circle r="70" cx="0" cy="0" fill="none" stroke="${strokeSecond}" stroke-width="22"
        stroke-dasharray="${lenB} ${C}" stroke-dashoffset="${-lenA}" stroke-linecap="butt" />
    </g>
    <text x="100" y="104" text-anchor="middle" fill="var(--cd-text)" font-size="14" font-weight="700" font-family="var(--cd-font-display)">${(fracA * 100).toFixed(0)}%</text>
    <text x="100" y="124" text-anchor="middle" fill="var(--cd-muted)" font-size="10" font-family="var(--cd-font-body)">${escapeHtml(centerLine)}</text>
  `;
  if (legendEl) {
    const c1 = accentIsFirst ? 'var(--cd-accent)' : '#8b93a7';
    const c2 = accentIsFirst ? '#8b93a7' : 'var(--cd-accent)';
    legendEl.innerHTML = `<span style="color:${c1}">●</span> ${escapeHtml(labelA)} ${tzs(a)} · <span style="color:${c2}">●</span> ${escapeHtml(labelB)} ${tzs(b)}`;
  }
}

let lastSnapshot = null;

function render(data) {
  const errEl = $('#cd-error');
  if (errEl) {
    errEl.hidden = true;
    errEl.textContent = '';
  }

  setText('#last-updated', fmtIso(data.generated_at));
  setText('#chip-as-of', `As of ${fmtIso(data.as_of)}`);

  const recv = data.lipa_received_through_as_of || {};
  const grand = data.lipa_grand_totals_le_as_of;
  const rowCount = Number(recv.row_count || 0);
  const lipaAllAmt = numFromApi(recv.amount_tzs);
  const grandReceivedAmt =
    grand != null && typeof grand === 'object' ? numFromApi(grand.amount_all_tzs) : lipaAllAmt;
  const claimedFlowAmt = grand != null && typeof grand === 'object' ? numFromApi(grand.amount_claimed_tzs) : 0;
  const unclaimedFlowAmt =
    grand != null && typeof grand === 'object' ? numFromApi(grand.amount_unclaimed_tzs) : 0;
  const lipa = data.lipa_till || {};
  const rollingAmt = numFromApi(lipa.amount_window_tzs);
  const sch = data.scheduled_installments_through_as_of || {};
  const scheduledAmt = numFromApi(sch.amount_tzs);
  const claimSharePct =
    grandReceivedAmt > 0 ? (100 * claimedFlowAmt) / grandReceivedAmt : 0;

  const prev = lastSnapshot;
  lastSnapshot = { receivedAmt: grandReceivedAmt, rollingAmt, scheduledAmt, matchPct: claimSharePct };

  setText('#cd-val-received', tzs(grandReceivedAmt));
  const lipaTrunc = recv.truncated || (grand && grand.truncated) ? ' · sum capped (pagination limit)' : '';
  setText(
    '#cd-sub-received',
    `Claimed ${tzs(claimedFlowAmt)} · unclaimed ${tzs(unclaimedFlowAmt)} · ${rowCount.toLocaleString()} rows ≤ as_of${lipaTrunc}`,
  );

  setText('#cd-val-rolling', tzs(rollingAmt));
  setText(
    '#cd-sub-rolling',
    `${fmtIso(lipa.window_from)} → ${fmtIso(lipa.window_to)} · ${Number(lipa.row_count_window || 0).toLocaleString()} rows`,
  );

  setText('#cd-val-scheduled', tzs(scheduledAmt));
  const dueYmd = sch.due_calendar_date ? String(sch.due_calendar_date) : '';
  const dueTz = sch.due_time_zone ? String(sch.due_time_zone).split('/').pop() || sch.due_time_zone : '';
  const truncNote = data.invoices_truncated ? ' · invoice list may be truncated (cap hit)' : '';
  const dueLine =
    dueYmd && dueTz
      ? `${Number(sch.invoice_count || 0).toLocaleString()} invoices · due ≤ ${dueYmd} (${dueTz}) · cash-sent loans only${truncNote}`
      : `${Number(sch.invoice_count || 0).toLocaleString()} invoices · past through today · cash-sent loans only${truncNote}`;
  setText('#cd-sub-scheduled', dueLine);

  const asOfEl = $('#as-of');
  const liveAsOf = $('#cd-live-as-of');
  if (asOfEl && liveAsOf && liveAsOf.checked && data.as_of) {
    asOfEl.value = isoToDatetimeLocalValue(data.as_of);
  }

  setText('#cd-val-match', grandReceivedAmt > 0 ? `${claimSharePct.toFixed(1)}%` : '—');
  setText(
    '#cd-sub-match',
    grandReceivedAmt > 0 ? `${tzs(claimedFlowAmt)} of ${tzs(grandReceivedAmt)} Lipa` : 'No Lipa amount ≤ as_of',
  );

  setText('#cd-chip-match-mode', 'All lipa_transactions · till/name filters disabled');

  const dueCustomers = data.due_customers_as_of || {};
  setText('#cd-due-reached', Number(dueCustomers.due_reached_borrower_count || 0).toLocaleString());
  setText('#cd-due-paid', Number(dueCustomers.paid_borrower_count || 0).toLocaleString());
  setText('#cd-due-overdue', Number(dueCustomers.overdue_borrower_count || 0).toLocaleString());
  setText(
    '#cd-due-overdue-sub',
    `Open pending/overdue past due · ${Number(dueCustomers.overdue_installment_rows_considered || 0).toLocaleString()} installments`,
  );
  setText('#cd-due-open', Number(dueCustomers.open_due_borrower_count || 0).toLocaleString());
  const dueYmdCustomers = dueCustomers.due_calendar_date ? String(dueCustomers.due_calendar_date) : '';
  const dueTzCustomers = dueCustomers.due_time_zone
    ? String(dueCustomers.due_time_zone).split('/').pop() || dueCustomers.due_time_zone
    : '';
  const dueCustomersSub =
    dueYmdCustomers && dueTzCustomers
      ? `Due ≤ ${dueYmdCustomers} (${dueTzCustomers}) · ${Number(dueCustomers.installment_rows_considered || 0).toLocaleString()} installments`
      : `Due through today · ${Number(dueCustomers.installment_rows_considered || 0).toLocaleString()} installments`;
  setText('#cd-due-customers-sub', `Cash-sent loans only · ${dueCustomersSub}`);
  setText('#cd-due-reached-sub', 'Unique borrowers with due installments');

  const fcmLoaded = renderCustomerFcmReachability(data.customer_fcm_reachability);

  const history = pushHistoryPoint({
    t: Date.now(),
    received: grandReceivedAmt,
    rolling: rollingAmt,
    scheduled: scheduledAmt,
    matchPct: claimSharePct,
  });

  const recvSeries = history.map((p) => p.received);
  const rollSeries = history.map((p) => p.rolling);
  const schSeries = history.map((p) => p.scheduled);
  const matchSeries = history.map((p) => p.matchPct);

  function setTrend(sel, curr, pval, opts) {
    const el = $(sel);
    if (!el) return;
    const { invert, isPct } = opts || {};
    const t = trendArrow(curr, pval, invert);
    if (isPct) {
      el.textContent = pval == null || Number.isNaN(pval) ? '—' : `${t.text} pts`;
    } else {
      el.textContent = pval == null || Number.isNaN(pval) ? '—' : `${t.text} TZS`;
    }
    el.classList.remove('cd-kpi__trend--up', 'cd-kpi__trend--down');
    if (t.cls) el.classList.add(t.cls);
  }

  setTrend('#cd-trend-received', grandReceivedAmt, prev ? prev.receivedAmt : null, {});
  setTrend('#cd-trend-rolling', rollingAmt, prev ? prev.rollingAmt : null, {});
  setTrend('#cd-trend-scheduled', scheduledAmt, prev ? prev.scheduledAmt : null, {});
  setTrend('#cd-trend-match', claimSharePct, prev ? prev.matchPct : null, { invert: false, isPct: true });

  renderSparkline($('#cd-spark-received'), recvSeries);
  renderSparkline($('#cd-spark-rolling'), rollSeries);
  renderSparkline($('#cd-spark-scheduled'), schSeries);
  renderSparkline($('#cd-spark-match'), matchSeries);

  renderAreaChart($('#cd-chart-area'), history);
  if (grandReceivedAmt > 0) {
    renderDonut($('#cd-chart-donut'), $('#cd-donut-legend'), claimedFlowAmt, unclaimedFlowAmt, {
      labelA: 'Claimed',
      labelB: 'Unclaimed',
      centerLine: 'claimed share of Lipa',
      accentIsFirst: true,
    });
  } else {
    renderDonut($('#cd-chart-donut'), $('#cd-donut-legend'), lipaAllAmt, scheduledAmt, {
      labelA: 'Lipa (all)',
      labelB: 'Scheduled',
      centerLine: 'Lipa vs scheduled',
      accentIsFirst: true,
    });
  }

  const tbody = $('#lipa-transactions-body');
  const emptyEl = $('#lipa-transactions-empty');
  const rows = data.lipa_transactions_preview || [];
  if (tbody) {
    tbody.innerHTML = '';
    for (const r of rows) {
      const tr = document.createElement('tr');
      const amt = r.amount != null ? Number(r.amount) : null;
      const hasAmt = amt != null && !Number.isNaN(amt);
      const badge = hasAmt
        ? '<span class="cd-badge cd-badge--ok">Amount</span>'
        : '<span class="cd-badge cd-badge--warn">Parse</span>';
      const amtCell = hasAmt ? amt.toLocaleString() : '—';
      tr.innerHTML =
        `<td class="num">${escapeHtml(amtCell)}</td>` +
        `<td>${badge}</td>` +
        `<td>${escapeHtml(String(r.transaction_ref || '—'))}</td>` +
        `<td>${escapeHtml(fmtIso(r.ingested_at))}</td>` +
        `<td>${escapeHtml(String(r.till_number ?? '—'))}</td>` +
        `<td>${escapeHtml(String(r.till_contract_name ?? '—'))}</td>`;
      tbody.appendChild(tr);
    }
  }
  if (emptyEl) emptyEl.hidden = rows.length > 0;

  const warns = [];
  if (!fcmLoaded) {
    warns.push(
      'FCM reachability is missing from the collections summary — restart the backend serving this page, then refresh.',
    );
  }
  if (data.invoices_truncated) {
    warns.push('Invoice query hit 100k cap — scheduled amounts and due-customer counts may be incomplete.');
  }
  if (data.confirmed_queue_truncated) warns.push('Disbursement queue hit 50k cap — loan scope may be incomplete.');
  if (recv.truncated || (grand && grand.truncated)) {
    warns.push('Lipa amount sum hit pagination safety cap — totals may be incomplete.');
  }
  const wEl = $('#truncation-warn');
  if (wEl) {
    wEl.hidden = warns.length === 0;
    wEl.textContent = warns.join(' ');
  }

  const raw = $('#raw-out');
  if (raw) raw.textContent = JSON.stringify(data, null, 2);

  const sumEl = $('#cd-filters-summary');
  if (sumEl) {
    sumEl.textContent = `Window ${String($('#cd-window')?.value || 'day')} · all Lipa rows · installments = completed cash disbursement only · donut = claimed vs unclaimed`;
  }

  updateAvatar();
  applyIcons();
}

function updateAvatar() {
  const el = $('#cd-avatar');
  if (!el) return;
  const k = $('#admin-key')?.value.trim() || getKey();
  if (!k) {
    el.textContent = 'KO';
    return;
  }
  const a = k.slice(0, 2).toUpperCase().replace(/[^A-Z0-9]/g, '') || 'KO';
  el.textContent = a.length >= 2 ? a : k.slice(0, 2).toUpperCase();
}

function setLoading(on) {
  document.body.classList.toggle('cd-loading', on);
  const main = $('#cd-main');
  if (main) main.setAttribute('aria-busy', on ? 'true' : 'false');
}

let timer = null;
let inFlight = false;

async function refresh() {
  if (inFlight) return;
  inFlight = true;
  setLoading(true);
  try {
    const qs = new URLSearchParams();
    const liveAsOf = $('#cd-live-as-of');
    if (!liveAsOf || !liveAsOf.checked) {
      const asOfIso = toIsoFromDatetimeLocal($('#as-of').value);
      if (asOfIso) qs.set('as_of', asOfIso);
    }

    const w = $('#cd-window')?.value || 'day';
    qs.set('window', w);
    const fromIso = toIsoFromDatetimeLocal($('#from').value);
    const toIso = toIsoFromDatetimeLocal($('#to').value);
    if (fromIso && toIso) {
      qs.set('from', fromIso);
      qs.set('to', toIso);
    }

    const data = await apiFetch(`/summary?${qs.toString()}`);
    render(data);
  } catch (err) {
    const errEl = $('#cd-error');
    if (errEl) {
      errEl.hidden = false;
      errEl.textContent = err.message || String(err);
    }
    const raw = $('#raw-out');
    if (raw) {
      raw.hidden = false;
      raw.textContent = JSON.stringify({ error: err.message }, null, 2);
    }
  } finally {
    setLoading(false);
    inFlight = false;
  }
}

function startPolling() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (document.hidden) return;
    refresh().catch(() => {});
  }, POLL_MS);
}

function initSidebar() {
  const app = document.body;
  const mq = window.matchMedia('(max-width: 768px)');
  let collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';

  function applyDesktopCollapse() {
    if (!mq.matches) {
      collapsed = localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === '1';
      app.classList.toggle('cd-app--sidebar-collapsed', collapsed);
    } else app.classList.remove('cd-app--sidebar-collapsed');
    const btn = $('#cd-sidebar-toggle');
    if (btn && !mq.matches) btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
  }
  applyDesktopCollapse();
  mq.addEventListener('change', applyDesktopCollapse);

  $('#cd-sidebar-toggle')?.addEventListener('click', () => {
    if (mq.matches) return;
    app.classList.toggle('cd-app--sidebar-collapsed');
    collapsed = app.classList.contains('cd-app--sidebar-collapsed');
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
    const btn = $('#cd-sidebar-toggle');
    if (btn) btn.setAttribute('aria-pressed', collapsed ? 'true' : 'false');
  });

  function closeMobileSidebar() {
    app.classList.remove('cd-sidebar-open');
    $('#cd-nav-toggle')?.setAttribute('aria-expanded', 'false');
  }

  $('#cd-nav-toggle')?.addEventListener('click', () => {
    if (!mq.matches) return;
    const open = !app.classList.contains('cd-sidebar-open');
    app.classList.toggle('cd-sidebar-open', open);
    $('#cd-nav-toggle')?.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  $('#cd-backdrop')?.addEventListener('click', closeMobileSidebar);

  document.querySelectorAll('.cd-sidebar a.cd-navlink').forEach((a) => {
    a.addEventListener('click', () => {
      if (mq.matches) closeMobileSidebar();
    });
  });
}

function initFiltersDrawer() {
  const root = document.querySelector('.cd-filters');
  const panel = $('#cd-filters-panel');
  const btn = $('#cd-filters-toggle');
  if (!root || !btn) return;
  btn.addEventListener('click', () => {
    const open = !root.classList.contains('cd-filters--open');
    root.classList.toggle('cd-filters--open', open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  if (window.matchMedia('(max-width: 560px)').matches) {
    root.classList.remove('cd-filters--open');
    btn.setAttribute('aria-expanded', 'false');
  }
}

$('#admin-key').value = getKey();
$('#admin-key').addEventListener('input', () => {
  setKey($('#admin-key').value.trim());
  updateAvatar();
});
$('#btn-refresh').addEventListener('click', () => refresh().catch(() => {}));
$('#cd-window').addEventListener('change', () => refresh().catch(() => {}));
$('#as-of').addEventListener('change', () => refresh().catch(() => {}));
$('#cd-live-as-of')?.addEventListener('change', () => refresh().catch(() => {}));
$('#from').addEventListener('change', () => refresh().catch(() => {}));
$('#to').addEventListener('change', () => refresh().catch(() => {}));

$('#btn-toggle-raw')?.addEventListener('click', () => {
  const raw = $('#raw-out');
  if (!raw) return;
  raw.hidden = !raw.hidden;
});

initSidebar();
initFiltersDrawer();
updateAvatar();
applyIcons();
startPolling();
refresh().catch(() => {});
