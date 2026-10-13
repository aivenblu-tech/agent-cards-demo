// limits.js — demo usage caps for "Limited" mode.
//
// Limited mode:
//   1. Email gate — the first task per client is free; after that an email
//      address is required (stored on the client's profile).
//   2. Rate caps — max 3 tasks per 10 minutes and 12 per 24 hours per client.
// Unlimited mode bypasses all of the above (for the owner's own testing).
const db = require('./db');

const WINDOW_10_MIN = 10 * 60 * 1000;
const WINDOW_24_H = 24 * 60 * 60 * 1000;
const MAX_PER_10_MIN = 3;
const MAX_PER_24_H = 12;

function getUsageMode() {
  return db.getSetting('usage_mode', 'limited'); // 'limited' | 'unlimited'
}

// Returns null when the task may proceed, otherwise { http, error, detail }.
function checkLimits(profile) {
  if (getUsageMode() === 'unlimited') return null;

  const total = db.countRunsSince(profile.id, 0);
  if (total >= 1 && !profile.email) {
    return {
      http: 402,
      error: 'email_required',
      detail: 'Your first task was free — add an email address to keep using the demo agents.',
    };
  }
  const now = Date.now();
  if (db.countRunsSince(profile.id, now - WINDOW_10_MIN) >= MAX_PER_10_MIN) {
    return {
      http: 429,
      error: 'rate_limited',
      detail: `Demo limit: ${MAX_PER_10_MIN} tasks per 10 minutes. Please wait a little and try again.`,
    };
  }
  if (db.countRunsSince(profile.id, now - WINDOW_24_H) >= MAX_PER_24_H) {
    return {
      http: 429,
      error: 'daily_limited',
      detail: `Demo limit: ${MAX_PER_24_H} tasks per day. Come back tomorrow — or switch to Unlimited in Settings.`,
    };
  }
  return null;
}

module.exports = { getUsageMode, checkLimits };
