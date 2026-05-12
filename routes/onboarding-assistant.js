'use strict';

const express = require('express');

/**
 * Future **proxied LLM** onboarding assistant (not used by the app yet).
 *
 * Intended safe JSON body (no borrower PII): `phase` (`wizard`|`registration`),
 * `step` (e.g. `BATTERY` — enum name only), `locale` (`en`|`sw`), optional `sdkInt`,
 * optional `manufacturer`. Auth: same pattern as other `/api/device/*` routes.
 *
 * Implementation sketch: validate bearer/session → call provider with a fixed system
 * prompt about Kopanow onboarding only → return `{ replyMarkdown }`. Hybrid UX on
 * Android should keep scripted [OnboardingHelpContent] as default.
 */
const router = express.Router();

router.post('/assist', (req, res) => {
  res.status(501).json({
    error: 'not_implemented',
    message:
      'LLM onboarding proxy is not enabled. The Kopanow app uses deterministic onboarding help.',
  });
});

module.exports = router;
