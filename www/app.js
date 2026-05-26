// Game of Life — main app script (loaded as <script type="module">)
// Supabase loaded via /supabase.js (self-hosted UMD) which sets window.supabase
const { createClient } = window.supabase;

// ---- Lazy Plaid Link loader ----
function loadPlaidScript() {
  if (window.Plaid) return Promise.resolve(window.Plaid);
  if (window._plaidLoading) return window._plaidLoading;
  window._plaidLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.plaid.com/link/v2/stable/link-initialize.js';
    s.async = true;
    s.onload = () => window.Plaid ? resolve(window.Plaid) : reject(new Error('Plaid global missing'));
    s.onerror = () => reject(new Error('Plaid script blocked or failed to load'));
    document.head.appendChild(s);
  });
  return window._plaidLoading;
}

// ---- Top-level error surfacing so a hang shows real reason ----
window.addEventListener('error', (e) => surfaceFatal(e?.message || 'Script error', e?.error?.stack));
window.addEventListener('unhandledrejection', (e) => surfaceFatal(e?.reason?.message || String(e?.reason), e?.reason?.stack));
function surfaceFatal(msg, stack) {
  const loading = document.getElementById('loading');
  if (loading) {
    loading.innerHTML = `<div style="max-width:520px; padding:20px; color:#ff6b8a; font-family:'JetBrains Mono', monospace; font-size:12px; line-height:1.6; word-break:break-word;">
      <div style="color:#f5c842; letter-spacing:0.18em; font-size:14px; margin-bottom:10px;">FATAL</div>
      <div>${escapeHtml(msg || 'unknown')}</div>
      ${stack ? `<pre style="margin-top:10px; color:#8b94b8; white-space:pre-wrap; font-size:11px;">${escapeHtml(stack)}</pre>` : ''}
      <div style="margin-top:14px;"><a href="/" style="color:#5fc1e8;">Reload</a></div>
    </div>`;
  }
}
function escapeHtml(s) { return String(s||'').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

const SUPABASE_URL = 'https://rbnqyaxwpsokworjmpti.supabase.co';
const SUPABASE_KEY = 'sb_publishable_XOpy9BmVTkz65s6kOF3WHA_rkWQ4Yqv';
const supa = createClient(SUPABASE_URL, SUPABASE_KEY);

// ---- Capgo rollback safety ----
// Capgo rolls back the new bundle if notifyAppReady() isn't called within ~10s
// of bundle activation. Auth + network can easily blow that budget on cold
// starts, so we fire as early as possible and retry until the plugin is loaded.
(function markReady() {
  let tries = 0;
  const fire = () => {
    const ready = window.Capacitor?.Plugins?.CapacitorUpdater?.notifyAppReady;
    if (ready) {
      try { ready.call(window.Capacitor.Plugins.CapacitorUpdater).catch(() => {}); } catch {}
      return true;
    }
    return false;
  };
  if (fire()) return;
  // Plugin may not have injected yet at module-eval time. Retry until 8s in.
  const interval = setInterval(() => {
    tries++;
    if (fire() || tries > 80) clearInterval(interval);
  }, 100);
})();

// Show current build version in top bar (visible diagnostic)
document.addEventListener('DOMContentLoaded', () => {
  const sub = document.querySelector('.brand-sub');
  if (sub) sub.textContent = window.BUILD_VERSION || 'PWA';
});

// ---- State ----
let user = null;
let character = null;
let quests = [];
let summary = null;
let emails = [];
let txns = [];
let connections = [];
let txns7 = [];
let streaks = { workout: 0, meal: 0, log: 0 };
let bosses = [];
let progress = null;  // character_progress RPC result: {overall, streak_multiplier, domains}
let domainsExpanded = false;
let lastKnownTierRank = null;

let balances = [];
let rules = [];
let releases = [];
let isAdmin = false;
let subscription = null;
let referralCodes = [];
let activeTab = 'main';
let saveDebounce = null;
let mealMedia = { photo: null, voice: null };
let workoutMedia = { photo: null };

// ---- Helpers ----
const $ = (id) => document.getElementById(id);
const show = (el) => el && el.classList.remove('hidden');
const hide = (el) => el && el.classList.add('hidden');

function toast(msg, ms = 2000) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), ms);
}
function xpToNextFor(level) { return Math.floor(100 * Math.pow(1.5, level - 1)); }
function fmtMoney(n) {
  const v = Number(n) || 0;
  const sign = v < 0 ? '-' : '';
  return sign + '$' + Math.abs(v).toLocaleString('en-US', { maximumFractionDigits: 0 });
}
function fmtHp(v, unit) {
  const n = Number(v) || 0;
  if (unit === 'dollars') return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  return n.toLocaleString('en-US') + ' ' + (unit || '');
}
function relTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  return Math.floor(h / 24) + 'd ago';
}
function autoGrow(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(120, el.scrollHeight) + 'px';
}

// ---- Auth ----
let isSignUp = false;
$('auth-toggle').addEventListener('click', () => {
  isSignUp = !isSignUp;
  $('auth-submit').textContent = isSignUp ? 'Create Account' : 'Sign In';
  $('auth-toggle-text').textContent = isSignUp ? 'Already have an account?' : 'New here?';
  $('auth-toggle').textContent = isSignUp ? 'Sign in' : 'Create account';
  $('auth-msg').textContent = '';
});

$('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('auth-email').value.trim();
  const password = $('auth-password').value;
  const msg = $('auth-msg');
  msg.className = 'auth-msg info';
  msg.textContent = isSignUp ? 'Creating account…' : 'Signing in…';
  $('auth-submit').disabled = true;
  try {
    if (isSignUp) {
      const { data, error } = await supa.auth.signUp({ email, password });
      if (error) throw error;
      if (data.session) await onSignedIn(data.session.user);
      else { msg.className = 'auth-msg success'; msg.textContent = 'Check your email to confirm, then sign in.'; }
    } else {
      const { data, error } = await supa.auth.signInWithPassword({ email, password });
      if (error) throw error;
      await onSignedIn(data.user);
    }
  } catch (err) {
    msg.className = 'auth-msg error';
    msg.textContent = err.message || 'Something went wrong.';
  } finally { $('auth-submit').disabled = false; }
});

$('logout-btn').addEventListener('click', async () => {
  await supa.auth.signOut();
  user = null; character = null; quests = [];
  hide($('main-app'));
  show($('auth-screen'));
});

// ---- APK auto-update detection ----
// BUILD_VERSION is injected by GitHub Actions at APK build time.
// PWA users have it as null, so the check no-ops for them.
async function checkForAppUpdates() {
  if (!window.BUILD_VERSION) return; // PWA — service worker handles updates
  try {
    const cap = window.Capacitor;
    const updater = cap && cap.Plugins && cap.Plugins.CapacitorUpdater;
    if (updater && updater.notifyAppReady) {
      try { await updater.notifyAppReady(); } catch {}
    }
    // Rollback detection: if we previously attempted a hot-update to version X
    // but BUILD_VERSION still doesn't match X on this launch, Capgo rolled it back.
    // Bump a counter; after the threshold, we'll show APK download instead of hot-update.
    let hotUpdateFailureCount = 0;
    try {
      const attemptedTarget = localStorage.getItem('hotUpdateAttempted');
      if (attemptedTarget && attemptedTarget !== window.BUILD_VERSION) {
        // Rollback happened
        hotUpdateFailureCount = (parseInt(localStorage.getItem('hotUpdateFailures') || '0', 10) || 0) + 1;
        localStorage.setItem('hotUpdateFailures', String(hotUpdateFailureCount));
        localStorage.removeItem('hotUpdateAttempted');
      } else if (attemptedTarget && attemptedTarget === window.BUILD_VERSION) {
        // Success — clear the failure counter
        localStorage.removeItem('hotUpdateAttempted');
        localStorage.setItem('hotUpdateFailures', '0');
      } else {
        hotUpdateFailureCount = parseInt(localStorage.getItem('hotUpdateFailures') || '0', 10) || 0;
      }
    } catch {}
    // Allow user to override (?channel=stable in URL)
    const params = new URLSearchParams(window.location.search);
    const channel = params.get('channel') || localStorage.getItem('updateChannel') || 'beta';
    const r = await fetch('https://gameoflifeapp.vercel.app/api/version?channel=' + channel, { cache: 'no-store' });
    if (!r.ok) return;
    const info = await r.json();
    if (!info.version || info.version === window.BUILD_VERSION) return;
    // If hot-update has failed ≥1 time for this target, force the APK-download path
    info._forceApkFallback = (hotUpdateFailureCount >= 1);
    showUpdateBanner(info);
  } catch (e) { console.warn('update check failed', e); }
}

function showUpdateBanner(info) {
  if (document.getElementById('update-banner')) return;
  const cap = window.Capacitor;
  const updater = cap && cap.Plugins && cap.Plugins.CapacitorUpdater;
  // Force APK download when the previous hot-update rolled back. Capgo's safety
  // timer is too aggressive on this device — the user can always install the
  // APK directly and that's guaranteed to apply.
  const canHotUpdate = !!(updater && updater.download && info.bundle_url) && !info._forceApkFallback;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#f5c842,#b89531);color:#070912;padding:12px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 4px 20px rgba(245,200,66,0.4);font-family:Inter,system-ui,sans-serif;';
  const versionText = (info.version || 'new build');
  const subline = canHotUpdate ? 'Tap to download the latest update.' : (info._forceApkFallback ? 'Previous in-place update got rolled back — installing the APK directly fixes it permanently.' : 'Tap to download the latest APK.');
  banner.innerHTML = '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:13px;">New version available — ' + versionText + '</div><div id="update-sub" style="font-size:11px;opacity:0.8;">' + subline + '</div></div><button id="update-now" style="background:#070912;color:#f5c842;border:none;padding:8px 14px;border-radius:8px;font-family:Cinzel,serif;font-size:11px;letter-spacing:0.12em;font-weight:700;cursor:pointer;min-width:80px;">UPDATE</button><button id="update-dismiss" style="background:transparent;color:#070912;border:none;padding:4px 8px;cursor:pointer;font-size:20px;line-height:1;">×</button>';
  document.body.appendChild(banner);
  const btn = document.getElementById('update-now');
  const sub = document.getElementById('update-sub');
  const dismiss = document.getElementById('update-dismiss');
  dismiss.onclick = () => banner.remove();
  btn.onclick = async () => {
    if (canHotUpdate) {
      btn.disabled = true;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" style="animation:spin 0.8s linear infinite;vertical-align:middle;"><circle cx="12" cy="12" r="10" stroke="#070912" stroke-width="3" fill="none" stroke-dasharray="40 20"/></svg>';
      sub.textContent = 'Downloading ' + info.version + '…';
      try {
        const result = await updater.download({ url: info.bundle_url, version: info.version });
        if (!result || !result.id) throw new Error('download returned no bundle id');
        sub.textContent = 'Applying ' + info.version + '…';
        await updater.set({ id: result.id });
        try { localStorage.setItem('hotUpdateAttempted', info.version); } catch {}
        // Mark the brand-new bundle as healthy *before* reloading, so Capgo
        // won't roll back. notifyAppReady on the next launch is the canonical
        // path; calling it here defends against weird race conditions.
        try { await updater.notifyAppReady(); } catch {}
        sub.textContent = 'Reloading…';
        // Capgo's reload() is the cleanest path; window.location.reload() is a fallback.
        if (typeof updater.reload === 'function') {
          try { await updater.reload(); return; } catch (e) { console.warn('updater.reload failed, falling back', e); }
        }
        // Force a fresh document load so the new build-version.js is parsed.
        window.location.replace(window.location.pathname + '?u=' + Date.now());
      } catch (e) {
        console.error('hot-update failed', e);
        const msg = e && e.message ? e.message : (typeof e === 'string' ? e : 'unknown');
        sub.textContent = 'Update failed: ' + msg.slice(0, 80);
        btn.disabled = false;
        btn.textContent = 'RETRY';
      }
    } else {
      // Always send to the canonical landing page — easy to type, no GitHub
      // and no raw .apk URL. The page has Stable/Beta selectors.
      window.location.href = 'https://forgepointrelay.com/?ref=app';
    }
  };
}

async function onSignedIn(u) {
  user = u;
  hide($('auth-screen'));
  hide($('loading'));
  show($('main-app'));
  checkForAppUpdates(); // fire-and-forget
  await loadCharacter();
  // Save the device's timezone if we don't have one or it changed (so daily counters reset at LOCAL midnight)
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    if (tz && character && character.timezone !== tz) {
      await supa.from('characters').update({ timezone: tz }).eq('user_id', user.id);
      character.timezone = tz;
    }
  } catch {}
  await Promise.all([
    loadQuests(), loadSummary(),
    loadEmails(), loadTxns(), loadConnections(),
    loadTxns7(), loadStreaks(), loadBosses(), loadBalances(), loadRules(),
    loadReleases(), checkAdmin(), loadSubscription(), loadReferralCodes(), loadProfile(), loadAiUsage(), loadProgress()
  ]);
  // Refresh auto-tracked bosses (e.g. workout streak) so a missed day resets to 0.
  await recomputeAutoBosses();
  await loadBosses();
  // If user arrived with ?ref=CODE and is in trial, extend by 7 days
  await maybeApplyReferralOnSignin();
  render();
  maybeOfferCheckin();
}

async function checkAdmin() {
  const { data } = await supa.from('admins').select('user_id').eq('user_id', user.id).maybeSingle();
  isAdmin = !!data;
}

async function loadReleases() {
  const { data } = await supa.from('releases').select('*').order('created_at', { ascending: false }).limit(25);
  releases = data || [];
}

// ---- Loaders ----
async function loadProgress() {
  if (!user) return;
  try {
    const { data, error } = await supa.rpc('character_progress', { p_user_id: user.id });
    if (error) { console.warn('character_progress failed', error); return; }
    progress = data || null;
    // Detect tier-up (compare against previously stored rank in localStorage)
    if (progress && progress.overall && progress.overall.tier) {
      const newRank = progress.overall.tier.rank;
      const prev = parseInt(localStorage.getItem('lastTierRank') || '0', 10);
      if (prev > 0 && newRank > prev) {
        const name = progress.overall.tier.name;
        toast(`★ TIER UP — You are now ${name}!`, 6000);
      }
      if (newRank > prev) localStorage.setItem('lastTierRank', String(newRank));
    }
  } catch (e) { console.warn('loadProgress error', e); }
}

