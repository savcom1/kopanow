'use strict';

const { buildFcmByBorrower, hasTrimmedFcmToken } = require('./unpaidInvoicesFcm');

const WITHOUT_FCM_CATEGORY_ORDER = [
  'admin_removed',
  'suspended',
  'withdrawn',
  'locked',
  'active_missing_token',
  'no_device_row',
];

const WITHOUT_FCM_CATEGORY_LABELS = {
  admin_removed: 'Admin removed',
  suspended: 'Suspended (DPC inactive)',
  withdrawn: 'Withdrawn',
  locked: 'Locked',
  active_missing_token: 'Active, missing token',
  no_device_row: 'No device row',
};

const WITHOUT_FCM_CATEGORY_PRIORITY = {
  admin_removed: 60,
  suspended: 50,
  withdrawn: 40,
  locked: 30,
  active_missing_token: 20,
  no_device_row: 10,
};

function trimId(value) {
  if (value == null) return '';
  return String(value).trim();
}

function summarizeBorrowerFcmCounts(borrowerIds, fcmByBorrower) {
  let withFcmTokenCount = 0;
  let withoutFcmTokenCount = 0;
  for (const bid of borrowerIds || []) {
    if (fcmByBorrower.get(bid) === true) withFcmTokenCount += 1;
    else withoutFcmTokenCount += 1;
  }
  return { with_fcm_token_count: withFcmTokenCount, without_fcm_token_count: withoutFcmTokenCount };
}

function mergeDeviceRowsByLoanId(deviceRows) {
  const byLoanId = new Map();
  for (const row of deviceRows || []) {
    const loanId = trimId(row?.loan_id);
    if (!loanId) continue;
    if (!byLoanId.has(loanId)) byLoanId.set(loanId, row);
  }
  return byLoanId;
}

function classifyLoanWithoutFcmCategory(deviceRow, loanDeviceStatus) {
  const deviceStatus = trimId(deviceRow?.status).toLowerCase();
  const loanStatus = trimId(loanDeviceStatus).toLowerCase();
  if (deviceStatus === 'admin_removed' || loanStatus === 'admin_removed') return 'admin_removed';
  if (!deviceRow) return 'no_device_row';
  if (deviceStatus === 'suspended') return 'suspended';
  if (deviceStatus === 'withdrawn') return 'withdrawn';
  if (deviceStatus === 'locked') return 'locked';
  return 'active_missing_token';
}

function classifyBorrowerWithoutFcmCategory(borrowerId, loanIds, deviceByLoanId, loanDeviceStatusByLoanId) {
  let category = 'no_device_row';
  let priority = WITHOUT_FCM_CATEGORY_PRIORITY.no_device_row;
  let deviceStatus = null;
  let loanDeviceStatus = null;
  let deviceUpdatedAt = null;
  const loanIdList = [];

  for (const loanId of loanIds || []) {
    const lid = trimId(loanId);
    if (!lid) continue;
    loanIdList.push(lid);
    const deviceRow = deviceByLoanId.get(lid);
    const loanStatus = loanDeviceStatusByLoanId.get(lid) || null;
    const loanCategory = classifyLoanWithoutFcmCategory(deviceRow, loanStatus);
    const loanPriority = WITHOUT_FCM_CATEGORY_PRIORITY[loanCategory] || 0;
    if (loanPriority > priority) {
      priority = loanPriority;
      category = loanCategory;
      deviceStatus = deviceRow ? trimId(deviceRow.status) || null : null;
      loanDeviceStatus = loanStatus || null;
      deviceUpdatedAt = deviceRow?.updated_at || null;
    }
  }

  return {
    borrower_id: borrowerId,
    loan_ids: loanIdList,
    category,
    category_label: WITHOUT_FCM_CATEGORY_LABELS[category] || category,
    device_status: deviceStatus,
    loan_device_status: loanDeviceStatus,
    device_updated_at: deviceUpdatedAt,
  };
}

function summarizeWithoutFcmReachability({
  borrowerIds,
  loanIdsByBorrower,
  fcmByBorrower,
  deviceRows,
  loanDeviceStatusByLoanId,
  reportLimit = 200,
}) {
  const deviceByLoanId = mergeDeviceRowsByLoanId(deviceRows);
  const withoutFcmByCategory = Object.fromEntries(
    WITHOUT_FCM_CATEGORY_ORDER.map((category) => [category, 0]),
  );
  const reportRows = [];

  for (const borrowerId of borrowerIds || []) {
    if (fcmByBorrower.get(borrowerId) === true) continue;
    const loanIds = [...(loanIdsByBorrower.get(borrowerId) || [])];
    const row = classifyBorrowerWithoutFcmCategory(
      borrowerId,
      loanIds,
      deviceByLoanId,
      loanDeviceStatusByLoanId || new Map(),
    );
    if (withoutFcmByCategory[row.category] != null) withoutFcmByCategory[row.category] += 1;
    else withoutFcmByCategory[row.category] = 1;
    reportRows.push(row);
  }

  reportRows.sort((a, b) => {
    const pri =
      (WITHOUT_FCM_CATEGORY_PRIORITY[b.category] || 0) -
      (WITHOUT_FCM_CATEGORY_PRIORITY[a.category] || 0);
    if (pri !== 0) return pri;
    return String(a.borrower_id).localeCompare(String(b.borrower_id));
  });

  return {
    without_fcm_by_category: withoutFcmByCategory,
    without_fcm_category_labels: WITHOUT_FCM_CATEGORY_LABELS,
    without_fcm_report: {
      borrower_count: reportRows.length,
      rows: reportRows.slice(0, Math.max(0, Number(reportLimit) || 0)),
      truncated: reportRows.length > Math.max(0, Number(reportLimit) || 0),
    },
  };
}

