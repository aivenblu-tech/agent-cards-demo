// db.js — JSON file persistence (zero native dependencies, zero build step).
// The database file lives in DATA_DIR (default ./data) so it survives restarts.
// Writes are atomic (temp file + rename) and synchronous, so a crash can never
// leave a half-written database behind. Plenty for demo-scale data volumes.
//
// The exported API is storage-agnostic: server.js and limits.js don't care
// that this is JSON under the hood.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });

function blankDb() {
  return { settings: {}, profiles: {}, activations: [], task_runs: [], seq: 1 };
}

function load() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const db = JSON.parse(raw);
    // Tolerate missing keys from older files.
    return Object.assign(blankDb(), db);
  } catch (e) {
    return blankDb(); // missing or corrupt file → start fresh
  }
}

let db = load();

function save() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE); // atomic on POSIX
}

// ---- settings (single-row key/value store) ----
function getSetting(key, fallback = null) {
  return Object.prototype.hasOwnProperty.call(db.settings, key) ? db.settings[key] : fallback;
}
function setSetting(key, value) {
  db.settings[key] = String(value);
  save();
}

// ---- profiles (one per browser client id) ----
function getOrCreateProfile(id) {
  if (!db.profiles[id]) {
    db.profiles[id] = { id, email: null, created_at: Date.now() };
    save();
  }
  return db.profiles[id];
}
function setEmail(id, email) {
  const p = getOrCreateProfile(id);
  p.email = email;
  save();
}
function updateProfile(id, patch) {
  const p = getOrCreateProfile(id);
  Object.assign(p, patch);
  save();
  return p;
}

// ---- activations (card ownership binds) ----
function activateAgent(profileId, agentId) {
  const exists = db.activations.some(
    (a) => a.profile_id === profileId && a.agent_id === agentId
  );
  if (!exists) {
    db.activations.push({ id: db.seq++, profile_id: profileId, agent_id: agentId, activated_at: Date.now() });
    save();
  }
}
function getActivations(profileId) {
  return db.activations
    .filter((a) => a.profile_id === profileId)
    .sort((a, b) => a.activated_at - b.activated_at)
    .map((a) => a.agent_id);
}

// ---- task runs ----
function recordTaskRun({ profileId, agentId, message, answer, requestedProvider, actualProvider, model, routingMode }) {
  db.task_runs.push({
    id: db.seq++,
    profile_id: profileId,
    agent_id: agentId,
    message,
    answer: answer || null,
    requested_provider: requestedProvider || null,
    actual_provider: actualProvider || null,
    model: model || null,
    routing_mode: routingMode || null,
    created_at: Date.now(),
  });
  save();
}
function countRunsSince(profileId, sinceMs) {
  return db.task_runs.filter((r) => r.profile_id === profileId && r.created_at >= sinceMs).length;
}
function getTaskRuns(profileId) {
  return db.task_runs
    .filter((r) => r.profile_id === profileId)
    .sort((a, b) => b.created_at - a.created_at);
}
// ---- waitlist entries ----
function addWaitlistEntry({ email, track, note }) {
  if (!db.waitlist) db.waitlist = [];
  const existing = db.waitlist.find((w) => w.email === email);
  const row = { email, track, note: note || null, created_at: Date.now() };
  if (existing) Object.assign(existing, row);
  else db.waitlist.push(row);
  save();
}
function getHistory(profileId, agentId) {
  return db.task_runs
    .filter((r) => r.profile_id === profileId && r.agent_id === agentId && r.answer)
    .sort((a, b) => a.created_at - b.created_at)
    .slice(-50)
    .map((r) => ({
      message: r.message,
      answer: r.answer,
      requestedProvider: r.requested_provider,
      actualProvider: r.actual_provider,
      model: r.model,
      routingMode: r.routing_mode,
      createdAt: r.created_at,
    }));
}

module.exports = {
  getSetting,
  setSetting,
  getOrCreateProfile,
  setEmail,
  updateProfile,
  activateAgent,
  getActivations,
  recordTaskRun,
  countRunsSince,
  getTaskRuns,
  getHistory,
  addWaitlistEntry,
};