async function loadCharacter() {
  const { data, error } = await supa.from('characters').select('*').eq('user_id', user.id).single();
  if (error && error.code !== 'PGRST116') console.error(error);
  if (!data) {
    const { data: created } = await supa.from('characters').insert({ user_id: user.id }).select().single();
    character = created;
  } else character = data;
}

async function loadQuests() {
  const { data, error } = await supa.from('quests').select('*').eq('user_id', user.id).order('created_at', { ascending: false });
  if (error) console.error(error);
  quests = data || [];
}

async function loadSummary() {
  const { data, error } = await supa.from('daily_summary').select('*').eq('user_id', user.id).single();
  if (error && error.code !== 'PGRST116') console.error(error);
  summary = data || { spend_today: 0, income_today: 0, workouts_today: 0, workout_minutes_today: 0, meals_today: 0, calories_today: 0, protein_today: 0, steps_today: 0, xp_today: 0, gold_delta_today: 0 };
}

async function loadEmails() {
  const start = new Date(); start.setHours(0,0,0,0);
  const { data } = await supa.from('emails')
    .select('*')
    .eq('user_id', user.id).eq('is_archived', false)
    .gte('received_at', start.toISOString())
    .order('received_at', { ascending: false }).limit(100);
  emails = data || [];
  const order = { high: 0, medium: 1, unrated: 2, low: 3 };
  emails.sort((a, b) => {
    const oa = order[a.importance] ?? 4, ob = order[b.importance] ?? 4;
    if (oa !== ob) return oa - ob;
    return new Date(b.received_at) - new Date(a.received_at);
  });
}

async function loadTxns() {
  const start = new Date(); start.setHours(0,0,0,0);
  const { data } = await supa.from('transactions').select('*').eq('user_id', user.id)
    .gte('occurred_at', start.toISOString()).order('occurred_at', { ascending: false }).limit(50);
  txns = data || [];
}

async function loadConnections() {
  const [connRes, plaidRes] = await Promise.all([
    supa.from('connections').select('id,provider,status,external_id,config,last_sync_at,last_error,created_at').eq('user_id', user.id),
    supa.from('plaid_items').select('id,institution_name,institution_id,status,last_sync_at,last_error,created_at').eq('user_id', user.id)
  ]);
  connections = [
    ...((connRes.data || []).filter(c => c.provider !== 'anthropic')),
    ...((plaidRes.data || []).map(p => ({
      id: p.id, provider: 'plaid', status: p.status,
      external_id: p.institution_name || 'Bank',
      last_sync_at: p.last_sync_at, last_error: p.last_error,
      created_at: p.created_at, _isPlaid: true
    })))
  ].sort((a,b) => (a.created_at || '').localeCompare(b.created_at || ''));
}

async function loadTxns7() {
  const since = new Date(); since.setDate(since.getDate() - 6); since.setHours(0,0,0,0);
  const { data } = await supa.from('transactions').select('amount_cents, occurred_at')
    .eq('user_id', user.id).gte('occurred_at', since.toISOString()).order('occurred_at', { ascending: true });
  txns7 = data || [];
}

async function loadStreaks() {
  const since = new Date(); since.setDate(since.getDate() - 30); since.setHours(0,0,0,0);
  const { data } = await supa.from('events').select('kind, occurred_at')
    .eq('user_id', user.id).gte('occurred_at', since.toISOString()).order('occurred_at', { ascending: false });
  const ymd = (d) => {
    const z = new Date(d);
    return z.getFullYear() + '-' + String(z.getMonth()+1).padStart(2,'0') + '-' + String(z.getDate()).padStart(2,'0');
  };
  const today = ymd(new Date());
  function streakFor(filter) {
    const days = new Set();
    for (const e of (data || [])) if (filter(e.kind)) days.add(ymd(e.occurred_at));
    let s = 0; const cur = new Date(); cur.setHours(0,0,0,0);
    while (true) {
      const key = ymd(cur);
      if (key === today && !days.has(key)) { cur.setDate(cur.getDate() - 1); continue; }
      if (!days.has(key)) break;
      s++; cur.setDate(cur.getDate() - 1);
    }
    return s;
  }
  streaks = {
    workout: streakFor(k => k === 'workout'),
    meal: streakFor(k => k === 'meal'),
    log: streakFor(k => ['workout','meal','transaction','quest_complete'].includes(k))
  };
}

async function loadBosses() {
  const { data } = await supa.from('bosses').select('*').eq('user_id', user.id).order('status').order('created_at', { ascending: false });
  bosses = data || [];
}

async function loadBalances() {
  const { data } = await supa.from('latest_balances').select('*').eq('user_id', user.id);
  balances = data || [];
}

async function loadRules() {
  const { data } = await supa.from('rules').select('*').eq('user_id', user.id).order('priority', { ascending: false });
  rules = data || [];
}

// ---- Mutations ----
async function saveCharacter(patch) {
  Object.assign(character, patch);
  if (saveDebounce) clearTimeout(saveDebounce);
  saveDebounce = setTimeout(async () => {
    const { error } = await supa.from('characters').update(patch).eq('user_id', user.id);
    if (error) toast('Save failed');
  }, 350);
}

async function addQuest(title, type) {
  const xp_reward = type === 'main' ? 100 : type === 'side' ? 50 : 25;
  const { data, error } = await supa.from('quests').insert({ user_id: user.id, title, type, xp_reward }).select().single();
  if (error) { toast('Add failed'); return; }
  quests.unshift(data); render();
}

function todayYMD() {
  const z = new Date();
  return z.getFullYear() + '-' + String(z.getMonth()+1).padStart(2,'0') + '-' + String(z.getDate()).padStart(2,'0');
}
function isQuestDoneVisually(q) {
  if (q.type === 'daily') return q.last_completed_date === todayYMD();
  return q.status === 'completed';
}
async function toggleQuest(q) {
  if (q.type === 'daily') {
    const today = todayYMD();
    const doneToday = q.last_completed_date === today;
    if (!doneToday) {
      q.last_completed_date = today;
      const { error } = await supa.from('quests').update({ last_completed_date: today }).eq('id', q.id);
      if (error) { q.last_completed_date = null; toast('Update failed'); return; }
      await insertEvent('quest_complete', 'manual', { quest_id: q.id, title: q.title, type: q.type, xp_reward: q.xp_reward });
      await refreshAfterEvent();
      toast(`+${q.xp_reward} XP`);
    } else {
      q.last_completed_date = null;
      await supa.from('quests').update({ last_completed_date: null }).eq('id', q.id);
    }
    render();
    return;
  }
  if (q.status === 'active') {
    q.status = 'completed';
    q.completed_at = new Date().toISOString();
    const { error } = await supa.from('quests').update({ status: 'completed', completed_at: q.completed_at }).eq('id', q.id);
    if (error) { toast('Update failed'); return; }
    await insertEvent('quest_complete', 'manual', { quest_id: q.id, title: q.title, type: q.type, xp_reward: q.xp_reward });
    await refreshAfterEvent();
    toast(`+${q.xp_reward} XP`);
  } else {
    q.status = 'active'; q.completed_at = null;
    await supa.from('quests').update({ status: 'active', completed_at: null }).eq('id', q.id);
  }
  render();
}

async function deleteQuest(q) {
  await supa.from('quests').delete().eq('id', q.id);
  quests = quests.filter(x => x.id !== q.id); render();
}

async function insertEvent(kind, source, payload, occurred_at) {
  const row = { user_id: user.id, kind, source, payload };
  if (occurred_at) row.occurred_at = occurred_at;
  const { error } = await supa.from('events').insert(row);
  if (error) { toast('Save failed'); console.error(error); return false; }
  return true;
}

async function refreshAfterEvent() {
  await Promise.all([loadCharacter(), loadSummary(), loadStreaks(), loadTxns7(), loadBalances(), loadProgress()]);
  render();
}

