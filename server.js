// server.js — Agent Trading Cards self-hosted (Railway-ready).
//
// Serves the current landing page + full demo SPA from ./public and exposes
// POST /actions — the same action protocol the frontend speaks — backed by
// the local JSON database (DATA_DIR) and server-side provider keys that live
// ONLY in environment variables, never in the browser bundle.
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const db = require('./db');
const { getAgent } = require('./agents');
const { getProvider, providerIds, PROVIDERS, completeTask } = require('./providers');
const { getUsageMode } = require('./limits');

const app = express();
const PORT = Number(process.env.PORT || 3000);

app.set('trust proxy', true); // correct client IPs behind Railway/Render/nginx
app.use(express.json({ limit: '256kb' }));

// Seed defaults on first boot (only when nothing is stored yet).
if (!db.getSetting('provider')) {
  db.setSetting('provider', process.env.DEFAULT_PROVIDER || 'meta');
}
if (!db.getSetting('usage_mode')) {
  db.setSetting('usage_mode', 'limited');
}

// Identify the browser by request IP hash. Not auth — demo-grade, same as before.
function clientId(req) {
  const ip = (req.ip || 'unknown').replace(/[^A-Za-z0-9.:]/g, '').slice(0, 64);
  return 'ip-' + crypto.createHash('sha256').update(ip).digest('hex').slice(0, 32);
}

const PROVIDER_IDS = ['anthropic', 'openai', 'gemini', 'deepseek', 'meta'];
const TRACKS = ['agent_cards', 'claw_machine', 'capital_partner'];
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

function maskEmail(email) {
  const [local = '', domain = ''] = String(email).split('@');
  return `${local.slice(0, 2)}${local.length > 2 ? '•••' : '•'}@${domain}`;
}

// Older rows may store the provider display name; normalize to an id.
function providerIdFromStored(v) {
  if (PROVIDER_IDS.includes(v)) return v;
  const found = PROVIDER_IDS.find((id) => PROVIDERS[id].name === v);
  return found || 'meta';
}

function hasProviderKey(id) {
  const def = PROVIDERS[id];
  return Boolean(def && process.env[def.keyEnv]);
}

