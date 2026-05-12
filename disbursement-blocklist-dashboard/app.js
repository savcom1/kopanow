'use strict';

const API = '/api/accounting/disbursement-blocklist';
const KEY_STORAGE = 'kopanow_disbursement_blocklist_key';

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
  const el = $('#bl-error');
  if (!el) return;
  if (!msg) {
    el.hidden = true;
    el.textContent = '';
    return;
  }
  el.hidden = false;
  el.textContent = msg;
}

async function api(method, url, body) {
  const opts = { method, headers: headers() };
  if (body != null) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || res.statusText);
  return data;
}

function fmtIso(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString();
}

function renderPhones(entries) {
  const tbody = $('#tbl-phones tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const r of entries || []) {
    const tr = document.createElement('tr');
    const phone = r.phone_canonical != null ? String(r.phone_canonical) : '';
    tr.innerHTML =
      `<td><code>${escapeHtml(phone)}</code></td>` +
      `<td>${escapeHtml(r.note || '—')}</td>` +
      `<td>${escapeHtml(fmtIso(r.created_at))}</td>` +
      `<td><button type="button" class="bl-btn bl-btn--danger" data-remove-phone="${escapeHtml(phone)}">Remove</button></td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-remove-phone]').forEach((btn) => {
    btn.addEventListener('click', () => removePhone(btn.getAttribute('data-remove-phone')));
  });
}

function renderDevices(entries) {
  const tbody = $('#tbl-devices tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  for (const r of entries || []) {
    const tr = document.createElement('tr');
    const did = r.device_id != null ? String(r.device_id) : '';
    const imei = r.imei_canonical != null ? String(r.imei_canonical) : '';
    tr.innerHTML =
      `<td><code>${escapeHtml(did || '—')}</code></td>` +
      `<td><code>${escapeHtml(imei || '—')}</code></td>` +
      `<td>${escapeHtml(r.note || '—')}</td>` +
      `<td>${escapeHtml(fmtIso(r.created_at))}</td>` +
      `<td>${removeDeviceButtons(did, imei)}</td>`;
    tbody.appendChild(tr);
  }
  tbody.querySelectorAll('[data-remove-device]').forEach((btn) => {
    btn.addEventListener('click', () => removeDevice(btn.getAttribute('data-remove-device'), btn.getAttribute('data-remove-imei')));
  });
}

function removeDeviceButtons(did, imei) {
  const parts = [];
  if (did) {
    parts.push(
      `<button type="button" class="bl-btn bl-btn--danger" data-remove-device="${escapeHtml(did)}" data-remove-imei="">by device_id</button>`,
    );
  }
  if (imei) {
    parts.push(
      `<button type="button" class="bl-btn bl-btn--danger" data-remove-device="" data-remove-imei="${escapeHtml(imei)}">by IMEI</button>`,
    );
  }
  return parts.join(' ') || '—';
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function refresh() {
  showError('');
  try {
    const data = await api('GET', API, null);
    renderPhones(data.entries || []);
    renderDevices(data.device_entries || []);
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function removePhone(phone) {
  showError('');
  try {
    const qs = new URLSearchParams({ phone });
    await api('DELETE', `${API}?${qs.toString()}`, null);
    await refresh();
  } catch (e) {
    showError(e.message || String(e));
  }
}

async function removeDevice(did, imei) {
  showError('');
  try {
    const qs = new URLSearchParams();
    if (did) qs.set('device_id', did);
    else if (imei) qs.set('imei', imei);
    else {
      showError('Missing device_id or imei for remove.');
      return;
    }
    await api('DELETE', `${API}?${qs.toString()}`, null);
    await refresh();
  } catch (e) {
    showError(e.message || String(e));
  }
}

$('#admin-key').value = getKey();
$('#admin-key').addEventListener('input', () => setKey($('#admin-key').value.trim()));

$('#btn-refresh').addEventListener('click', () => refresh().catch((e) => showError(e.message)));

$('#btn-add-phone').addEventListener('click', async () => {
  showError('');
  const phone = $('#add-phone').value.trim();
  const note = $('#add-phone-note').value.trim();
  if (!phone) {
    showError('Enter a phone number.');
    return;
  }
  try {
    await api('POST', API, { phone, note: note || null });
    $('#add-phone').value = '';
    $('#add-phone-note').value = '';
    await refresh();
  } catch (e) {
    showError(e.message || String(e));
  }
});

$('#btn-add-device').addEventListener('click', async () => {
  showError('');
  const device_id = $('#add-device-id').value.trim();
  const imei = $('#add-imei').value.trim();
  const note = $('#add-dev-note').value.trim();
  if (!device_id && !imei) {
    showError('Enter device_id and/or IMEI.');
    return;
  }
  try {
    await api('POST', API, { device_id: device_id || undefined, imei: imei || undefined, note: note || null });
    $('#add-device-id').value = '';
    $('#add-imei').value = '';
    $('#add-dev-note').value = '';
    await refresh();
  } catch (e) {
    showError(e.message || String(e));
  }
});

refresh().catch((e) => showError(e.message));