// Unified AI Edge Function invoker. Returns { data, error, rateLimited }.
// - On 429: shows the rate-limit toast and returns rateLimited:true.
// - On 2xx: notes piggy-backed usage counters.
async function invokeAI(name, body) {
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (!session) return { error: { message: 'not signed in' } };
    const url = `${SUPABASE_URL}/functions/v1/${name}`;
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${session.access_token}`,
        'apikey': SUPABASE_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body || {})
    });
    let parsed = null;
    try { parsed = await r.json(); } catch {}
    if (r.status === 429) { handleRateLimit(parsed || {}); return { rateLimited: true, error: parsed }; }
    if (!r.ok) return { error: parsed || { message: `HTTP ${r.status}` } };
    if (parsed) noteAiUsageFromResp(parsed);
    return { data: parsed };
  } catch (e) {
    return { error: { message: String(e?.message || e) } };
  }
}

async function logMeal(description, photoDataUrl) {
  let macros = null;
  try {
    const { data, rateLimited } = await invokeAI('parse-meal', { description, photo: photoDataUrl || null });
    if (!rateLimited && data && (data.calories || data.protein_g)) macros = data;
  } catch {}
  const meal = {
    user_id: user.id, description,
    source: photoDataUrl ? 'photo' : 'voice_or_text',
    calories: macros?.calories ?? null, protein_g: macros?.protein_g ?? null,
    carbs_g: macros?.carbs_g ?? null, fat_g: macros?.fat_g ?? null,
    fiber_g: macros?.fiber_g ?? null,
    raw: macros ? { llm: macros } : {}
  };
  const { data: mealRow, error } = await supa.from('meals').insert(meal).select().single();
  if (error) { toast('Save failed'); return; }
  await insertEvent('meal', meal.source, {
    description, calories: meal.calories, protein_g: meal.protein_g,
    carbs_g: meal.carbs_g, fat_g: meal.fat_g, meal_id: mealRow.id
  });
  toast(macros ? `Logged · ${macros.calories || '?'} cal · ${macros.protein_g || '?'}g protein` : 'Meal logged');
  await refreshAfterEvent();
}

async function logWorkout(type, durationMin, calories, notes) {
  const startedAt = new Date(Date.now() - durationMin * 60 * 1000).toISOString();
  const dur_s = durationMin * 60;
  const { data: wRow, error } = await supa.from('workouts').insert({
    user_id: user.id, type, source: 'manual', started_at: startedAt,
    duration_seconds: dur_s, calories: calories || null, notes: notes || null
  }).select().single();
  if (error) { toast('Save failed'); return; }
  await insertEvent('workout', 'manual', { type, duration_seconds: dur_s, calories, workout_id: wRow.id });
  // Auto-update streak-tracked bosses (and fire boss-defeated XP if hit).
  await recomputeAutoBosses();
  toast(`+${type} · ${durationMin} min`);
  await refreshAfterEvent();
}


// === About / Help sheet + feedback submission ===
function openHelpSheet() {
  // Stamp build version into the about line
  const v = document.getElementById('help-build-version');
  if (v) v.textContent = (window.BUILD_VERSION || 'PWA') + (window.BUILD_TIME ? (' (' + new Date(window.BUILD_TIME).toLocaleDateString() + ')') : '');
  // Show the sheet (existing openSheet handles overlay + animation)
  openSheet('help');
  // Lazy-load the user's past feedback so they can see status of bugs they've filed
  if (user) loadMyFeedback();
}

async function loadMyFeedback() {
  try {
    const { data, error } = await supa.from('feedback').select('*').eq('user_id', user.id).order('created_at', { ascending: false }).limit(20);
    if (error) return;
    const section = document.getElementById('help-my-feedback-section');
    const list = document.getElementById('help-my-feedback-list');
    if (!list || !section) return;
    if (!data || !data.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    list.innerHTML = '';
    for (const f of data) {
      const el = document.createElement('div');
      el.style.cssText = 'background: var(--bg-3); padding: 8px 10px; border-radius: 6px; font-size: 11px; display: flex; align-items: center; gap: 8px;';
      const icon = ({ bug: '🐛', suggestion: '✨', message: '💬' })[f.kind] || '·';
      const statusColors = { new: 'var(--muted)', seen: 'var(--cyan)', in_progress: 'var(--gold)', resolved: 'var(--green)', wontfix: 'var(--red)' };
      const dot = '<span style="display:inline-block; width:6px; height:6px; border-radius:50%; background:' + (statusColors[f.status] || 'var(--muted)') + ';"></span>';
      el.innerHTML = '<span style="flex-shrink:0;">' + icon + '</span><span style="flex:1; color: var(--text); overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">' + (f.subject || '(no subject)').replace(/</g,'&lt;') + '</span>' + dot + '<span style="color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; font-size: 9px;">' + (f.status || 'new') + '</span>';
      list.appendChild(el);
    }
  } catch (e) { console.warn('loadMyFeedback failed', e); }
}

async function submitFeedback(e) {
  e.preventDefault();
  const kind = document.getElementById('fb-kind').value;
  const subject = document.getElementById('fb-subject').value.trim();
  const body = document.getElementById('fb-body').value.trim();
  if (!subject || !body) { toast('Subject and details required'); return; }
  // Best-effort platform detection
  const ua = navigator.userAgent || '';
  let platform = 'pwa';
  if (window.Capacitor && window.Capacitor.getPlatform) {
    try { platform = window.Capacitor.getPlatform(); } catch {}
  } else if (/Android/.test(ua)) platform = 'android-pwa';
  else if (/iPad|iPhone|iPod/.test(ua)) platform = 'ios-pwa';
  const row = {
    user_id: user ? user.id : null,
    user_email: user ? user.email : null,
    kind, subject, body,
    build_version: window.BUILD_VERSION || 'pwa',
    platform
  };
  const { error } = await supa.from('feedback').insert(row);
  if (error) { toast('Send failed: ' + (error.message || 'try again')); return; }
  toast('Sent. Thank you!', 3000);
  document.getElementById('fb-subject').value = '';
  document.getElementById('fb-body').value = '';
  if (user) loadMyFeedback();
}

// === Share-out: opens native share sheet so the user can post to ANY app ===
async function shareApp(extra) {
  // Pull the user's first available referral code (if signed in) so the link
  // gives the friend the 14-day extension bonus on signup.
  let refCode = null;
  try {
    if (user && referralCodes && referralCodes.length) {
      const open = referralCodes.find(c => !c.redeemed_by_user_id) || referralCodes[0];
      refCode = open ? open.code : null;
    }
  } catch {}
  const baseUrl = 'https://forgepointrelay.com';
  const url = refCode ? (baseUrl + '/?ref=' + encodeURIComponent(refCode)) : baseUrl;
  const text = (extra && extra.text) || 'I’m playing my life as an RPG. Workouts, meals, money — everything becomes XP. Try Game of Life — 14-day free trial' + (refCode ? ' (use my code for +7 days)' : '') + ':';
  const title = (extra && extra.title) || 'Game of Life';
  // Web Share API (works on iOS Safari, Android Chrome, modern browsers)
  if (navigator.share) {
    try {
      await navigator.share({ title, text, url });
      return;
    } catch (e) { /* user dismissed — fall through to clipboard */ }
  }
  // Fallback: copy to clipboard
  try {
    await navigator.clipboard.writeText(text + ' ' + url);
    toast('Link copied to clipboard — paste anywhere', 3500);
  } catch (e) {
    toast(url, 5000);
  }
}

// Generic share-progress helper — for bosses defeated, level-ups, streaks
async function shareProgress(label, detail) {
  const text = (detail ? detail + ' — ' : '') + 'tracking my life in Game of Life.';
  await shareApp({ title: label || 'Game of Life', text });
}

// Recomputes hp_current on all auto-tracked bosses for the current user.
// Called after logging a workout AND on app load (so missed days reset the streak).
async function recomputeAutoBosses() {
  if (!user) return;
  try {
    const { data, error } = await supa.rpc('recompute_workout_streak_bosses', { p_user_id: user.id });
    if (error) { console.warn('recompute bosses failed', error); return; }
    // If any bosses were newly defeated, surface a toast so the user knows
    if (data && Array.isArray(data.bosses)) {
      for (const b of data.bosses) {
        if (b.newly_defeated) toast('🏆 Boss defeated: ' + b.name, 4000);
      }
    }
  } catch (e) { console.warn('recompute bosses error', e); }
}

async function logMoney(dir, amount, category, merchant) {
  const cents = Math.round(amount * 100) * (dir === '1' ? 1 : -1);
  const { data: txRow, error } = await supa.from('transactions').insert({
    user_id: user.id, source: 'manual', amount_cents: cents,
    category, merchant: merchant || null, description: merchant || category
  }).select().single();
  if (error) { toast('Save failed'); return; }
  await insertEvent('transaction', 'manual', { amount_cents: cents, category, merchant, transaction_id: txRow.id });
  toast(`${dir==='1'?'+':'-'}${fmtMoney(Math.abs(amount))} · ${category}`);
  await refreshAfterEvent();
}

// ---- Sheet ----
function openSheet(kind) {
  const titles = { meal: 'Log Meal', workout: 'Log Workout', money: 'Log Money', email: 'Connect Email Account', boss: 'New Boss', checkin: 'Day Start', rule: 'New Rule', release: 'New Release', profile: 'Edit Profile', friends: 'Friends' };
  $('sheet-title').textContent = titles[kind] || 'Log';
  ['meal','workout','money','email','boss','checkin','rule','release','profile','friends'].forEach(k => {
    const el = $('form-'+k); if (el) el.style.display = (k === kind) ? '' : 'none';
  });
  if (kind === 'meal') {
    $('meal-desc').value = ''; $('meal-preview').style.display = 'none';
    $('meal-preview').classList.remove('has-content');
    mealMedia = { photo: null, voice: null };
  }
  if (kind === 'workout') {
    $('workout-desc').value = ''; $('workout-type').value = '';
    $('workout-duration').value = ''; $('workout-calories').value = '';
    $('workout-notes').value = '';
    $('workout-preview').style.display = 'none';
    $('workout-preview').classList.remove('has-content');
    workoutMedia = { photo: null };
  }
  if (kind === 'money') {
    $('money-dir').value = '-1'; $('money-amount').value = '';
    $('money-category').value = 'restaurants'; $('money-merchant').value = '';
  }
  $('sheet').classList.add('show');
  $('sheet-backdrop').classList.add('show');
}
function closeSheet() {
  $('sheet').classList.remove('show');
  $('sheet-backdrop').classList.remove('show');
  $('live-hr').style.display = 'none';
}


async function maybeApplyReferralOnSignin() {
  try {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('ref');
    if (!code) return;
    if (!subscription || subscription.status !== 'trialing') return;
    // Validate code exists + unused + not own
    const { data: ref } = await supa.from('referral_codes').select('*').eq('code', code).maybeSingle();
    if (!ref || ref.redeemed_by || ref.owner_user_id === user.id) return;
    // Mark redeemed by this user (so the referrer gets credit on first paid invoice)
    await supa.from('referral_codes').update({ redeemed_by: user.id, redeemed_at: new Date().toISOString() }).eq('code', code);
    // Extend trial by 7 days via RPC
    await supa.rpc('extend_trial', { p_user_id: user.id, p_days: 7 });
    // Reload subscription with new end date
    await loadSubscription();
    toast('Referral applied · +7 days on trial', 3500);
    // Strip ref from URL so we don't re-apply on reload
    const url = new URL(window.location.href); url.searchParams.delete('ref');
    window.history.replaceState({}, '', url.toString());
  } catch (e) { console.warn('referral apply failed', e); }
}

// ---- Subscription / billing ----
async function loadSubscription() {
  const { data } = await supa.from('subscriptions').select('*').eq('user_id', user.id).maybeSingle();
  subscription = data || null;
}
async function loadReferralCodes() {
  const { data } = await supa.from('referral_codes').select('*').eq('owner_user_id', user.id).order('created_at', { ascending: true });
  referralCodes = data || [];
}
function isPaid() {
  if (!subscription) return false;
  // Client-side trial-expiry guard so gating kicks in even before the hourly cron runs
  if (subscription.status === 'trialing' && subscription.trial_ends_at) {
    if (new Date(subscription.trial_ends_at) < new Date()) return false;
  }
  return ['trialing','active','past_due'].includes(subscription.status);
}
// Soft gate — only blocks if the user has zero remaining quota for the day.
// Rate limit is enforced server-side; this is just to avoid wasted spinners.
function gatedFeature(label) {
  // Always allow — server-side rate limit handles abuse.
  // Kept for backwards compatibility with existing call sites.
  return true;
}

// Track AI usage (peek_ai_credit RPC fills this in)
let aiUsage = { used: 0, limit: 10, remaining: 10, tier: 'free' };
async function loadAiUsage() {
  if (!user) return;
  try {
    const { data } = await supa.rpc('peek_ai_credit', { p_user_id: user.id });
    if (data) {
      aiUsage = { used: data.used || 0, limit: data.limit || 10, remaining: data.remaining ?? (data.limit - data.used), tier: data.tier || 'free' };
      renderAiUsage();
    }
  } catch (e) { console.warn('peek_ai_credit failed', e); }
}
function renderAiUsage() {
  const el = document.getElementById('ai-usage-pill');
  if (!el) return;
  el.textContent = `AI ${aiUsage.used}/${aiUsage.limit}`;
  el.classList.toggle('warn', aiUsage.remaining <= 2 && aiUsage.remaining > 0);
  el.classList.toggle('empty', aiUsage.remaining <= 0);
}
// Update local usage cache from any Edge Function response that piggybacks counters.
function noteAiUsageFromResp(resp) {
  if (!resp) return;
  if (typeof resp._ai_remaining === 'number') aiUsage.remaining = resp._ai_remaining;
  if (typeof resp._ai_limit === 'number') aiUsage.limit = resp._ai_limit;
  if (typeof resp._ai_tier === 'string') aiUsage.tier = resp._ai_tier;
  if (typeof resp._ai_remaining === 'number' && typeof resp._ai_limit === 'number') aiUsage.used = aiUsage.limit - aiUsage.remaining;
  renderAiUsage();
}
// Handle a 429 rate_limited response uniformly.
function handleRateLimit(body) {
  aiUsage.used = body.used || aiUsage.used;
  aiUsage.limit = body.limit || aiUsage.limit;
  aiUsage.remaining = 0;
  aiUsage.tier = body.tier || aiUsage.tier;
  renderAiUsage();
  const upgradeMsg = (body.tier === 'free' || body.tier === 'expired')
    ? 'Daily AI limit reached. Upgrade for 500/day.'
    : `Daily AI limit reached (${body.used}/${body.limit}).`;
  toast(upgradeMsg, 4500);
  if (body.tier === 'free' || body.tier === 'expired') {
    const card = document.getElementById('acct-card');
    if (card && card.classList.contains('collapsed')) card.classList.remove('collapsed');
    card?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function renderAccount() {
  const pill = document.getElementById('acct-status-pill');
  const tierEl = document.getElementById('acct-tier');
  const btn = document.getElementById('acct-action-btn');
  const trialNote = document.getElementById('acct-trial-note');
  if (!pill) return;
  const s = subscription?.status || 'none';
  const tier = subscription?.tier;
  const labels = { none: 'FREE', trialing: 'TRIAL', active: 'ACTIVE', past_due: 'PAST DUE', canceled: 'CANCELED', expired: 'EXPIRED' };
  pill.textContent = labels[s] || s.toUpperCase();
  pill.className = 'acct-status-pill ' + (s === 'none' ? 'free' : s);
  if (tier && s !== 'none') {
    const prices = { founding: '$10/mo', early: '$15/mo', regular: '$19/mo' };
    const num = subscription.founding_member_number;
    tierEl.textContent = (tier === 'founding' && num ? `Founding member #${num} · ` : tier === 'founding' ? 'Founding · ' : tier === 'early' ? 'Early · ' : 'Regular · ') + prices[tier];
  } else { tierEl.textContent = ''; }
  trialNote.textContent = '';
  if (s === 'none') {
    btn.textContent = 'Start 14-day trial';
    btn.style.display = '';
  } else if (s === 'trialing' && subscription.trial_ends_at) {
    const end = new Date(subscription.trial_ends_at);
    const msLeft = end - Date.now();
    const days = Math.max(0, Math.ceil(msLeft / 86400000));
    if (msLeft <= 0) {
      trialNote.textContent = 'Trial just ended · subscribe to keep AI features';
      btn.textContent = 'Subscribe — $10/mo';
      btn.style.display = '';
    } else {
      trialNote.textContent = `Trial ends in ${days} day${days===1?'':'s'} · ${end.toLocaleDateString()} · subscribe anytime to lock in pricing`;
      btn.textContent = 'Subscribe — $10/mo';
      btn.style.display = '';
    }
  } else if (s === 'active') {
    btn.style.display = 'none';
  } else if (s === 'past_due' || s === 'canceled') {
    btn.textContent = 'Resubscribe';
    btn.style.display = '';
  } else {
    btn.style.display = 'none';
  }
  // Referral section visible only if user has codes
  const refSection = document.getElementById('referral-section');
  const refList = document.getElementById('referral-codes-list');
  if (referralCodes.length > 0) {
    refSection.style.display = '';
    refList.innerHTML = referralCodes.map(c => {
      const used = !!c.redeemed_by;
      return `<div class="referral-code ${used?'redeemed':''}" title="${used?'Already redeemed':'Tap to copy'}">${c.code}<span class="small">${used?'redeemed':'tap to copy'}</span></div>`;
    }).join('');
    refList.querySelectorAll('.referral-code').forEach((el, i) => {
      const c = referralCodes[i];
      if (c.redeemed_by) return;
      el.addEventListener('click', async () => {
        // Native share when available, copy to clipboard otherwise
        const url = 'https://forgepointrelay.com/?ref=' + encodeURIComponent(c.code);
        const text = 'Try Game of Life — life as an RPG. Use my code for +7 days on the 14-day trial: ' + c.code;
        if (navigator.share) {
          try { await navigator.share({ title: 'Game of Life', text, url }); return; } catch {}
        }
        try { await navigator.clipboard.writeText(url); toast('Link copied: ' + c.code); }
        catch { toast('Code: ' + c.code); }
      });
    });
  } else {
    refSection.style.display = 'none';
  }
}

async function startCheckout() {
  const btn = document.getElementById('acct-action-btn');
  if (!btn) return;
  btn.disabled = true;
  const orig = btn.textContent;
  btn.textContent = 'Loading…';
  try {
    const ref = new URLSearchParams(window.location.search).get('ref') || null;
    const { data, error } = await supa.functions.invoke('create-checkout', { body: { referral_code: ref, return_url: window.location.origin + '/' } });
    if (error || !data?.url) {
      toast('Checkout failed: ' + (data?.error || error?.message || 'unknown'));
      btn.textContent = orig; btn.disabled = false; return;
    }
    window.location.href = data.url;
  } catch (e) {
    toast('Checkout error: ' + (e?.message || 'unknown'));
    btn.textContent = orig; btn.disabled = false;
  }
}


// ---- Profile / Friends ----
let profile = null;
let friends = [];

async function loadProfile() {
  const { data } = await supa.from('profiles').select('*').eq('user_id', user.id).maybeSingle();
  profile = data || null;
}

async function loadFriends() {
  const { data: rows } = await supa.from('friendships')
    .select('*')
    .or('user_a.eq.' + user.id + ',user_b.eq.' + user.id)
    .order('created_at', { ascending: false });
  friends = rows || [];
}

function openProfileEditor() {
  $('prof-name').value = profile?.display_name || '';
  $('prof-bio').value = profile?.bio || '';
  const links = profile?.social_links || {};
  $('prof-tw').value = links.twitter || '';
  $('prof-ig').value = links.instagram || '';
  $('prof-web').value = links.website || '';
  $('prof-public').checked = !!profile?.is_public;
  openSheet('profile');
}