async function fetchCustomerDeviceRows(supabase, borrowerIds, loanIdsByBorrower, chunkSize = 150) {
  const ids = [...(borrowerIds || [])];
  if (!ids.length) return [];

  const loanToBorrowers = new Map();
  for (const [, loanIds] of loanIdsByBorrower || []) {
    for (const lid of loanIds || []) {
      if (!lid) continue;
      if (!loanToBorrowers.has(lid)) loanToBorrowers.set(lid, true);
    }
  }
  const loanIdsOnly = [...loanToBorrowers.keys()];

  const merged = new Map();
  const absorb = (rows) => {
    for (const row of rows || []) {
      const loanId = trimId(row?.loan_id);
      const borrowerId = trimId(row?.borrower_id);
      const key = loanId || (borrowerId ? `borrower:${borrowerId}` : '');
      if (!key || merged.has(key)) continue;
      merged.set(key, row);
    }
  };

  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('devices')
      .select('borrower_id, loan_id, fcm_token, status, updated_at')
      .in('borrower_id', slice);
    if (error) throw error;
    absorb(data);
  }

  for (let i = 0; i < loanIdsOnly.length; i += chunkSize) {
    const slice = loanIdsOnly.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('devices')
      .select('borrower_id, loan_id, fcm_token, status, updated_at')
      .in('loan_id', slice);
    if (error) throw error;
    absorb(data);
  }

  return [...merged.values()];
}

async function fetchFcmByBorrower(supabase, borrowerIds, loanIdsByBorrower, chunkSize = 150) {
  const deviceRows = await fetchCustomerDeviceRows(supabase, borrowerIds, loanIdsByBorrower, chunkSize);
  const ids = [...(borrowerIds || [])];
  return buildFcmByBorrower(ids, loanIdsByBorrower, deviceRows, deviceRows);
}

async function fetchLoanDeviceStatusByLoanId(supabase, loanIds, chunkSize = 150) {
  const loanDeviceStatusByLoanId = new Map();
  const ids = [...(loanIds || [])];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const slice = ids.slice(i, i + chunkSize);
    const { data, error } = await supabase
      .from('loans')
      .select('loan_id, device_status')
      .in('loan_id', slice);
    if (error) throw error;
    for (const row of data || []) {
      const loanId = trimId(row?.loan_id);
      if (!loanId) continue;
      loanDeviceStatusByLoanId.set(loanId, trimId(row?.device_status) || null);
    }
  }
  return loanDeviceStatusByLoanId;
}

async function buildCustomerFcmReachability(supabase, borrowerIds, loanIdsByBorrower, opts = {}) {
  const chunkSize = opts.chunkSize || 150;
  const reportLimit = opts.reportLimit ?? 200;
  const deviceRows = await fetchCustomerDeviceRows(supabase, borrowerIds, loanIdsByBorrower, chunkSize);
  const fcmByBorrower = buildFcmByBorrower(
    [...(borrowerIds || [])],
    loanIdsByBorrower,
    deviceRows,
    deviceRows,
  );
  const counts = summarizeBorrowerFcmCounts(borrowerIds, fcmByBorrower);
  const withoutBorrowerIds = (borrowerIds || []).filter((bid) => fcmByBorrower.get(bid) !== true);
  const withoutLoanIds = [
    ...new Set(
      withoutBorrowerIds.flatMap((bid) => [...(loanIdsByBorrower.get(bid) || [])].map(trimId).filter(Boolean)),
    ),
  ];
  const loanDeviceStatusByLoanId = withoutLoanIds.length
    ? await fetchLoanDeviceStatusByLoanId(supabase, withoutLoanIds, chunkSize)
    : new Map();
  const without = summarizeWithoutFcmReachability({
    borrowerIds,
    loanIdsByBorrower,
    fcmByBorrower,
    deviceRows,
    loanDeviceStatusByLoanId,
    reportLimit,
  });

  return {
    ...counts,
    ...without,
    fcmByBorrower,
  };
}

module.exports = {
  WITHOUT_FCM_CATEGORY_ORDER,
  WITHOUT_FCM_CATEGORY_LABELS,
  summarizeBorrowerFcmCounts,
  summarizeWithoutFcmReachability,
  classifyBorrowerWithoutFcmCategory,
  fetchCustomerDeviceRows,
  fetchFcmByBorrower,
  fetchLoanDeviceStatusByLoanId,
  buildCustomerFcmReachability,
  hasTrimmedFcmToken,
};