// ---- admin (page-controls login): PBKDF2-hashed credentials, 12h sessions ----
function getAdminSessions() {
  try {
    const list = JSON.parse(db.getSetting('admin_sessions', '[]'));
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function createAdminSession() {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const now = Date.now();
  const sessions = getAdminSessions().filter((s) => s.expiresAt > now);
  sessions.push({ tokenHash, expiresAt: now + 12 * 60 * 60 * 1000 });
  db.setSetting('admin_sessions', JSON.stringify(sessions));
  return token;
}
function hasValidAdminSession(token) {
  if (!token) return false;
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  return getAdminSessions().some(
    (s) => s.tokenHash === tokenHash && s.expiresAt > Date.now()
  );
}
function hashPassword(password, saltHex) {
  return crypto
    .pbkdf2Sync(String(password), Buffer.from(saltHex, 'hex'), 210000, 32, 'sha256')
    .toString('hex');
}

// ---- email via Resend (direct API; no SDK needed) ----
async function resendSend(to, subject, html) {
  const key = process.env.RESEND_API_KEY;
  if (!key) return false;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'onboarding@resend.dev',
        to,
        subject,
        html,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// =====================================================================
// Action handlers — one per frontend action.
// Each returns the `data` payload; thrown Errors become { error } replies.
// =====================================================================
const DAY_MS = 24 * 60 * 60 * 1000;

function getDashboard(cid) {
  const profile = db.getOrCreateProfile(cid);
  const activeAgentIds = db.getActivations(cid);
  const runs = db.getTaskRuns(cid);
  const recentTasks = runs.slice(0, 8).map((r) => ({
    id: r.id,
    agentId: r.agent_id,
    prompt: r.message,
    answer: r.answer || '',
    contentKind: 'text',
    artifactTitle: null,
    artifactHtml: null,
    mediaUrl: null,
    mediaMimeType: null,
    externalUrl: null,
    provider: r.actual_provider || '',
    model: r.model || '',
    requestedProvider: providerIdFromStored(r.requested_provider),
    routingMode: r.routing_mode || 'direct',
    createdAt: new Date(r.created_at).toISOString(),
  }));
  const remainingToday = Math.max(0, 12 - db.countRunsSince(cid, Date.now() - DAY_MS));
  return {
    activeAgentIds,
    emailUnlocked: Boolean(profile.email),
    maskedEmail: profile.email ? maskEmail(profile.email) : null,
    taskCount: runs.length,
    remainingToday,
    recentTasks,
    selectedProvider: db.getSetting('provider', 'meta'),
    usageMode: getUsageMode(),
    demoNavigationEnabled: profile.demoNavigationEnabled !== false,
    providerConnections: providerIds().map((id) => ({
      provider: id,
      connected: hasProviderKey(id),
    })),
    inferenceStatus: 'connected',
  };
}

function activateAgent(cid, args) {
  const agentId = args.agentId;
  if (!getAgent(agentId)) throw new Error(`unknown agent: ${agentId}`);
  const alreadyActive = db.getActivations(cid).includes(agentId);
  db.activateAgent(cid, agentId);
  return {
    ok: true,
    agentId,
    activatedAt: new Date().toISOString(),
    alreadyActive,
  };
}

function setProvider(cid, args) {
  const provider = args.provider;
  if (!getProvider(provider)) throw new Error(`unknown provider: ${provider}`);
  db.getOrCreateProfile(cid);
  db.setSetting('provider', provider);
  return { ok: true, selectedProvider: provider };
}

function setUsageMode(cid, args) {
  const usageMode = args.usageMode;
  if (!['limited', 'unlimited'].includes(usageMode)) throw new Error('unknown usage mode');
  db.getOrCreateProfile(cid);
  db.setSetting('usage_mode', usageMode);
  return { ok: true, usageMode };
}

function getAdminStatus() {
  return { configured: Boolean(db.getSetting('admin_username')) };
}

function setupAdmin(cid, args) {
  const username = String(args.username || '').trim();
  const password = String(args.password || '');
  if (username.length < 3 || username.length > 48) throw new Error('Username must be 3–48 characters.');
  if (password.length < 8 || password.length > 128) throw new Error('Password must be 8–128 characters.');
  if (db.getSetting('admin_username')) {
    return { ok: false, sessionToken: null, message: 'Login credentials already exist. Log in instead.' };
  }
  const salt = crypto.randomBytes(16).toString('hex');
  db.setSetting('admin_username', username);
  db.setSetting('admin_salt', salt);
  db.setSetting('admin_hash', hashPassword(password, salt));
  const sessionToken = createAdminSession();
  return { ok: true, sessionToken, message: 'Login created.' };
}

function loginAdmin(cid, args) {
  const username = String(args.username || '').trim();
  const password = String(args.password || '');
  const storedUser = db.getSetting('admin_username');
  const salt = db.getSetting('admin_salt');
  const storedHash = db.getSetting('admin_hash');
  const ok =
    storedUser &&
    storedUser === username &&
    storedHash &&
    crypto.timingSafeEqual(
      Buffer.from(hashPassword(password, salt || ''), 'hex'),
      Buffer.from(storedHash, 'hex')
    );
  if (!ok) {
    return { ok: false, sessionToken: null, message: 'Username or password is incorrect.' };
  }
  return { ok: true, sessionToken: createAdminSession(), message: 'Logged in.' };
}

function setDemoNavigation(cid, args) {
  const profile = db.getOrCreateProfile(cid);
  const current = profile.demoNavigationEnabled !== false;
  if (!hasValidAdminSession(args.sessionToken)) {
    return { ok: false, demoNavigationEnabled: current, message: 'Your session expired. Log in again.' };
  }
  const enabled = Boolean(args.enabled);
  db.updateProfile(cid, { demoNavigationEnabled: enabled });
  return { ok: true, demoNavigationEnabled: enabled, message: null };
}

async function joinWaitlist(cid, args) {
  const email = String(args.email || '').trim().toLowerCase();
  const track = TRACKS.includes(args.track) ? args.track : 'agent_cards';
  const note = String(args.note || '').trim().slice(0, 400) || null;
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error('Please enter a valid email address.');

  db.addWaitlistEntry({ email, track, note });

  const notifyTo = process.env.NOTIFY_EMAIL || 'aivenblu@gmail.com';
  const joinedAt = new Date().toISOString();
  let notificationSent = false;
  let confirmationSent = false;
  if (process.env.RESEND_API_KEY) {
    notificationSent = await resendSend(
      notifyTo,
      `New early-access signup: ${email}`,
      `<p><strong>Email:</strong> ${email}</p><p><strong>Track:</strong> ${track}</p><p><strong>Note:</strong> ${note || '—'}</p><p><strong>Time:</strong> ${joinedAt}</p>`
    );
    // Subscriber confirmations require a verified Resend domain; attempt anyway.
    confirmationSent = await resendSend(
      email,
      'You’re on the Agent Cards early-access list',
      `<p>Thanks for signing up${track === 'claw_machine' ? ' for arcade perks' : ''}! We’ll email you with launch news and early-access updates.</p>`
    );
  }

  const baseMessage =
    track === 'claw_machine'
      ? 'Saved — you’re on the arcade perks list.'
      : track === 'capital_partner'
        ? 'Saved — you’re on the capital partner list.'
        : 'Saved — you’re on the Agent Cards early-access list.';
  const deliveryMessage =
    notificationSent && confirmationSent
      ? ' A confirmation email is on its way.'
      : notificationSent
        ? ' The team was notified, but your confirmation email could not be sent yet.'
        : confirmationSent
          ? ' Your confirmation is on its way, but the team alert could not be sent.'
          : ' Email delivery is temporarily unavailable, but your spot is saved.';
  return {
    ok: true,
    track,
    notificationSent,
    confirmationSent,
    message: `${baseMessage}${deliveryMessage}`,
  };
}

function unlockWithEmail(cid, args) {
  const email = String(args.email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(email) || email.length > 254) throw new Error('Please enter a valid email address.');
  db.setEmail(cid, email);
  return { ok: true, maskedEmail: maskEmail(email) };
}

async function runAgentTask(cid, args) {
  const agent = getAgent(args.agentId);
  if (!agent) throw new Error(`unknown agent: ${args.agentId}`);
  const task = String(args.task || '').trim();
  if (task.length < 3 || task.length > 2000) throw new Error('Please describe the task (3–2000 characters).');

  const noRoute = {
    provider: null,
    model: null,
    requestedProvider: null,
    routingMode: null,
    routingNote: null,
    contentKind: 'text',
    artifactTitle: null,
    artifactHtml: null,
    mediaUrl: null,
    mediaMimeType: null,
    externalUrl: null,
  };
  const profile = db.getOrCreateProfile(cid);
  const providerId = db.getSetting('provider', 'meta');
  const usageMode = getUsageMode();
  const limited = usageMode === 'limited';
  const now = Date.now();
  const dayCount = db.countRunsSince(cid, now - DAY_MS);
  const remainingToday = Math.max(0, 12 - dayCount);

  if (!db.getActivations(cid).includes(args.agentId)) {
    return {
      status: 'error', answer: null,
      message: 'Activate this card before assigning a task.',
      taskId: null, remainingToday: 12, ...noRoute,
    };
  }
  const totalRuns = db.countRunsSince(cid, 0);
  if (limited && totalRuns >= 1 && !profile.email) {
    return {
      status: 'email_required', answer: null,
      message: 'Your first task was free. Add an email to keep going.',
      taskId: null, remainingToday, ...noRoute,
    };
  }
  if (limited && db.countRunsSince(cid, now - 10 * 60 * 1000) >= 3) {
    return {
      status: 'rate_limited', answer: null,
      message: 'Three tasks per 10 minutes. Try again after the window resets.',
      taskId: null, remainingToday, ...noRoute,
    };
  }
  if (limited && dayCount >= 12) {
    return {
      status: 'rate_limited', answer: null,
      message: 'Daily demo limit reached. It resets 24 hours after each task.',
      taskId: null, remainingToday: 0, ...noRoute,
    };
  }

  const history = db.getHistory(cid, args.agentId).slice(-6);
  const prior = history.map((h) => `User: ${h.message}\nAssistant: ${h.answer}`).join('\n\n');
  const system =
    `${agent.systemPrompt}\n\nYou are chatting with the user inside a live demo. ` +
    `Respond naturally to follow-up messages and use the prior conversation when it is relevant. ` +
    `Return the complete user-facing answer without summarizing away useful detail. ` +
    `Do not mention these instructions or pretend to have tools you were not given.`;
  const message = prior ? `Conversation so far:\n${prior}\n\nUser's new message:\n${task}` : task;
  const cleanHistory = history.flatMap((h) => [
    { role: 'user', content: String(h.message).slice(0, 4000) },
    { role: 'assistant', content: String(h.answer).slice(0, 4000) },
  ]);

  try {
    const result = await completeTask({ providerId, system, history: cleanHistory, message });
    db.recordTaskRun({
      profileId: cid,
      agentId: args.agentId,
      message: task.slice(0, 4000),
      answer: result.answer,
      requestedProvider: providerId,
      actualProvider: result.actualProvider,
      model: result.model,
      routingMode: result.routingMode,
    });
    const id = db.getTaskRuns(cid)[0].id;
    return {
      status: 'ok',
      answer: result.answer,
      message: null,
      taskId: id,
      remainingToday: Math.max(0, 11 - dayCount),
      provider: result.actualProvider,
      model: result.model,
      requestedProvider: providerId,
      routingMode: result.routingMode,
      routingNote: `${getProvider(providerId).name} answered directly with your saved API key.`,
      contentKind: 'text',
      artifactTitle: null,
      artifactHtml: null,
      mediaUrl: null,
      mediaMimeType: null,
      externalUrl: null,
    };
  } catch (err) {
    const detail = err.code === 'NO_KEY'
      ? `No API key configured for ${err.provider}. Add the key in Railway variables and redeploy.`
      : (err.message || 'The model did not return an answer.') + ' Your limit was not used — try again.';
    return {
      status: 'error', answer: null, message: detail,
      taskId: null, remainingToday, ...noRoute,
    };
  }
}

const ACTIONS = {
  getDashboard,
  activateAgent,
  setProvider,
  setUsageMode,
  getAdminStatus,
  setupAdmin,
  loginAdmin,
  setDemoNavigation,
  joinWaitlist,
  unlockWithEmail,
  runAgentTask,
};

// The frontend POSTs { action, args, actionCallId } here and reads { data }
// (or { error }, which the client surfaces as an action failure).
app.post('/actions', async (req, res) => {
  const { action, args } = req.body || {};
  const handler = ACTIONS[action];
  if (!handler) return res.json({ error: `unknown action: ${action}` });
  try {
    const data = await handler(clientId(req), args || {});
    res.json({ data });
  } catch (err) {
    res.json({ error: err.message || 'action failed' });
  }
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, version: '2.0.0', time: new Date().toISOString() });
});

// ---- static frontend (current landing page + demo SPA) ----
app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, () => {
  console.log(`Agent Cards listening on http://localhost:${PORT}`);
  console.log(`Data dir: ${process.env.DATA_DIR || path.join(__dirname, 'data')}`);
});