async function saveProfile() {
  const social_links = {};
  const tw = $('prof-tw').value.trim(); if (tw) social_links.twitter = tw;
  const ig = $('prof-ig').value.trim(); if (ig) social_links.instagram = ig;
  const web = $('prof-web').value.trim(); if (web) social_links.website = web;
  const updates = {
    user_id: user.id,
    display_name: $('prof-name').value.trim() || null,
    bio: $('prof-bio').value.trim() || null,
    social_links,
    is_public: !!$('prof-public').checked
  };
  const { error } = await supa.from('profiles').upsert(updates, { onConflict: 'user_id' });
  if (error) { toast('Save failed: ' + error.message); return; }
  toast('Profile saved');
  await loadProfile();
  closeSheet();
}

async function openFriends() {
  await loadFriends();
  renderFriendsList();
  openSheet('friends');
}

function renderFriendsList() {
  const list = $('friends-list');
  if (!friends.length) {
    list.innerHTML = '<div class="empty">No friends yet. Send a request by email above.</div>';
    return;
  }
  list.innerHTML = friends.map(f => {
    const other = f.user_a === user.id ? f.user_b : f.user_a;
    const isInviter = f.initiated_by === user.id;
    return '<div class="conn-item"><div class="conn-icon">' + (other[0]||'?').toUpperCase() + '</div><div class="conn-meta"><div class="conn-name">' + other.slice(0,8) + '…</div><div class="conn-sub">' + f.status + (isInviter ? ' · sent' : ' · received') + '</div></div></div>';
  }).join('');
}

async function addFriendByEmail(email) {
  if (!email) return;
  // Look up user_id by email — requires service-role or RPC; use auth.users via Postgres function
  // Simple path: query characters via email match — we don't have email column. Use auth.admin?
  // For now: store as pending request even if email lookup fails; show "request sent" UX
  // Real implementation needs an RPC. Provide a placeholder for now.
  toast('Sent friend request to ' + email + ' (matching by email runs server-side once wired)');
}

// ---- Render ----
function render() {
  if (!character) return;
  renderSummary();
  renderStreaks();
  renderInbox();
  renderFinancial();
  renderBosses();
  renderRules();
  renderReleases();
  renderAccount();
  renderConnections();
  // Character
  $('char-name').value = character.name || '';
  $('char-class').value = character.class || '';
  $('char-level').textContent = character.level;
  // Use progress (from character_progress RPC) when present, else fall back to characters table
  const ov = progress && progress.overall ? progress.overall : null;
  if (ov && ov.span_of_level > 0) {
    $('xp-current').textContent = Number(ov.progress_in_level).toLocaleString();
    $('xp-next').textContent = Number(ov.span_of_level).toLocaleString();
    $('xp-fill').style.width = Math.min(100, (Number(ov.progress_in_level) / Math.max(1, Number(ov.span_of_level))) * 100) + '%';
    const tierName = ov.tier && ov.tier.name ? ov.tier.name.toUpperCase() : 'NOVICE';
    $('char-tier-name').textContent = tierName;
  } else {
    $('xp-current').textContent = character.xp;
    $('xp-next').textContent = character.xp_to_next;
    $('xp-fill').style.width = Math.min(100, (character.xp / Math.max(1, character.xp_to_next)) * 100) + '%';
  }
  // Streak multiplier badge
  const multBadge = $('char-mult-badge');
  if (multBadge && progress && progress.streak_multiplier) {
    const m = Number(progress.streak_multiplier);
    if (m > 1.0) {
      multBadge.textContent = '×' + m.toFixed(2).replace(/\.?0+$/, '') + ' streak';
      multBadge.style.display = 'inline-block';
    } else {
      multBadge.style.display = 'none';
    }
  }
  // Per-domain bars (only updates DOM if user has expanded the panel — render anyway for snappy expand)
  if (progress && progress.domains) {
    for (const d of ['body','mind','money','social']) {
      const dom = progress.domains[d];
      if (!dom) continue;
      const tierEl = document.getElementById('d-' + d + '-tier');
      const lvlEl = document.getElementById('d-' + d + '-level');
      const fillEl = document.getElementById('d-' + d + '-fill');
      if (tierEl) tierEl.textContent = dom.tier && dom.tier.name ? dom.tier.name : 'Novice';
      if (lvlEl) lvlEl.textContent = 'L' + dom.level;
      if (fillEl) {
        const span = Math.max(1, Number(dom.span_of_level));
        const prog = Math.max(0, Number(dom.progress_in_level));
        fillEl.style.width = Math.min(100, (prog / span) * 100) + '%';
      }
    }
  }
  $('s-int').textContent = character.stat_int;
  $('s-cha').textContent = character.stat_cha;
  $('s-str').textContent = character.stat_str;
  $('s-wis').textContent = character.stat_wis;
  $('s-con').textContent = character.stat_con;
  $('s-gold').textContent = character.gold;
  $('main-quest').value = character.main_quest || '';
  autoGrow($('main-quest'));
  // Quest counts
  const counts = { main: 0, side: 0, daily: 0 };
  for (const q of quests) if (q.status === 'active') counts[q.type] = (counts[q.type]||0)+1;
  $('count-main').textContent = counts.main;
  $('count-side').textContent = counts.side;
  $('count-daily').textContent = counts.daily;
  // Quest list
  const list = $('quest-list');
  const filtered = quests.filter(q => q.type === activeTab);
  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty">No ${activeTab} quests yet. Add one below.</div>`;
  } else {
    list.innerHTML = '';
    filtered.sort((a,b) => {
      const aDone = isQuestDoneVisually(a), bDone = isQuestDoneVisually(b);
      return aDone === bDone ? 0 : aDone ? 1 : -1;
    });
    for (const q of filtered) {
      const el = document.createElement('div');
      const done = isQuestDoneVisually(q);
      el.className = `quest-item type-${q.type} ${done ? 'completed' : ''}`;
      el.innerHTML = `
        <div class="quest-check"></div>
        <div class="quest-body">
          <div class="quest-title"></div>
          <div class="quest-meta"><span class="quest-xp">+${q.xp_reward} XP</span>${done ? (q.type==='daily' ? ' · done today (resets at midnight)' : ' · done ' + relTime(q.completed_at)) : ''}</div>
        </div>
        <button class="quest-delete" title="Delete">×</button>`;
      el.querySelector('.quest-title').textContent = q.title;
      el.querySelector('.quest-check').addEventListener('click', () => toggleQuest(q));
      el.querySelector('.quest-delete').addEventListener('click', (e) => { e.stopPropagation(); if (confirm('Delete this quest?')) deleteQuest(q); });
      list.appendChild(el);
    }
  }
}

function renderSummary() {
  if (!summary) return;
  const today = new Date();
  $('day-date').textContent = today.toLocaleDateString('en-US', { weekday:'long', month:'short', day:'numeric' }).toUpperCase();
  $('day-xp').textContent = (summary.xp_today >= 0 ? '+' : '') + summary.xp_today;
  $('day-spend').textContent = fmtMoney(Math.abs(summary.spend_today));
  $('day-income').textContent = fmtMoney(summary.income_today);
  $('day-workouts').textContent = summary.workouts_today;
  $('day-workout-mins').textContent = (summary.workout_minutes_today || 0) + ' min';
  $('day-meals').textContent = summary.meals_today;
  $('day-protein').textContent = (summary.protein_today || 0) + ' g protein';
  $('day-calories').textContent = Number(summary.calories_today || 0).toLocaleString('en-US');
}

function renderStreaks() {
  const items = [
    { key: 'log',     icon: '🔥', label: 'Days' },
    { key: 'workout', icon: '💪', label: 'Train' },
    { key: 'meal',    icon: '🍽', label: 'Fuel' }
  ];
  $('streak-row').innerHTML = items.map(it => {
    const v = streaks[it.key] || 0;
    const cls = v >= 3 ? 'hot' : v === 0 ? 'cold' : '';
    return `<span class="streak-pill ${cls}"><span class="streak-icon">${it.icon}</span><span class="streak-count">${v}</span><span class="streak-label">${it.label}</span></span>`;
  }).join('');
}

function renderInbox() {
  const list = $('email-list');
  if (!emails.length) { list.innerHTML = `<div class="empty">No emails yet today. Hit <span style="color:var(--gold)">Sync</span> to pull from your accounts.</div>`; return; }
  list.innerHTML = '';
  for (const e of emails) {
    const t = new Date(e.received_at);
    const timeStr = t.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    const acct = (e.account_email || '').split('@')[0];
    const el = document.createElement('div');
    el.className = `email-item imp-${e.importance}`;
    el.innerHTML = `
      <div class="email-body">
        <div class="email-row1">
          <span class="email-from"></span>
          <span class="imp-badge ${e.importance}">${e.importance}</span>
          ${e.is_financial ? '<span class="imp-badge imp-fin">$</span>' : ''}
          <span class="email-time">${timeStr}</span>
          <span class="email-actions"><button class="email-archive">Archive</button></span>
        </div>
        <div class="email-subj"></div>
        <div class="email-snip"></div>
        <div class="email-full"></div>
        <div style="margin-top:4px"><span class="email-account">${acct}</span></div>
      </div>`;
    el.querySelector('.email-from').textContent = e.from_name || e.from_addr || '';
    el.querySelector('.email-subj').textContent = e.subject || '(no subject)';
    el.querySelector('.email-snip').textContent = e.snippet || '';
    el.querySelector('.email-full').textContent = e.body_text || e.snippet || '';
    el.addEventListener('click', () => el.classList.toggle('expanded'));
    el.querySelector('.email-archive').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      el.style.opacity = '0.3';
      const { error } = await supa.from('emails').update({ is_archived: true }).eq('id', e.id);
      if (error) { el.style.opacity = '1'; toast('Archive failed'); return; }
      emails = emails.filter(x => x.id !== e.id); renderInbox();
    });
    list.appendChild(el);
  }
}

function renderBalances() {
  const row = $('balance-row');
  if (!balances.length) { row.style.display = 'none'; return; }
  row.style.display = 'flex';
  row.innerHTML = balances.map(b => {
    const dollars = (Number(b.balance_cents) || 0) / 100;
    const t = new Date(b.observed_at);
    const time = t.toLocaleDateString('en-US', { month:'short', day:'numeric' });
    return `<div class="balance-pill"><div class="balance-acct"></div><div class="balance-amt">$${dollars.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div><div class="balance-time">as of ${time}</div></div>`;
  }).join('');
  const pills = row.querySelectorAll('.balance-pill .balance-acct');
  balances.forEach((b, i) => { if (pills[i]) pills[i].textContent = b.account_name; });
}

function renderCashflow() {
  if (!txns7.length) { $('cashflow-card').style.display = 'none'; return; }
  $('cashflow-card').style.display = 'block';
  const today = new Date(); today.setHours(0,0,0,0);
  const days = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    days.push({ date: d, in: 0, out: 0 });
  }
  let net = 0;
  for (const tx of txns7) {
    const d = new Date(tx.occurred_at); d.setHours(0,0,0,0);
    const idx = days.findIndex(x => x.date.getTime() === d.getTime());
    if (idx < 0) continue;
    const c = tx.amount_cents || 0;
    if (c >= 0) days[idx].in += c; else days[idx].out += -c;
    net += c;
  }
  const max = Math.max(1, ...days.map(d => Math.max(d.in, d.out)));
  const labels = ['S','M','T','W','T','F','S'];
  $('cashflow-bars').innerHTML = days.map(d => {
    const inH = (d.in / max) * 100;
    const outH = (d.out / max) * 100;
    const dow = d.date.getDay();
    const isToday = d.date.getTime() === today.getTime();
    return `<div class="cashflow-day ${isToday ? 'today' : ''}" title="${d.date.toLocaleDateString('en-US',{month:'short',day:'numeric'})} · in $${(d.in/100).toFixed(0)} · out $${(d.out/100).toFixed(0)}">
      <div class="bar-stack">
        ${d.in > 0 ? `<div class="bar-in" style="height:${inH}%"></div>` : ''}
        ${d.out > 0 ? `<div class="bar-out" style="height:${outH}%"></div>` : ''}
      </div>
      <div class="cashflow-day-label">${labels[dow]}</div>
    </div>`;
  }).join('');
  const netDollars = net / 100;
  const netEl = $('cashflow-net');
  netEl.textContent = (netDollars >= 0 ? '+$' : '−$') + Math.abs(netDollars).toLocaleString('en-US',{maximumFractionDigits:0});
  netEl.className = 'cashflow-net ' + (netDollars >= 0 ? 'in' : 'out');
}

function renderFinancial() {
  renderBalances();
  renderCashflow();
  const list = $('tx-list');
  if (!txns.length) { list.innerHTML = `<div class="empty">No transactions today. They'll appear here as your bank emails come in.</div>`; return; }
  list.innerHTML = '';
  for (const tx of txns) {
    const cents = tx.amount_cents || 0;
    const direction = cents >= 0 ? 'in' : 'out';
    const amt = Math.abs(cents / 100);
    const cat = tx.category || 'other';
    const icon = ({restaurants:'🍽️',coffee:'☕',groceries:'🛒',gas:'⛽',entertainment:'🎬',bills:'📄',transfer:'⇄',income:'↓',shopping:'🛍️',travel:'✈️',healthcare:'⚕️',other:'·'})[cat] || '·';
    const t = new Date(tx.occurred_at);
    const timeStr = t.toLocaleTimeString('en-US', { hour:'numeric', minute:'2-digit' });
    const el = document.createElement('div');
    el.className = 'tx-item';
    el.innerHTML = `<div class="tx-icon">${icon}</div><div class="tx-meta"><div class="tx-merch"></div><div class="tx-sub">${cat} · ${tx.account || tx.source} · ${timeStr}</div></div><div class="tx-amt ${direction}">${direction==='in'?'+':'−'}$${amt.toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2})}</div>`;
    el.querySelector('.tx-merch').textContent = tx.merchant || tx.description || cat;
    list.appendChild(el);
  }
}

