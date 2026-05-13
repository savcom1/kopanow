'use strict';

/**
 * Kopanow API entry: Android app + admin/accounting UIs.
 */
require('dotenv').config();

const path = require('path');
const express = require('express');
const firebaseAdmin = require('firebase-admin');

/**
 * FCM / device commands require Firebase Admin. Set one of:
 * - FIREBASE_SERVICE_ACCOUNT_JSON — full JSON object as a string (recommended on Render)
 * - GOOGLE_APPLICATION_CREDENTIALS — path to the service account .json file (local dev)
 */
function initFirebaseAdmin() {
  if (firebaseAdmin.apps.length) return;
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (raw && String(raw).trim()) {
    try {
      const cred = JSON.parse(raw);
      firebaseAdmin.initializeApp({
        credential: firebaseAdmin.credential.cert(cred),
      });
      console.log('[firebase] Firebase Admin initialised (FIREBASE_SERVICE_ACCOUNT_JSON)');
      return;
    } catch (e) {
      console.error('[firebase] FIREBASE_SERVICE_ACCOUNT_JSON is invalid JSON:', e.message);
    }
  }
  const gac = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (gac && String(gac).trim()) {
    try {
      firebaseAdmin.initializeApp();
      console.log('[firebase] Firebase Admin initialised (GOOGLE_APPLICATION_CREDENTIALS)');
      return;
    } catch (e) {
      console.error('[firebase] GOOGLE_APPLICATION_CREDENTIALS init failed:', e.message);
    }
  }
  console.warn(
    '[firebase] Not configured — lock/unlock and other FCM device commands will fail. ' +
      'Set FIREBASE_SERVICE_ACCOUNT_JSON in Render (paste service account JSON) or GOOGLE_APPLICATION_CREDENTIALS locally.',
  );
}

initFirebaseAdmin();

const adminRouter = require('./routes/admin');
const accountingRouter = require('./routes/accounting');
const loanRouter = require('./routes/loan');
const deviceRouter = require('./routes/device');
const onboardingAssistantRouter = require('./routes/onboarding-assistant');
const paymentRefRouter = require('./routes/payment-reference');
const mpesaRouter = require('./routes/mpesa');
const pinRouter = require('./routes/pin');
const lipaIngestRouter = require('./routes/lipa-ingest');
const notifyRouter = require('./routes/notify');
const provisionRouter = require('./routes/provision');
const loanOverviewRouter = require('./routes/loanoverview');
const collectionsDashboardRouter = require('./routes/collections-dashboard');
const unpaidInvoicesDashboardRouter = require('./routes/unpaid-invoices-dashboard');
const deviceIdentifiersDashboardRouter = require('./routes/device-identifiers-dashboard');

const app = express();
app.use(express.json({ limit: '2mb' }));

// Serve favicon + PWA manifest from /public at the root path
app.use(express.static(path.join(__dirname, 'public')));

// More specific paths first — otherwise /api/admin catches nested routes.
app.use('/api/admin/collections', collectionsDashboardRouter);
app.use('/api/admin/loanoverview', loanOverviewRouter);
app.use('/api/admin/unpaid-invoices', unpaidInvoicesDashboardRouter);
app.use('/api/admin/device-identifiers', deviceIdentifiersDashboardRouter);
app.use('/api/admin', adminRouter);
app.use('/api/accounting', accountingRouter);
// Borrower loan routes are also mounted under /api/accounting/loan (canonical for the app).
// This mount keeps backward compatibility; prefer /api/accounting/loan/* for new clients.
app.use('/api/loan', loanRouter);
// More specific than `/api/device` so this path is not swallowed by the device router.
app.use('/api/device/onboarding-assistant', onboardingAssistantRouter);
app.use('/api/device', deviceRouter);
app.use('/api/payment', paymentRefRouter);
app.use('/api/mpesa', mpesaRouter);
app.use('/api/pin', pinRouter);
app.use('/api/lipa', lipaIngestRouter);
app.use('/api/notify', notifyRouter);
app.use('/api/provision', provisionRouter);

const adminStatic = path.join(__dirname, 'admin');
const accountingStatic = path.join(__dirname, 'accounting');
const loanOverviewStatic = path.join(__dirname, 'loanoverview');
const collectionsDashboardStatic = path.join(__dirname, 'collections-dashboard');
const disbursementBlocklistDashboardStatic = path.join(__dirname, 'disbursement-blocklist-dashboard');
const unpaidInvoicesDashboardStatic = path.join(__dirname, 'unpaid-invoices-dashboard');
const deviceIdentifiersDashboardStatic = path.join(__dirname, 'device-identifiers-dashboard');

app.use('/admin', express.static(adminStatic));
app.use('/accounting', express.static(accountingStatic));
app.use('/loanoverview', express.static(loanOverviewStatic));
app.use('/collections', express.static(collectionsDashboardStatic));
app.use('/disbursement-blocklist', express.static(disbursementBlocklistDashboardStatic));
app.use('/unpaid-invoices', express.static(unpaidInvoicesDashboardStatic));
app.use('/device-identifiers', express.static(deviceIdentifiersDashboardStatic));

const FAVICON_TAGS = `
  <link rel="icon" href="/favicon.ico" sizes="any"/>
  <link rel="icon" href="/favicon.svg" type="image/svg+xml"/>
  <link rel="apple-touch-icon" href="/favicon-180x180.png"/>
  <link rel="manifest" href="/site.webmanifest"/>
  <meta name="theme-color" content="#008c89"/>`;

app.get('/', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>Kopanow</title>${FAVICON_TAGS}</head>
<body style="font-family:system-ui;padding:2rem;">
  <h1>Kopanow</h1>
  <ul>
    <li><a href="/admin/">Admin (operations)</a> — devices, tamper, lipa ops</li>
    <li><a href="/accounting/">Accounting</a> — borrowers, loans, Lipa cash-in, reports</li>
    <li><a href="/loanoverview/">LoanOverview</a> — real-time KPIs (polling)</li>
    <li><a href="/collections/">Collections</a> — installments through as-of · Lipa till (polling)</li>
    <li><a href="/disbursement-blocklist/">Disbursement blocklist</a> — block phones &amp; devices from cash queue</li>
    <li><a href="/unpaid-invoices/">Unpaid invoices</a> — past-due customers · FCM reachability (polling)</li>
    <li><a href="/device-identifiers/">Device identifiers</a> — IMEI(s), serial, device_id export</li>
  </ul>
  <p>API: <code>/api/admin/*</code>, <code>/api/admin/collections/*</code>, <code>/api/accounting/*</code>, <code>/api/loan/*</code>, <code>/api/device/*</code>, …</p>
</body></html>`);
});

const port = parseInt(process.env.PORT, 10) || 3000;
const server = app.listen(port, () => {
  console.log(`[kopanow-backend] listening on http://localhost:${port}`);
});
server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(
      `[kopanow-backend] Port ${port} is already in use. Stop the other process (e.g. an older node server) ` +
        `or set a different PORT in .env, e.g. PORT=3001`,
    );
    process.exit(1);
  }
  throw err;
});