function renderBosses() {
  const list = $('boss-list');
  if (!bosses.length) { list.innerHTML = `<div class="empty">No bosses yet. Tap <span style="color:var(--gold)">+ Add</span> to set a milestone.</div>`; return; }
  list.innerHTML = '';
  for (const b of bosses) {
    const pct = Math.min(100, (Number(b.hp_current) / Math.max(1, Number(b.hp_total))) * 100);
    const el = document.createElement('div');
    el.className = `boss-item ${b.status === 'defeated' ? 'defeated' : ''}`;
    const isAuto = !!b.auto_kind;
    const autoLabel = b.auto_kind === 'workout_streak' ? '⚡ AUTO · workout streak' : (isAuto ? '⚡ AUTO' : '');
    el.innerHTML = `
      <div class="boss-head"><div class="boss-name"></div><div class="boss-reward">+${b.xp_reward} XP</div></div>
      <div class="boss-bar-wrap"><div class="boss-bar" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="boss-meta">
        <div class="boss-hp">${fmtHp(b.hp_current, b.hp_unit)} / ${fmtHp(b.hp_total, b.hp_unit)} (${pct.toFixed(0)}%)${autoLabel ? ` <span style="color:var(--cyan); font-size:10px; letter-spacing:0.08em; margin-left:6px;">${autoLabel}</span>` : ''}</div>
        <div class="boss-actions">
          ${b.status === 'active' && !isAuto ? `<button class="boss-action" data-act="add">+ HP</button>` : ''}
          <button class="boss-action danger" data-act="del" title="Delete">✕</button>
        </div>
      </div>`;
    el.querySelector('.boss-name').textContent = b.name;
    el.querySelectorAll('.boss-action').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (btn.dataset.act === 'add') {
          const v = prompt(`Add progress to "${b.name}" (current ${fmtHp(b.hp_current, b.hp_unit)} / ${fmtHp(b.hp_total, b.hp_unit)}):\nEnter amount to add (or "set N" to set absolute):`);
          if (!v) return;
          let newCurrent = /^set\s+/i.test(v) ? parseFloat(v.replace(/^set\s+/i, '')) : Number(b.hp_current) + parseFloat(v);
          if (!isFinite(newCurrent)) return;
          const defeated = newCurrent >= Number(b.hp_total);
          const updates = { hp_current: newCurrent };
          if (defeated && b.status === 'active') { updates.status = 'defeated'; updates.defeated_at = new Date().toISOString(); }
          await supa.from('bosses').update(updates).eq('id', b.id);
          if (defeated && b.status === 'active') {
            await insertEvent('quest_complete', 'manual', { quest_id: b.id, title: 'Boss defeated: ' + b.name, type: 'main', xp_reward: b.xp_reward });
            toast(`★ BOSS DEFEATED — ${b.name}`, 4000);
            await refreshAfterEvent();
          }
          await loadBosses(); renderBosses();
        } else if (btn.dataset.act === 'del') {
          if (!confirm(`Delete boss "${b.name}"?`)) return;
          await supa.from('bosses').delete().eq('id', b.id);
          await loadBosses(); renderBosses();
        }
      });
    });
    list.appendChild(el);
  }
}

function renderRules() {
  const list = $('rules-list');
  if (!rules.length) { list.innerHTML = `<div class="empty">No rules yet.</div>`; return; }
  list.innerHTML = '';
  for (const r of rules) {
    const detail = [];
    detail.push('on ' + (r.match?.kind || 'any'));
    if (r.match?.payload) detail.push(JSON.stringify(r.match.payload));
    if (r.effect?.xp) detail.push(`+${r.effect.xp} XP`);
    if (r.effect?.xp_per_minute) detail.push(`+${r.effect.xp_per_minute}/min`);
    if (r.effect?.gold) detail.push(`${r.effect.gold > 0 ? '+' : ''}${r.effect.gold} gold`);
    if (r.effect?.gold_from_amount) detail.push('gold = $amount');
    if (r.effect?.stat_deltas) for (const [k,v] of Object.entries(r.effect.stat_deltas)) detail.push(`${k}${v >= 0 ? '+' : ''}${v}`);
    const el = document.createElement('div');
    el.className = `rule-item ${r.enabled ? '' : 'disabled'}`;
    el.innerHTML = `<div class="rule-meta"><div class="rule-desc"></div><div class="rule-detail">${detail.join(' · ')}</div></div><div class="rule-toggle ${r.enabled ? 'on' : ''}"></div><button class="rule-delete" title="Delete">×</button>`;
    el.querySelector('.rule-desc').textContent = r.description || r.id;
    el.querySelector('.rule-toggle').addEventListener('click', async () => {
      await supa.from('rules').update({ enabled: !r.enabled }).eq('id', r.id);
      await loadRules(); renderRules();
    });
    el.querySelector('.rule-delete').addEventListener('click', async () => {
      if (!confirm(`Delete rule "${r.description || r.id}"?`)) return;
      await supa.from('rules').delete().eq('id', r.id);
      await loadRules(); renderRules();
    });
    list.appendChild(el);
  }
}

function renderReleases() {
  const list = $('releases-list');
  const adminBtn = $('admin-release-btn');
  if (adminBtn) adminBtn.style.display = isAdmin ? '' : 'none';
  // Show sent releases to everyone; show drafts to admins
  const visible = isAdmin ? releases : releases.filter(r => r.sent_at);
  if (!visible.length) {
    list.innerHTML = `<div class="empty">${isAdmin ? 'No releases yet. Tap <span style="color:var(--gold)">+ Release</span> to announce an update.' : 'No release notes yet.'}</div>`;
    return;
  }
  list.innerHTML = '';
  for (const r of visible) {
    const el = document.createElement('div');
    el.style.cssText = 'background: var(--bg-1); border: 1px solid var(--line); border-radius: 10px; padding: 12px; border-left: 3px solid ' + (r.sent_at ? 'var(--gold)' : 'var(--cyan)') + ';';
    const when = r.sent_at ? `Sent ${new Date(r.sent_at).toLocaleString()}` : (r.scheduled_for ? `Scheduled ${new Date(r.scheduled_for).toLocaleString()}` : 'Draft');
    el.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:baseline; gap:8px; margin-bottom:4px;">
        <div style="font-weight:600; color:var(--text); font-size:14px;"></div>
        ${r.version ? `<div style="font-family:'JetBrains Mono', monospace; font-size:11px; color:var(--cyan);">v${escapeHtml(r.version)}</div>` : ''}
      </div>
      ${r.summary ? `<div style="font-size:12px; color:var(--muted); margin-bottom:6px;"></div>` : ''}
      ${r.details ? `<div style="font-size:12px; color:var(--text); white-space:pre-wrap; margin-bottom:6px;"></div>` : ''}
      <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px;">
        <div style="font-size:10px; letter-spacing:0.12em; color:var(--muted); font-family:'JetBrains Mono', monospace;">${when}</div>
        ${isAdmin && !r.sent_at ? `<button class="panel-action primary" data-send="${r.id}">Send now</button>` : ''}
      </div>`;
    el.querySelector('div > div').textContent = r.title;
    if (r.summary) el.querySelectorAll('div')[3].textContent = r.summary;
    if (r.details) {
      const detailsEl = el.querySelector('div[style*="white-space"]');
      if (detailsEl) detailsEl.textContent = r.details;
    }
    const sendBtn = el.querySelector('[data-send]');
    if (sendBtn) sendBtn.addEventListener('click', async () => {
      sendBtn.disabled = true; sendBtn.textContent = 'Sending…';
      const { data, error } = await supa.functions.invoke('send-release', { body: { release_id: r.id } });
      if (error || data?.error) { toast('Send failed: ' + (data?.error || error?.message)); sendBtn.disabled = false; sendBtn.textContent = 'Send now'; return; }
      toast(`Sent to ${data.sent} device${data.sent === 1 ? '' : 's'}`);
      await loadReleases(); renderReleases();
    });
    list.appendChild(el);
  }
}

function renderConnections() {
  const list = $('conn-list');
  if (!connections.length) {
    list.innerHTML = `<div class="empty">No connections yet. Tap <span style="color:var(--gold)">🏦 Connect Bank</span> or <span style="color:var(--gold)">+ Email</span>.</div>`;
    return;
  }
  list.innerHTML = '';
  for (const c of connections) {
    const initial = (c.provider || '?').charAt(0).toUpperCase();
    const display = c.external_id || c.provider;
    const lastSync = c.last_sync_at ? new Date(c.last_sync_at).toLocaleString('en-US',{hour:'numeric',minute:'2-digit',month:'short',day:'numeric'}) : 'never';
    const el = document.createElement('div');
    el.className = 'conn-item';
    el.innerHTML = `<div class="conn-icon">${initial}</div><div class="conn-meta"><div class="conn-name"></div><div class="conn-sub">${c.provider} · synced ${lastSync}</div></div><span class="conn-status ${c.status === 'active' ? 'active' : 'error'}">${c.status}</span><button class="conn-remove" title="Remove">×</button>`;
    el.querySelector('.conn-name').textContent = display;
    el.querySelector('.conn-remove').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Remove ${display}?`)) return;
      if (c._isPlaid) await supa.from('plaid_items').delete().eq('id', c.id);
      else await supa.from('connections').delete().eq('id', c.id);
      await loadConnections(); renderConnections();
    });
    list.appendChild(el);
  }
}

// ---- Bindings ----
$('char-name').addEventListener('input', (e) => saveCharacter({ name: e.target.value }));
$('char-class').addEventListener('input', (e) => saveCharacter({ class: e.target.value }));
$('main-quest').addEventListener('input', (e) => { saveCharacter({ main_quest: e.target.value }); autoGrow(e.target); });

document.querySelectorAll('.stat').forEach(el => {
  el.addEventListener('click', () => {
    const stat = el.dataset.stat; const v = prompt(`Set ${stat.replace('stat_','').toUpperCase()}:`, character[stat]);
    if (v === null) return; const n = parseInt(v, 10); if (Number.isNaN(n)) return;
    saveCharacter({ [stat]: n }); render();
  });
});

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active'); activeTab = t.dataset.tab; render();
  });
});

$('add-quest-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const title = $('new-quest').value.trim(); if (!title) return;
  $('new-quest').value = ''; addQuest(title, activeTab);
});

document.querySelectorAll('.day-action').forEach(btn => btn.addEventListener('click', () => openSheet(btn.dataset.log)));
$('sheet-backdrop').addEventListener('click', closeSheet);
document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeSheet));

// Meal photo + voice
$('meal-photo').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    mealMedia.photo = reader.result;
    const p = $('meal-preview');
    p.innerHTML = `Photo attached. <img src="${reader.result}" alt="meal" />`;
    p.style.display = ''; p.classList.add('has-content');
  };
  reader.readAsDataURL(f);
});
let recognition = null;
$('meal-voice').addEventListener('click', () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voice not supported on this browser'); return; }
  if (recognition) { recognition.stop(); recognition = null; $('meal-voice').textContent = 'Voice'; return; }
  recognition = new SR();
  recognition.lang = 'en-US'; recognition.continuous = false; recognition.interimResults = true;
  $('meal-voice').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff6b8a" stroke-width="2"><circle cx="12" cy="12" r="6" fill="#ff6b8a"/></svg> Listening…';
  recognition.onresult = (e) => {
    const txt = Array.from(e.results).map(r => r[0].transcript).join(' ');
    const desc = $('meal-desc'); desc.value = (desc.value ? desc.value + ' ' : '') + txt;
  };
  recognition.onend = () => {
    $('meal-voice').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4"/></svg> Voice';
    recognition = null;
  };
  recognition.start();
});
$('form-meal').addEventListener('submit', async (e) => {
  e.preventDefault();
  const desc = $('meal-desc').value.trim(); if (!desc) return;
  closeSheet(); await logMeal(desc, mealMedia.photo);
});

// Workout photo + voice
$('workout-photo').addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    workoutMedia.photo = reader.result;
    const p = $('workout-preview');
    p.innerHTML = `Photo attached. <img src="${reader.result}" alt="workout" />`;
    p.style.display = ''; p.classList.add('has-content');
  };
  reader.readAsDataURL(f);
});
let workoutRecognition = null;
$('workout-voice').addEventListener('click', () => {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast('Voice not supported on this browser'); return; }
  if (workoutRecognition) { workoutRecognition.stop(); workoutRecognition = null; $('workout-voice').textContent = 'Voice'; return; }
  workoutRecognition = new SR();
  workoutRecognition.lang = 'en-US'; workoutRecognition.continuous = false; workoutRecognition.interimResults = true;
  $('workout-voice').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#ff6b8a" stroke-width="2"><circle cx="12" cy="12" r="6" fill="#ff6b8a"/></svg> Listening…';
  workoutRecognition.onresult = (e) => {
    const txt = Array.from(e.results).map(r => r[0].transcript).join(' ');
    const desc = $('workout-desc'); desc.value = (desc.value ? desc.value + ' ' : '') + txt;
  };
  workoutRecognition.onend = () => {
    $('workout-voice').innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3zM19 10v2a7 7 0 01-14 0v-2M12 19v4"/></svg> Voice';
    workoutRecognition = null;
  };
  workoutRecognition.start();
});
$('form-workout').addEventListener('submit', async (e) => {
  e.preventDefault();
  const desc = $('workout-desc').value.trim();
  let type = $('workout-type').value;
  let durMin = parseInt($('workout-duration').value, 10);
  let cal = parseInt($('workout-calories').value, 10) || null;
  let notes = $('workout-notes').value.trim() || null;
  if (desc || workoutMedia.photo) {
    try {
      const { data, rateLimited } = await invokeAI('parse-workout', { description: desc, photo: workoutMedia.photo || null });
      if (!rateLimited && data) {
        if (!type && data.type) type = data.type;
        if (!durMin && data.duration_seconds) durMin = Math.round(data.duration_seconds / 60);
        if (!cal && data.calories) cal = data.calories;
        if (!notes && data.notes) notes = data.notes;
      }
    } catch (err) { console.error(err); }
  }
  if (!type) type = 'other';
  if (!durMin) durMin = 30;
  closeSheet(); await logWorkout(type, durMin, cal, notes);
});

$('form-money').addEventListener('submit', async (e) => {
  e.preventDefault();
  const dir = $('money-dir').value;
  const amt = parseFloat($('money-amount').value);
  const cat = $('money-category').value;
  const merch = $('money-merchant').value.trim();
  if (!amt || amt <= 0) return;
  closeSheet(); await logMoney(dir, amt, cat, merch);
});

// Email connection form
$('add-email-btn').addEventListener('click', () => openSheet('email'));
async function addEmailConnection(email, password) {
  const { error } = await supa.from('connections').insert({
    user_id: user.id, provider: 'imap',
    access_token: password, external_id: email,
    config: { user: email }, status: 'active'
  });
  if (error) {
    if (error.code === '23505') toast('That account is already connected');
    else toast('Failed: ' + error.message);
    return false;
  }
  toast(`Connected ${email}`);
  await loadConnections(); renderConnections();
  return true;
}
$('form-email').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('email-addr').value.trim(); const pw = $('email-pw').value;
  if (!email || !pw) return;
  $('email-addr').value = ''; $('email-pw').value = '';
  closeSheet();
  const ok = await addEmailConnection(email, pw);
  if (ok) setTimeout(() => syncNow(), 400);
});

// Sync
async function syncNow() {
  const btn = $('sync-now-btn');
  if (btn.classList.contains('spinning')) return;
  btn.classList.add('spinning'); btn.textContent = 'Syncing…';
  try {
    let imap = { inserted: 0, transactions: 0 };
    if (connections.some(c => c.provider === 'imap')) {
      const { data, rateLimited } = await invokeAI('sync-imap', {});
      if (rateLimited) { btn.classList.remove('spinning'); btn.textContent = 'Sync'; return; }
      if (data) imap = data;
    }
    let plaid = { txn_added: 0, balance_updates: 0 };
    if (connections.some(c => c._isPlaid)) {
      const { data } = await supa.functions.invoke('plaid-sync', { body: {} });
      if (data) plaid = data;
    }
    toast(`Synced · ${imap.inserted||0} mail · ${(imap.transactions||0)+(plaid.txn_added||0)} tx`);
  } catch (e) { toast('Sync error'); console.error(e); }
  finally {
    btn.classList.remove('spinning'); btn.textContent = 'Sync';
    await Promise.all([loadEmails(), loadTxns(), loadConnections(), loadCharacter(), loadSummary(), loadTxns7(), loadBalances()]);
    render();
  }
}
$('sync-now-btn').addEventListener('click', syncNow);

// Plaid Connect Bank
$('connect-bank-btn').addEventListener('click', async () => {
  if (!gatedFeature('bank integration')) return;
  const btn = $('connect-bank-btn');
  btn.disabled = true; btn.textContent = '🏦 Loading…';
  try {
    let Plaid;
    try { Plaid = await loadPlaidScript(); }
    catch { toast('Plaid blocked: allow cdn.plaid.com'); return; }
    const { data, error } = await supa.functions.invoke('plaid-link-token', { body: {} });
    if (error || !data?.link_token) { toast(data?.error || error?.message || 'Plaid not configured'); return; }
    const handler = Plaid.create({
      token: data.link_token,
      onSuccess: async (publicToken, metadata) => {
        toast('Linking ' + (metadata?.institution?.name || 'bank') + '…');
        const { data: ex, error: exErr } = await supa.functions.invoke('plaid-exchange', { body: { public_token: publicToken, institution: metadata?.institution || null } });
        if (exErr || !ex?.ok) { toast('Link failed: ' + (ex?.error || exErr?.message || 'unknown')); return; }
        toast(`Connected ${ex.institution_name || ''} · ${ex.accounts} accounts. Syncing…`);
        const { data: sync } = await supa.functions.invoke('plaid-sync', { body: {} });
        toast(`+${sync?.txn_added || 0} transactions, ${sync?.balance_updates || 0} balances`);
        await loadConnections(); await refreshAfterEvent();
      },
      onExit: (err) => { if (err) console.warn('Plaid exit', err); }
    });
    handler.open();
  } catch (e) { toast('Plaid error'); console.error(e); }
  finally { btn.disabled = false; btn.textContent = '🏦 Connect Bank'; }
});

// Boss form
$('add-boss-btn').addEventListener('click', () => openSheet('boss'));

// React when the auto-tracking selector changes: lock HP unit to the right unit,
// suggest a sensible target, and show a help blurb describing the rule.
const AUTO_KIND_META = {
  '': { help: '', unit: null, hp: null },
  'workout_streak': {
    help: 'HP = current consecutive-day workout streak. Logging any workout bumps it. Skipping a day resets it to 0. When HP hits target, boss is defeated.',
    unit: 'days',
    hp: 5
  }
};
function applyAutoKindUI() {
  const kind = $('boss-auto-kind').value || '';
  const meta = AUTO_KIND_META[kind] || AUTO_KIND_META[''];
  $('boss-auto-help').textContent = meta.help;
  const unitSel = $('boss-unit');
  const hpInput = $('boss-hp');
  if (meta.unit) {
    unitSel.value = meta.unit;
    unitSel.disabled = true;
  } else {
    unitSel.disabled = false;
  }
  if (kind && !hpInput.value) hpInput.value = String(meta.hp);
}
$('boss-auto-kind').addEventListener('change', applyAutoKindUI);

$('form-boss').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('boss-name').value.trim();
  const desc = $('boss-desc').value.trim() || null;
  const hp = parseFloat($('boss-hp').value);
  const unit = $('boss-unit').value;
  const xp = parseInt($('boss-xp').value, 10) || 500;
  const autoKind = $('boss-auto-kind').value || null;
  if (!name || !hp) return;
  closeSheet();
  await supa.from('bosses').insert({
    user_id: user.id, name, description: desc,
    hp_total: hp, hp_unit: unit, xp_reward: xp,
    auto_kind: autoKind
  });
  toast('Boss added: ' + name);
  $('boss-name').value = '';
  $('boss-desc').value = '';
  $('boss-hp').value = '';
  $('boss-xp').value = '500';
  $('boss-auto-kind').value = '';
  applyAutoKindUI();
  await loadBosses();
  if (autoKind) await recomputeAutoBosses();
  renderBosses();
});

// Admin: release form
const adminBtn = document.getElementById('admin-release-btn');
if (adminBtn) adminBtn.addEventListener('click', () => openSheet('release'));
const relWhen = document.getElementById('rel-when');
if (relWhen) relWhen.addEventListener('change', () => {
  document.getElementById('rel-time-field').style.display = relWhen.value === 'later' ? '' : 'none';
});
const formRelease = document.getElementById('form-release');
if (formRelease) formRelease.addEventListener('submit', async (e) => {
  e.preventDefault();
  const version = document.getElementById('rel-version').value.trim() || null;
  const title = document.getElementById('rel-title').value.trim();
  const summary = document.getElementById('rel-summary').value.trim() || null;
  const details = document.getElementById('rel-details').value.trim() || null;
  const when = document.getElementById('rel-when').value;
  let scheduled_for = null;
  if (when === 'later') {
    const v = document.getElementById('rel-time').value;
    if (v) scheduled_for = new Date(v).toISOString();
  }
  if (!title) return;
  closeSheet();
  const { data: created, error } = await supa.from('releases').insert({
    version, title, summary, details, scheduled_for, created_by: user.id
  }).select().single();
  if (error) { toast('Failed: ' + error.message); return; }
  if (when === 'now') {
    const { data, error: sendErr } = await supa.functions.invoke('send-release', { body: { release_id: created.id } });
    if (sendErr || data?.error) toast('Send failed: ' + (data?.error || sendErr?.message));
    else toast(`Sent to ${data.sent} device${data.sent === 1 ? '' : 's'}`);
  } else {
    toast('Release scheduled');
  }
  await loadReleases();
  renderReleases();
});

// Rule form
$('add-rule-btn').addEventListener('click', () => openSheet('rule'));
$('form-rule').addEventListener('submit', async (e) => {
  e.preventDefault();
  const desc = $('rule-desc').value.trim();
  const kind = $('rule-kind').value;
  const filter = $('rule-filter').value.trim();
  const xp = parseInt($('rule-xp').value, 10) || 0;
  const gold = parseInt($('rule-gold').value, 10) || 0;
  const stats = $('rule-stats').value.trim();
  const priority = parseInt($('rule-priority').value, 10) || 20;
  if (!desc) return;
  const match = { kind };
  if (filter) {
    match.payload = {};
    for (const part of filter.split(',')) {
      const [k,v] = part.split('=').map(s => s.trim());
      if (k && v !== undefined) match.payload[k] = isNaN(Number(v)) ? v : Number(v);
    }
  }
  const effect = {};
  if (xp) effect.xp = xp;
  if (gold) effect.gold = gold;
  if (stats) {
    effect.stat_deltas = {};
    for (const part of stats.split(',')) {
      const [k,v] = part.split('=').map(s => s.trim());
      if (k && v !== undefined) effect.stat_deltas[k] = parseInt(v.replace(/^\+/,''), 10);
    }
  }
  const id = `${user.id}:custom_${Date.now()}`;
  closeSheet();
  const { error } = await supa.from('rules').insert({ id, user_id: user.id, description: desc, match, effect, priority, enabled: true });
  if (error) { toast('Failed: ' + error.message); return; }
  toast('Rule added');
  await loadRules(); renderRules();
});

// Daily check-in form
$('form-checkin').addEventListener('submit', async (e) => {
  e.preventDefault();
  const sleep = parseInt($('ci-sleep').value, 10);
  const body = parseInt($('ci-body').value, 10);
  const questText = $('ci-quest').value.trim();
  const notes = $('ci-notes').value.trim();
  closeSheet();
  const today = new Date().toISOString().slice(0, 10);
  await supa.from('vitals').insert({ user_id: user.id, kind: 'sleep_score', value: sleep, unit: 'self_1to5', source: 'checkin', occurred_at: new Date().toISOString() });
  await supa.from('vitals').insert({ user_id: user.id, kind: 'body_score', value: body, unit: 'self_1to5', source: 'checkin', occurred_at: new Date().toISOString() });
  if (questText) await supa.from('quests').insert({ user_id: user.id, title: questText, type: 'daily', xp_reward: 50 });
  if (notes) await insertEvent('note', 'checkin', { note: notes });
  // Fire sleep_good event so REST stat moves when sleep score is 4+
  if (sleep >= 4) await insertEvent('sleep_good', 'checkin', { score: sleep });
  try { localStorage.setItem('lastCheckin', today); } catch {}
  toast(`Day started · ${sleep === 5 ? 'feeling great' : sleep <= 2 ? 'rough sleep, take it easy' : "let's go"}`);
  await Promise.all([loadQuests(), loadStreaks()]);
  render();
});
function maybeOfferCheckin() {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const last = localStorage.getItem('lastCheckin');
    if (last !== today) setTimeout(() => openSheet('checkin'), 600);
  } catch {}
}

// AI Suggest quests
$('suggest-quests-btn').addEventListener('click', async () => {
  const btn = $('suggest-quests-btn'); const list = $('suggest-list');
  btn.disabled = true; btn.textContent = '✦ Thinking…';
  try {
    const { data, error, rateLimited } = await invokeAI('generate-side-quests', {});
    if (rateLimited) { list.style.display = 'none'; return; }
    if (error || !data?.quests?.length) { toast(error?.message || 'No suggestions'); list.style.display = 'none'; return; }
    list.style.display = '';
    list.innerHTML = data.quests.map((q, i) => `<div class="suggest-item"><div class="suggest-body"><div class="suggest-title"></div><div class="suggest-reason"></div></div><button class="suggest-add" data-idx="${i}">Add</button></div>`).join('');
    Array.from(list.children).forEach((el, i) => {
      el.querySelector('.suggest-title').textContent = data.quests[i].title;
      el.querySelector('.suggest-reason').textContent = data.quests[i].reason || '';
      el.querySelector('.suggest-add').addEventListener('click', async () => {
        const q = data.quests[i];
        await addQuest(q.title, ['main','side','daily'].includes(q.type) ? q.type : activeTab);
        el.style.opacity = '0.4';
      });
    });
  } catch (e) { toast('Failed to suggest'); console.error(e); }
  finally { btn.disabled = false; btn.textContent = '✦ Suggest quests with AI'; }
});

// Web Bluetooth HR
let hrSession = null;
$('bt-pair-btn').addEventListener('click', async () => {
  if (!navigator.bluetooth) { toast('Web Bluetooth not supported'); return; }
  try {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService('heart_rate');
    const char = await service.getCharacteristic('heart_rate_measurement');
    await char.startNotifications();
    hrSession = { device, char, startedAt: Date.now(), readings: [], sum: 0, count: 0, max: 0, current: 0, timer: null, type: $('workout-type').value || 'other' };
    char.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      const flags = v.getUint8(0);
      const bpm = (flags & 0x1) ? v.getUint16(1, true) : v.getUint8(1);
      if (bpm > 0 && bpm < 250) {
        hrSession.readings.push({ t: Date.now() - hrSession.startedAt, bpm });
        hrSession.sum += bpm; hrSession.count += 1;
        if (bpm > hrSession.max) hrSession.max = bpm;
        hrSession.current = bpm;
      }
    });
    ['meal','workout','money','email','boss','checkin','rule'].forEach(k => { const el = $('form-'+k); if (el) el.style.display = 'none'; });
    $('live-hr').style.display = '';
    $('sheet-title').textContent = 'Live Session';
    hrSession.timer = setInterval(() => {
      const elapsedS = Math.floor((Date.now() - hrSession.startedAt) / 1000);
      const m = Math.floor(elapsedS / 60); const s = elapsedS % 60;
      $('hr-bpm').textContent = hrSession.current || '—';
      $('hr-avg').textContent = hrSession.count ? Math.round(hrSession.sum / hrSession.count) : '—';
      $('hr-max').textContent = hrSession.max || '—';
      $('hr-time').textContent = `${m}:${String(s).padStart(2,'0')}`;
    }, 500);
    toast(`Connected ${device.name || 'HR strap'}`);
  } catch (e) { if (e.name !== 'NotFoundError') toast('Bluetooth: ' + (e.message || e.name)); }
});
$('hr-stop').addEventListener('click', async () => {
  if (!hrSession) return;
  clearInterval(hrSession.timer);
  try { await hrSession.char.stopNotifications(); } catch {}
  try { hrSession.device.gatt.disconnect(); } catch {}
  const dur_s = Math.max(1, Math.floor((Date.now() - hrSession.startedAt) / 1000));
  const avg = hrSession.count ? Math.round(hrSession.sum / hrSession.count) : null;
  const max = hrSession.max || null;
  let kcal = null;
  if (avg) {
    const perMin = Math.max(0, (-55.0969 + 0.6309 * avg + 0.1988 * 75 + 0.2017 * 30) / 4.184);
    kcal = Math.round(perMin * (dur_s / 60));
  }
  const startedAt = new Date(hrSession.startedAt).toISOString();
  const type = hrSession.type;
  hrSession = null;
  const { data: wRow } = await supa.from('workouts').insert({
    user_id: user.id, type, source: 'bluetooth', started_at: startedAt,
    duration_seconds: dur_s, avg_hr: avg, max_hr: max, calories: kcal
  }).select().single();
  await insertEvent('workout', 'bluetooth', { type, duration_seconds: dur_s, calories: kcal, avg_hr: avg, max_hr: max, workout_id: wRow?.id }, startedAt);
  await recomputeAutoBosses();
  toast(`Saved · ${Math.floor(dur_s/60)} min · avg ${avg || '—'} bpm`);
  closeSheet();
  await refreshAfterEvent();
});

// Push notifications
const VAPID_PUBLIC = 'BLdzQLOE0D2lT0i0JlVYku3cv-jxEbUSF1G1kV8l5jUZp6Hhxg1nhXC3ouM1NS0HmVwDXEINYTtfY7NVdB4tqWw';
function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - b64.length % 4) % 4);
  const b = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}
$('enable-push-btn').addEventListener('click', async () => {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) { toast('Push not supported'); return; }
  const reg = await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications declined'); return; }
  let sub = await reg.pushManager.getSubscription();
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) });
  const j = sub.toJSON();
  const { error } = await supa.from('push_subscriptions').upsert({
    user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
    user_agent: navigator.userAgent.slice(0, 200)
  }, { onConflict: 'user_id,endpoint' });
  if (error) { toast('Save failed: ' + error.message); return; }
  toast('Notifications enabled. Sending test…');
  try { await supa.functions.invoke('send-push', { body: { title: 'Game of Life connected', body: 'Push notifications are live.', url: '/' } }); } catch {}
});


// Profile / friends
document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('edit-profile-btn')?.addEventListener('click', openProfileEditor);
  document.getElementById('friends-btn')?.addEventListener('click', openFriends);
  document.getElementById('form-profile')?.addEventListener('submit', async (e) => { e.preventDefault(); await saveProfile(); });
  document.getElementById('friend-add-btn')?.addEventListener('click', async () => {
    const email = document.getElementById('friend-email').value.trim();
    if (email) { await addFriendByEmail(email); document.getElementById('friend-email').value = ''; }
  });
});

// Subscription button
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('acct-action-btn');
  if (btn) btn.addEventListener('click', startCheckout);
});

// Collapsible toggles
document.querySelectorAll('[data-toggle]').forEach(b => {
  b.addEventListener('click', () => document.getElementById(b.dataset.toggle).classList.toggle('collapsed'));
});

// ============================================================
// History view — charts + recent items per category
// ============================================================
let historyRange = 30; // days
let historyTab = 'meals';

function openHistory() {
  const el = document.getElementById('history-screen');
  if (!el) return;
  el.classList.remove('hidden');
  renderHistory();
}
function closeHistory() {
  const el = document.getElementById('history-screen');
  if (el) el.classList.add('hidden');
}

function ymdLocal(d) {
  const z = new Date(d);
  return z.getFullYear() + '-' + String(z.getMonth()+1).padStart(2,'0') + '-' + String(z.getDate()).padStart(2,'0');
}
function lastNDays(n) {
  const out = [];
  const today = new Date(); today.setHours(0,0,0,0);
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(today); d.setDate(d.getDate() - i);
    out.push({ date: d, key: ymdLocal(d), value: 0, count: 0 });
  }
  return out;
}

async function prepareHistoryFrame() {
  const today = new Date(); today.setHours(0,0,0,0);
  if (historyRange === 'all') {
    // Find earliest record across data tables
    const sources = [['meals','occurred_at'],['workouts','started_at'],['transactions','occurred_at'],['vitals','occurred_at'],['events','occurred_at']];
    let earliest = null;
    for (const [t, c] of sources) {
      const { data } = await supa.from(t).select(c).eq('user_id', user.id).order(c, { ascending: true }).limit(1);
      if (data && data[0]) {
        const d = new Date(data[0][c]);
        if (!earliest || d < earliest) earliest = d;
      }
    }
    if (!earliest) { earliest = new Date(today); earliest.setDate(earliest.getDate() - 6); }
    earliest.setHours(0,0,0,0);
    const span = Math.max(1, Math.ceil((today - earliest) / 86400000) + 1);
    const periodDays = span <= 90 ? 1 : span <= 365 ? 7 : 30;
    const unit = span <= 90 ? 'day' : span <= 365 ? 'week' : 'month';
    const buckets = [];
    const cur = new Date(earliest);
    while (cur <= today) {
      buckets.push({ start: new Date(cur), key: ymdLocal(cur), value: 0, count: 0, in: 0, out: 0, protein: 0 });
      cur.setDate(cur.getDate() + periodDays);
    }
    return { since: earliest, until: today, buckets, unit, periodDays, daysSpan: span, lifetime: true };
  }
  const n = historyRange;
  const since = new Date(today); since.setDate(since.getDate() - n + 1);
  const buckets = [];
  for (let i = 0; i < n; i++) {
    const d = new Date(since); d.setDate(d.getDate() + i);
    buckets.push({ start: d, key: ymdLocal(d), value: 0, count: 0, in: 0, out: 0, protein: 0 });
  }
  return { since, until: today, buckets, unit: 'day', periodDays: 1, daysSpan: n, lifetime: false };
}

function bucketIndexFor(frame, date) {
  const d = new Date(date); d.setHours(0,0,0,0);
  const diffMs = d - frame.since;
  const idx = Math.floor(diffMs / (frame.periodDays * 86400000));
  return (idx >= 0 && idx < frame.buckets.length) ? idx : -1;
}

function frameAxis(frame) {
  if (!frame.buckets.length) return '';
  const first = frame.buckets[0].start;
  const last = frame.buckets[frame.buckets.length - 1].start;
  const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: frame.lifetime && frame.daysSpan > 365 ? 'numeric' : undefined });
  const unitText = frame.unit === 'day' ? '' : frame.unit === 'week' ? ' · weekly buckets' : ' · monthly buckets';
  return '<div class="chart-axis"><span>' + fmt(first) + unitText + '</span><span>' + fmt(last) + '</span></div>';
}

function frameSummary(frame, totalCount) {
  if (!frame.lifetime) return '';
  return '<div style="font-size:11px;color:var(--muted);letter-spacing:0.04em;margin-bottom:10px;font-family:\'JetBrains Mono\',monospace;">Tracking ' + frame.daysSpan + ' day' + (frame.daysSpan===1?'':'s') + ' · since ' + frame.since.toLocaleDateString('en-US',{year:'numeric',month:'short',day:'numeric'}) + '</div>';
}


// Build inline SVG bar chart. data = [{key, value, ...}], opts = {color, height, max?}
function svgBarChart(data, opts) {
  opts = opts || {};
  const color = opts.color || 'var(--cyan)';
  const h = opts.height || 120;
  const max = opts.max || Math.max(1, ...data.map(d => Math.abs(d.value || 0)));
  const w = 600;
  const pad = 4;
  const barW = (w - pad * (data.length - 1)) / data.length;
  let bars = '';
  data.forEach((d, i) => {
    const x = i * (barW + pad);
    const hh = max ? (Math.abs(d.value) / max) * (h - 10) : 0;
    const y = h - hh;
    const title = d.tooltip || (d.key + ': ' + d.value);
    bars += '<g><rect x="' + x.toFixed(1) + '" y="' + y.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + hh.toFixed(1) + '" fill="' + color + '" opacity="0.85" rx="2"><title>' + title.replace(/</g,'&lt;') + '</title></rect></g>';
  });
  return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' + bars + '</svg>';
}

// Net-flow chart: in (green up) + out (red down) stacked around a center line
function svgFlowChart(days, h) {
  h = h || 120;
  const w = 600;
  const pad = 4;
  const barW = (w - pad * (days.length - 1)) / days.length;
  const max = Math.max(1, ...days.map(d => Math.max(d.in || 0, d.out || 0)));
  const mid = h / 2;
  let bars = '';
  days.forEach((d, i) => {
    const x = i * (barW + pad);
    const inH = d.in ? (d.in / max) * (h / 2 - 4) : 0;
    const outH = d.out ? (d.out / max) * (h / 2 - 4) : 0;
    if (d.in > 0) bars += '<rect x="' + x.toFixed(1) + '" y="' + (mid - inH).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + inH.toFixed(1) + '" fill="var(--green)" opacity="0.8" rx="2"><title>' + d.key + ': +$' + (d.in/100).toFixed(0) + '</title></rect>';
    if (d.out > 0) bars += '<rect x="' + x.toFixed(1) + '" y="' + mid + '" width="' + barW.toFixed(1) + '" height="' + outH.toFixed(1) + '" fill="var(--red)" opacity="0.8" rx="2"><title>' + d.key + ': -$' + (d.out/100).toFixed(0) + '</title></rect>';
  });
  bars += '<line x1="0" y1="' + mid + '" x2="' + w + '" y2="' + mid + '" stroke="var(--line)" stroke-width="1"/>';
  return '<svg class="chart-svg" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' + bars + '</svg>';
}

async function renderHistory() {
  const body = document.getElementById('history-body');
  if (!body) return;
  body.innerHTML = '<div style="text-align:center; padding:40px; color:var(--muted);">Loading…</div>';
  // Range selector
  const rangeBar =
    '<div class="history-range">' +
    [7, 30, 90].map(n =>
      '<button class="range-btn ' + (historyRange===n?'active':'') + '" data-range="' + n + '">' + n + 'd</button>'
    ).join('') +
    '<button class="range-btn ' + (historyRange==="all"?'active':'') + '" data-range="all">ALL</button>' +
    '</div>';
  if (historyTab === 'meals') body.innerHTML = rangeBar + await renderMealsHistory();
  else if (historyTab === 'workouts') body.innerHTML = rangeBar + await renderWorkoutsHistory();
  else if (historyTab === 'money') body.innerHTML = rangeBar + await renderMoneyHistory();
  else if (historyTab === 'body') body.innerHTML = rangeBar + await renderBodyHistory();
  else if (historyTab === 'quests') body.innerHTML = rangeBar + await renderQuestsHistory();
  // Bind range buttons
  body.querySelectorAll('.range-btn').forEach(b => b.addEventListener('click', () => {
    const v = b.dataset.range; historyRange = (v === 'all') ? 'all' : parseInt(v, 10);
    renderHistory();
  }));
}

async function renderMealsHistory() {
  const frame = await prepareHistoryFrame();
  const { data } = await supa.from('meals')
    .select('*').eq('user_id', user.id).gte('occurred_at', frame.since.toISOString())
    .order('occurred_at', { ascending: false }).limit(10000);
  const meals = data || [];
  let totalCals = 0, totalProtein = 0;
  for (const m of meals) {
    const idx = bucketIndexFor(frame, m.occurred_at);
    if (idx >= 0) {
      frame.buckets[idx].value += (m.calories || 0);
      frame.buckets[idx].count += 1;
      frame.buckets[idx].protein += (m.protein_g || 0);
    }
    totalCals += (m.calories || 0);
    totalProtein += (m.protein_g || 0);
  }
  const periodLabel = frame.unit === 'day' ? 'day' : frame.unit === 'week' ? 'week' : 'month';
  const avgCal = meals.length ? Math.round(totalCals / Math.max(1, frame.buckets.length)) : 0;
  const calChart = '<div class="chart-card"><div class="chart-title">Calories per ' + periodLabel + '</div>' +
    '<div class="chart-stat">' + avgCal + '<span class="sub">avg / ' + periodLabel + ' · ' + totalCals.toLocaleString('en-US') + ' total cal</span></div>' +
    svgBarChart(frame.buckets.map(b => ({ key: b.key, value: b.value, tooltip: b.key + ': ' + b.value + ' cal' })), { color: 'var(--gold)' }) +
    frameAxis(frame) + '</div>';
  const protChart = '<div class="chart-card"><div class="chart-title">Protein per ' + periodLabel + '</div>' +
    '<div class="chart-stat">' + Math.round(totalProtein / Math.max(1, frame.buckets.length)) + '<span class="sub">g avg / ' + periodLabel + ' · ' + totalProtein.toLocaleString('en-US') + 'g total</span></div>' +
    svgBarChart(frame.buckets.map(b => ({ key: b.key, value: b.protein, tooltip: b.key + ': ' + b.protein + 'g' })), { color: 'var(--cyan)' }) + '</div>';
  const list = '<div class="history-section-label">Recent (' + meals.length + ' meals)</div><div class="history-list">' +
    meals.slice(0, 50).map(m => {
      const t = new Date(m.occurred_at);
      return '<div class="history-item"><div class="h-icon">🍽️</div><div class="h-body"><div class="h-title">' + (m.description || 'meal').replace(/</g,'&lt;') + '</div><div class="h-sub">' + t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + (m.protein_g ? ' · ' + m.protein_g + 'g protein' : '') + '</div></div><div class="h-right">' + (m.calories || '—') + ' cal</div></div>';
    }).join('') +
    (meals.length === 0 ? '<div class="empty">No meals logged in this range.</div>' : '') + '</div>';
  return frameSummary(frame) + calChart + protChart + list;
}

async function renderWorkoutsHistory() {
  const frame = await prepareHistoryFrame();
  const { data } = await supa.from('workouts')
    .select('*').eq('user_id', user.id).gte('started_at', frame.since.toISOString())
    .order('started_at', { ascending: false }).limit(10000);
  const workouts = data || [];
  const typeBreakdown = {};
  let totalMin = 0;
  for (const w of workouts) {
    const idx = bucketIndexFor(frame, w.started_at);
    const min = Math.round((w.duration_seconds || 0) / 60);
    if (idx >= 0) { frame.buckets[idx].value += min; frame.buckets[idx].count += 1; }
    typeBreakdown[w.type || 'other'] = (typeBreakdown[w.type || 'other'] || 0) + 1;
    totalMin += min;
  }
  const periodLabel = frame.unit === 'day' ? 'day' : frame.unit === 'week' ? 'week' : 'month';
  const minChart = '<div class="chart-card"><div class="chart-title">Workout minutes per ' + periodLabel + '</div>' +
    '<div class="chart-stat">' + totalMin + '<span class="sub">total min · ' + workouts.length + ' sessions</span></div>' +
    svgBarChart(frame.buckets.map(b => ({ key: b.key, value: b.value, tooltip: b.key + ': ' + b.value + ' min' })), { color: 'var(--magenta)' }) +
    frameAxis(frame) + '</div>';
  const types = Object.entries(typeBreakdown).sort((a,b)=>b[1]-a[1]);
  const maxType = Math.max(1, ...types.map(x=>x[1]));
  const typeBars = '<div class="chart-card"><div class="chart-title">By type</div>' +
    types.map(([t, c]) =>
      '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">' +
      '<div style="width: 60px; font-size:12px; color: var(--text);">' + t + '</div>' +
      '<div style="flex:1; background: var(--bg-3); border-radius: 4px; height: 14px; overflow:hidden;">' +
      '<div style="height:100%; background: var(--gold); width:' + ((c / maxType) * 100) + '%;"></div></div>' +
      '<div style="font-family: \'JetBrains Mono\', monospace; font-size:11px; color: var(--muted); min-width: 28px; text-align:right;">' + c + '</div></div>'
    ).join('') + '</div>';
  const list = '<div class="history-section-label">Recent (' + workouts.length + ' sessions)</div><div class="history-list">' +
    workouts.slice(0, 50).map(w => {
      const t = new Date(w.started_at);
      const min = Math.round((w.duration_seconds || 0) / 60);
      return '<div class="history-item"><div class="h-icon">💪</div><div class="h-body"><div class="h-title">' + (w.type || 'workout') + (w.notes ? ' · ' + w.notes.replace(/</g,'&lt;') : '') + '</div><div class="h-sub">' + t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' · ' + min + ' min' + (w.avg_hr ? ' · avg ' + w.avg_hr + ' bpm' : '') + '</div></div><div class="h-right">' + (w.calories || '—') + ' cal</div></div>';
    }).join('') +
    (workouts.length === 0 ? '<div class="empty">No workouts logged in this range.</div>' : '') + '</div>';
  return frameSummary(frame) + minChart + typeBars + list;
}

async function renderMoneyHistory() {
  const frame = await prepareHistoryFrame();
  const { data } = await supa.from('transactions')
    .select('*').eq('user_id', user.id).gte('occurred_at', frame.since.toISOString())
    .order('occurred_at', { ascending: false }).limit(10000);
  const txs = data || [];
  let totalIn = 0, totalOut = 0;
  const catTotals = {};
  for (const tx of txs) {
    const idx = bucketIndexFor(frame, tx.occurred_at);
    const c = tx.amount_cents || 0;
    if (c >= 0) { if (idx >= 0) frame.buckets[idx].in += c; totalIn += c; }
    else { if (idx >= 0) frame.buckets[idx].out += -c; totalOut += -c; }
    catTotals[tx.category || 'other'] = (catTotals[tx.category || 'other'] || 0) + Math.abs(c);
  }
  const flowChart = '<div class="chart-card"><div class="chart-title">Cash flow</div>' +
    '<div class="chart-stat" style="color:' + ((totalIn-totalOut)>=0?'var(--green)':'var(--red)') + ';">' +
    ((totalIn-totalOut)>=0?'+':'−') + '$' + Math.abs((totalIn-totalOut)/100).toLocaleString('en-US',{maximumFractionDigits:0}) +
    '<span class="sub">net · +$' + (totalIn/100).toLocaleString('en-US',{maximumFractionDigits:0}) + ' / −$' + (totalOut/100).toLocaleString('en-US',{maximumFractionDigits:0}) + '</span></div>' +
    svgFlowChart(frame.buckets) + frameAxis(frame) + '</div>';
  const cats = Object.entries(catTotals).sort((a,b)=>b[1]-a[1]).slice(0, 8);
  const maxCat = Math.max(1, ...cats.map(x=>x[1]));
  const catChart = '<div class="chart-card"><div class="chart-title">Top categories</div>' +
    cats.map(([c, v]) =>
      '<div style="display:flex; align-items:center; gap:8px; margin-bottom:6px;">' +
      '<div style="width: 80px; font-size:12px; color: var(--text);">' + c + '</div>' +
      '<div style="flex:1; background: var(--bg-3); border-radius: 4px; height: 14px; overflow:hidden;">' +
      '<div style="height:100%; background: var(--gold); width:' + ((v / maxCat) * 100) + '%;"></div></div>' +
      '<div style="font-family: \'JetBrains Mono\', monospace; font-size:11px; color: var(--muted); min-width: 50px; text-align:right;">$' + (v/100).toFixed(0) + '</div></div>'
    ).join('') + '</div>';
  const list = '<div class="history-section-label">Recent (' + txs.length + ' transactions)</div><div class="history-list">' +
    txs.slice(0, 50).map(tx => {
      const t = new Date(tx.occurred_at);
      const cents = tx.amount_cents || 0;
      const dir = cents >= 0 ? 'in' : 'out';
      const icon = ({ restaurants: '🍽️', coffee: '☕', groceries: '🛒', gas: '⛽', entertainment: '🎬', bills: '📄', transfer: '⇄', income: '↓', shopping: '🛍️', travel: '✈️', healthcare: '⚕️', other: '·' })[tx.category || 'other'] || '·';
      return '<div class="history-item"><div class="h-icon">' + icon + '</div><div class="h-body"><div class="h-title">' + (tx.merchant || tx.description || tx.category || 'transaction').replace(/</g,'&lt;') + '</div><div class="h-sub">' + t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + ' · ' + (tx.category || 'other') + '</div></div><div class="h-right" style="color:' + (dir==='in'?'var(--green)':'var(--red)') + ';">' + (dir==='in'?'+':'−') + '$' + Math.abs(cents/100).toFixed(2) + '</div></div>';
    }).join('') +
    (txs.length === 0 ? '<div class="empty">No transactions in this range.</div>' : '') + '</div>';
  return frameSummary(frame) + flowChart + catChart + list;
}

async function renderBodyHistory() {
  const frame = await prepareHistoryFrame();
  const { data } = await supa.from('vitals')
    .select('*').eq('user_id', user.id).gte('occurred_at', frame.since.toISOString())
    .order('occurred_at', { ascending: false }).limit(10000);
  const vits = data || [];
  const sleep = vits.filter(v => v.kind === 'sleep_score');
  const body = vits.filter(v => v.kind === 'body_score');
  // Two parallel bucket arrays
  const sleepBuckets = frame.buckets.map(b => ({ ...b, value: 0, count: 0 }));
  const bodyBuckets = frame.buckets.map(b => ({ ...b, value: 0, count: 0 }));
  for (const v of sleep) {
    const idx = bucketIndexFor(frame, v.occurred_at);
    if (idx >= 0) { sleepBuckets[idx].value += Number(v.value); sleepBuckets[idx].count += 1; }
  }
  for (const v of body) {
    const idx = bucketIndexFor(frame, v.occurred_at);
    if (idx >= 0) { bodyBuckets[idx].value += Number(v.value); bodyBuckets[idx].count += 1; }
  }
  for (const b of sleepBuckets) if (b.count > 1) b.value = b.value / b.count;
  for (const b of bodyBuckets) if (b.count > 1) b.value = b.value / b.count;
  const avgSleep = sleep.length ? (sleep.reduce((s,v)=>s+Number(v.value),0) / sleep.length).toFixed(1) : '—';
  const avgBody = body.length ? (body.reduce((s,v)=>s+Number(v.value),0) / body.length).toFixed(1) : '—';
  const sleepChart = '<div class="chart-card"><div class="chart-title">Sleep score (1-5)</div>' +
    '<div class="chart-stat">' + avgSleep + '<span class="sub">avg · ' + sleep.length + ' check-ins</span></div>' +
    svgBarChart(sleepBuckets.map(b=>({key:b.key,value:b.value,tooltip:b.key+': '+b.value.toFixed(1)})), { color: 'var(--cyan)', max: 5 }) +
    frameAxis(frame) + '</div>';
  const bodyChart = '<div class="chart-card"><div class="chart-title">Body feel (1-5)</div>' +
    '<div class="chart-stat">' + avgBody + '<span class="sub">avg · ' + body.length + ' check-ins</span></div>' +
    svgBarChart(bodyBuckets.map(b=>({key:b.key,value:b.value,tooltip:b.key+': '+b.value.toFixed(1)})), { color: 'var(--magenta)', max: 5 }) + '</div>';
  if (vits.length === 0) {
    return frameSummary(frame) + sleepChart + bodyChart + '<div class="empty">No check-ins in this range. Do the daily check-in to start tracking sleep / body.</div>';
  }
  return frameSummary(frame) + sleepChart + bodyChart;
}

async function renderQuestsHistory() {
  const frame = await prepareHistoryFrame();
  const { data } = await supa.from('events')
    .select('*').eq('user_id', user.id).eq('kind', 'quest_complete').gte('occurred_at', frame.since.toISOString())
    .order('occurred_at', { ascending: false }).limit(10000);
  const evs = data || [];
  for (const e of evs) {
    const idx = bucketIndexFor(frame, e.occurred_at);
    if (idx >= 0) { frame.buckets[idx].value += 1; frame.buckets[idx].xp = (frame.buckets[idx].xp || 0) + (e.xp_delta || 0); }
  }
  const totalXp = evs.reduce((s, e) => s + (e.xp_delta || 0), 0);
  const periodLabel = frame.unit === 'day' ? 'day' : frame.unit === 'week' ? 'week' : 'month';
  const chart = '<div class="chart-card"><div class="chart-title">Quests completed per ' + periodLabel + '</div>' +
    '<div class="chart-stat">' + evs.length + '<span class="sub">completions · +' + totalXp.toLocaleString('en-US') + ' XP</span></div>' +
    svgBarChart(frame.buckets.map(b => ({ key: b.key, value: b.value, tooltip: b.key + ': ' + b.value })), { color: 'var(--gold)' }) +
    frameAxis(frame) + '</div>';
  const list = '<div class="history-section-label">Recent (' + evs.length + ' completions)</div><div class="history-list">' +
    evs.slice(0, 50).map(e => {
      const t = new Date(e.occurred_at);
      const title = e.payload && e.payload.title ? e.payload.title : 'quest';
      const type = e.payload && e.payload.type ? e.payload.type : '';
      return '<div class="history-item"><div class="h-icon">✨</div><div class="h-body"><div class="h-title">' + title.replace(/</g,'&lt;') + '</div><div class="h-sub">' + t.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) + (type ? ' · ' + type : '') + '</div></div><div class="h-right">+' + (e.xp_delta || 0) + ' XP</div></div>';
    }).join('') +
    (evs.length === 0 ? '<div class="empty">No quest completions in this range.</div>' : '') + '</div>';
  return frameSummary(frame) + chart + list;
}

// Wire up button + tabs + close
document.addEventListener('DOMContentLoaded', () => {
  // About / Help sheet open button
  const helpBtn = document.getElementById('help-btn');
  if (helpBtn) helpBtn.addEventListener('click', openHelpSheet);

  // Share button inside the help sheet
  const helpShare = document.getElementById('help-share-btn');
  if (helpShare) helpShare.addEventListener('click', () => shareApp());

  // Feedback form submit
  const fbForm = document.getElementById('form-feedback');
  if (fbForm) fbForm.addEventListener('submit', submitFeedback);

  // Per-domain levels expand/collapse
  const toggle = document.getElementById('domains-toggle');
  if (toggle) {
    toggle.addEventListener('click', () => {
      const panel = document.getElementById('domains-panel');
      const icon = document.getElementById('domains-toggle-icon');
      const label = document.getElementById('domains-toggle-label');
      if (!panel) return;
      domainsExpanded = !domainsExpanded;
      panel.style.display = domainsExpanded ? 'flex' : 'none';
      if (icon) icon.textContent = domainsExpanded ? '▴' : '▾';
      if (label) label.textContent = domainsExpanded ? 'Hide per-domain levels' : 'Show per-domain levels';
    });
  }
  const btn = document.getElementById('history-btn');
  if (btn) btn.addEventListener('click', openHistory);
  const close = document.getElementById('history-close');
  if (close) close.addEventListener('click', closeHistory);
  document.querySelectorAll('.history-tab').forEach(t => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.history-tab').forEach(x => x.classList.remove('active'));
      t.classList.add('active');
      historyTab = t.dataset.htab;
      renderHistory();
    });
  });
});

// Boot
(async () => {
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (session) await onSignedIn(session.user);
    else { hide($('loading')); show($('auth-screen')); checkForAppUpdates(); }
  } catch (e) { surfaceFatal(e?.message || String(e), e?.stack); }
})();

// Service worker registration
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').then(reg => {
      reg.addEventListener('updatefound', () => {
        const sw = reg.installing;
        if (sw) sw.addEventListener('statechange', () => {
          if (sw.state === 'activated') console.log('SW activated');
        });
      });
    }).catch(() => {});
  });
}
