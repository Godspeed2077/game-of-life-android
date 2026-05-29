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

// ---- Forgot password ----
$('auth-forgot')?.addEventListener('click', async () => {
  const current = ($('auth-email').value || '').trim();
  const email = (window.prompt('Email to send a reset link to:', current) || '').trim();
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    const msg = $('auth-msg');
    msg.className = 'auth-msg error';
    msg.textContent = "That doesn't look like a valid email.";
    return;
  }
  const msg = $('auth-msg');
  msg.className = 'auth-msg info';
  msg.textContent = 'Sending reset link…';
  try {
    // Always send to the live site so the link works on any device,
    // including PWAs installed from forgepointrelay.com.
    const redirectTo = (location.origin && location.origin.startsWith('http'))
      ? location.origin + '/reset.html'
      : 'https://gameoflifeapp.vercel.app/reset.html';
    const { error } = await supa.auth.resetPasswordForEmail(email, { redirectTo });
    if (error) throw error;
    msg.className = 'auth-msg success';
    msg.textContent = "If that email is registered, a reset link is on its way. Check your inbox (and spam).";
  } catch (err) {
    msg.className = 'auth-msg error';
    msg.textContent = err.message || 'Could not send reset link.';
  }
});

// ---- APK auto-update detection ----
// BUILD_VERSION is injected by GitHub Actions at APK build time.
// PWA users have it as null, so the check no-ops for them.
async function checkForAppUpdates() {
  // Hot-updates are now handled by the standard Service Worker flow at the
  // bottom of this file. Capgo / link-token / bundle download are removed.
  return;
  // (Old Capgo-based logic kept below for reference; unreachable.)
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
  // If user already dismissed this exact version recently (12h), don't re-show.
  try {
    const dismissedAt = parseInt(localStorage.getItem('updateBannerDismissedAt') || '0', 10);
    const dismissedFor = localStorage.getItem('updateBannerDismissedFor') || '';
    if (dismissedAt && dismissedFor === (info.version || '') && (Date.now() - dismissedAt < 12 * 3600 * 1000)) {
      // Honor the user's dismissal for 12h, then re-nag.
      return;
    }
  } catch {}
  const cap = window.Capacitor;
  const updater = cap && cap.Plugins && cap.Plugins.CapacitorUpdater;
  // Force APK download when the previous hot-update rolled back. Capgo's safety
  // timer is too aggressive on this device — the user can always install the
  // APK directly and that's guaranteed to apply.
  const canHotUpdate = !!(updater && updater.download && info.bundle_url) && !info._forceApkFallback;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#f5c842,#b89531);color:#070912;padding:calc(12px + env(safe-area-inset-top, 0px)) 16px 12px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 6px 24px rgba(0,0,0,0.55);font-family:Inter,system-ui,sans-serif;border-bottom:1px solid rgba(0,0,0,0.2);';
  const versionText = (info.version || 'new build');
  const subline = canHotUpdate ? 'Tap to download the latest update.' : (info._forceApkFallback ? 'Previous in-place update got rolled back — installing the APK directly fixes it permanently.' : 'Tap to download the latest APK.');
  banner.innerHTML = '<div style="flex:1;min-width:0;"><div style="font-weight:700;font-size:13px;">New version available — ' + versionText + '</div><div id="update-sub" style="font-size:11px;opacity:0.8;">' + subline + '</div></div><button id="update-now" style="background:#070912;color:#f5c842;border:none;padding:8px 14px;border-radius:8px;font-family:Cinzel,serif;font-size:11px;letter-spacing:0.12em;font-weight:700;cursor:pointer;min-width:80px;">UPDATE</button><button id="update-dismiss" style="background:transparent;color:#070912;border:none;padding:4px 8px;cursor:pointer;font-size:20px;line-height:1;">×</button>';
  document.body.appendChild(banner);
  const btn = document.getElementById('update-now');
  const sub = document.getElementById('update-sub');
  const dismiss = document.getElementById('update-dismiss');
  dismiss.onclick = () => {
    banner.remove();
    try {
      localStorage.setItem('updateBannerDismissedAt', String(Date.now()));
      localStorage.setItem('updateBannerDismissedFor', info.version || '');
    } catch {}
  };
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
  // Replay any pending Plaid public_token that failed to exchange last time
  try {
    const pending = localStorage.getItem('plaidPendingToken');
    if (pending) {
      const obj = JSON.parse(pending);
      if (obj && obj.publicToken && (Date.now() - obj.ts < 30 * 60 * 1000)) {
        console.log('Recovering pending Plaid public_token from previous session…');
        supa.functions.invoke('plaid-exchange', { body: { public_token: obj.publicToken, institution: obj.institution || null } })
          .then(({ data, error }) => {
            if (data && data.ok) {
              try { localStorage.removeItem('plaidPendingToken'); } catch {}
              toast('Recovered bank connection: ' + (data.institution_name || ''), 4000);
              loadConnections().then(() => refreshAfterEvent());
            } else {
              console.warn('Recovery exchange failed', error || data);
              try { localStorage.removeItem('plaidPendingToken'); } catch {}
            }
          });
      } else {
        try { localStorage.removeItem('plaidPendingToken'); } catch {}
      }
    }
  } catch (e) { console.warn('plaid recovery failed', e); }
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
  maybeOfferPush();
  // Make sure we know whether the user already has a display_name before deciding
  // which onboarding path to take.
  try { await loadProfile(); } catch (e) { console.warn('loadProfile failed pre-onboarding', e); }
  // Existing users who finished the old (pre-alias) tour but have no display_name
  // get a focused one-step backfill prompt. New users see the full tour.
  if (character && character.onboarding_completed_at && !(profile && profile.display_name)) {
    showNamePickerOnly();
  } else {
    showOnboarding(false);
  }
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
        // Fire-and-forget — issue a Stripe coupon for this new tier (#44)
        issueTierCoupon(name, newRank, 'overall').catch(() => {});
        // Offer to share the win (#12)
        setTimeout(() => shareProgress('Tier Up!', `I just hit ${name} in Game of Life`), 2500);
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
    supa.from('connections').select('id,provider,status,external_id,config,last_sync_at,last_error,created_at').eq('user_id', user.id).neq('status', 'removed'),
    supa.from('plaid_items').select('id,institution_name,institution_id,status,last_sync_at,last_error,created_at').eq('user_id', user.id).neq('status', 'removed')
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


// === Hamburger nav menu + section sheets (Rules / What's New / Connections) ===
function openNavMenu() {
  const el = document.getElementById('nav-menu');
  if (el) el.classList.remove('hidden');
}
function closeNavMenu() {
  const el = document.getElementById('nav-menu');
  if (el) el.classList.add('hidden');
}

function openRulesSheet() {
  const el = document.getElementById('sheet-rules');
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('show');
  el.style.display = '';
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.add('show');
  try { renderRules(); } catch (e) { console.warn('renderRules failed', e); }
}
function closeRulesSheet() {
  const el = document.getElementById('sheet-rules');
  if (el) { el.classList.remove('show'); el.classList.add('hidden'); }
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.remove('show');
}

function openReleasesSheet() {
  const el = document.getElementById('sheet-releases');
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('show');
  el.style.display = '';
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.add('show');
  try { renderReleases(); } catch (e) { console.warn('renderReleases failed', e); }
}
function closeReleasesSheet() {
  const el = document.getElementById('sheet-releases');
  if (el) { el.classList.remove('show'); el.classList.add('hidden'); }
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.remove('show');
}

function openConnectionsSheet() {
  const el = document.getElementById('sheet-connections');
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('show');
  el.style.display = '';
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.add('show');
  try { renderConnections(); } catch (e) { console.warn('renderConnections failed', e); }
}
function closeConnectionsSheet() {
  const el = document.getElementById('sheet-connections');
  if (el) { el.classList.remove('show'); el.classList.add('hidden'); }
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.remove('show');
}

// === Additional Resources: hardcoded recipe library ===
const RECIPES = [
  {
    id: 'gy-power-bowl',
    title: 'Greek Yogurt Power Bowl',
    meal: 'Breakfast',
    calories: 380, protein_g: 38, fiber_g: 11, prep_min: 5,
    description: 'A 5-minute breakfast that hits 38g of protein and over 10g of fiber. Berries, seeds, and high-fiber cereal do all the heavy lifting.',
    ingredients: [
      '1 cup nonfat plain Greek yogurt (0%)',
      '1/2 cup raspberries or mixed berries',
      '1/4 cup high-fiber cereal (e.g., Fiber One Original) OR 1/3 cup raw rolled oats',
      '1 Tbsp chia seeds',
      '1 Tbsp PB2 powdered peanut butter',
      'Optional: drizzle of honey or stevia to taste'
    ],
    steps: [
      'Spoon yogurt into a bowl.',
      'Sprinkle in the chia seeds and PB powder, give it a quick stir so it does not clump.',
      'Top with berries and the high-fiber cereal.',
      'Eat. Refrigerate any leftover for up to 24 hours — the cereal will soften but still tastes good.'
    ],
    subs: [
      'PB2 → 1 Tbsp natural almond butter (adds ~80 cal but more healthy fats).',
      'Raspberries → diced apple + cinnamon, or blackberries (any berry is fine).',
      'Chia → 1 Tbsp ground flaxseed.',
      'Greek yogurt → nonfat cottage cheese (blend for a smoother bowl).',
      'High-fiber cereal → 1/3 cup steel-cut oats cooked overnight in the yogurt.'
    ]
  },
  {
    id: 'tuna-bb-wraps',
    title: 'Spicy Tuna & Black Bean Lettuce Wraps',
    meal: 'Lunch',
    calories: 420, protein_g: 42, fiber_g: 14, prep_min: 10,
    description: 'No cooking. Two cans, a knife, and a spoon. Lean tuna + fiber-heavy black beans wrapped in crunchy romaine.',
    ingredients: [
      '1 can (5 oz) tuna in water, drained',
      '1/2 cup canned black beans, rinsed and drained',
      '2 Tbsp plain nonfat Greek yogurt',
      '1 tsp sriracha (more to taste)',
      '1 tsp lime juice',
      '1/4 ripe avocado, diced',
      '4 large romaine or butter lettuce leaves',
      'Pinch of salt, fresh cracked pepper, optional chopped cilantro'
    ],
    steps: [
      'In a bowl, stir together tuna, black beans, Greek yogurt, sriracha, lime juice, salt, and pepper.',
      'Fold in the diced avocado last so it does not turn to mush.',
      'Spoon the mixture into the lettuce leaves. Top with cilantro.',
      'Eat with hands like a taco. Makes 4 wraps — that is one serving.'
    ],
    subs: [
      'Tuna → canned chicken breast or canned wild salmon.',
      'Black beans → chickpeas (slightly more carb, equally filling).',
      'Romaine → collard green leaves (blanched 30 sec) or cabbage leaves for crunchier wraps.',
      'Avocado → skip and add 1 Tbsp olive oil to the mix; or use 2 Tbsp guacamole.',
      'Sriracha → hot sauce of choice, or 1/4 tsp red pepper flakes.'
    ]
  },
  {
    id: 'chickpea-buddha',
    title: 'Chickpea-Quinoa Buddha Bowl',
    meal: 'Lunch / Dinner',
    calories: 480, protein_g: 32, fiber_g: 16, prep_min: 25,
    description: 'A solid plant-forward meal with crunchy roasted chickpeas, quinoa, and a tahini-lemon dressing. 16g of fiber.',
    ingredients: [
      '3/4 cup cooked quinoa (about 1/4 cup dry)',
      '1/2 cup canned chickpeas, drained and patted dry',
      '1 cup broccoli florets',
      '1/4 cup shelled edamame (frozen, thawed)',
      'Large handful baby spinach',
      'Dressing: 1 Tbsp tahini + 1 Tbsp lemon juice + 1 Tbsp water + 1/4 tsp garlic powder + salt',
      '1 tsp olive oil, salt, smoked paprika, cumin (for roasting)'
    ],
    steps: [
      'Preheat oven to 400°F (200°C). On a sheet pan, toss chickpeas + broccoli with olive oil, salt, paprika, cumin.',
      'Roast 18–20 min until chickpeas are crisp and broccoli is charred at the tips.',
      'While that roasts, cook quinoa (or use leftover). Whisk dressing.',
      'Assemble bowl: spinach base, quinoa, roasted veg, edamame. Drizzle dressing on top.'
    ],
    subs: [
      'Quinoa → farro, brown rice, or barley (cook times vary; check package).',
      'Chickpeas → black beans, lentils, or 4 oz baked tofu cubes.',
      'Broccoli → cauliflower, brussels sprouts, or kale (kale only needs 8 min in the oven).',
      'Tahini → 2 Tbsp Greek yogurt + lemon juice + garlic for a lower-cal dressing.',
      'Edamame → peas or extra chickpeas.'
    ]
  },
  {
    id: 'turkey-chili',
    title: 'Lean Turkey Chili (Meal Prep)',
    meal: 'Dinner',
    calories: 390, protein_g: 38, fiber_g: 13, prep_min: 35,
    description: 'One pot, four servings. Per serving still hits high protein and fiber. Tastes better the next day.',
    ingredients: [
      '1.25 lb 99% lean ground turkey',
      '1 medium onion, chopped',
      '1 red or green bell pepper, chopped',
      '2 cloves garlic, minced',
      '1 can (15 oz) black beans, drained and rinsed',
      '1 can (15 oz) kidney beans, drained and rinsed',
      '1 can (14.5 oz) fire-roasted diced tomatoes',
      '1 can (8 oz) tomato sauce, no sugar added',
      '2 Tbsp chili powder',
      '1 tsp ground cumin',
      '1 tsp smoked paprika',
      '1/2 tsp salt, pepper to taste',
      'Optional: 1 tsp olive oil, chopped cilantro for garnish'
    ],
    steps: [
      'Heat olive oil in a large pot over medium-high. Add onion + bell pepper, cook 4 min.',
      'Add garlic, cook 30 seconds. Push veggies aside and add turkey. Break it up with a spoon and brown 5–6 min.',
      'Stir in chili powder, cumin, paprika, salt, pepper — let bloom 30 seconds.',
      'Add both cans of beans, diced tomatoes (with liquid), and tomato sauce. Stir, bring to a simmer.',
      'Reduce heat, simmer uncovered 20 min, stirring occasionally. Taste and adjust salt.',
      'Divide into 4 containers. Refrigerate up to 4 days; freezes well.'
    ],
    subs: [
      'Turkey → 99% lean ground chicken, OR 1.25 lb extra-firm tofu crumbled (drain well first).',
      'Kidney beans → pinto beans or great northern.',
      'Bell pepper → zucchini (added in last 5 min so it does not turn to mush) or chopped carrot (added with onion).',
      'Fire-roasted tomatoes → regular diced tomatoes + 1/2 tsp extra smoked paprika.',
      'Add 1 cup cooked corn for sweetness (adds ~50 cal/serving).'
    ]
  },
  {
    id: 'cottage-pizza-toast',
    title: 'Cottage Cheese Pizza Toast',
    meal: 'Snack / Lunch',
    calories: 360, protein_g: 35, fiber_g: 10, prep_min: 8,
    description: 'Pizza energy, real protein. Cottage cheese is the unsung hero — melts almost like ricotta but with 2x the protein.',
    ingredients: [
      '2 slices high-fiber bread (e.g., Dave\'s Killer Power Seed, ~110 cal / 5g fiber each)',
      '1/2 cup low-fat 1% cottage cheese',
      '1/3 cup no-sugar-added marinara sauce',
      '4–5 thinly sliced cremini or button mushrooms',
      'Handful baby spinach (about 1/2 cup, packed)',
      '2 Tbsp grated parmesan cheese',
      'Pinch of red pepper flakes, dried oregano',
      'Optional: 1/4 tsp garlic powder'
    ],
    steps: [
      'Toast the bread until lightly golden but still flexible.',
      'Spread marinara over each slice (1–12 Tbsp per slice).',
      'Spoon cottage cheese on top — break it up so it covers evenly.',
      'Layer baby spinach and mushrooms on top.',
      'Sprinkle parmesan, red pepper flakes, oregano, garlic powder.',
      'Broil 3–4 minutes on high, watch closely until cheese bubbles and edges brown. Eat hot.'
    ],
    subs: [
      'Cottage cheese → part-skim ricotta (slightly higher cal) OR Greek yogurt + 1 tsp olive oil.',
      'High-fiber bread → whole wheat English muffin (split) or a low-carb tortilla folded.',
      'Marinara → 2 Tbsp pesto or roasted red pepper spread.',
      'Mushrooms → sundried tomatoes, sliced bell pepper, or thinly sliced zucchini.',
      'Parmesan → nutritional yeast (dairy-free) or a sprinkle of feta.'
    ]
  }
];

function openResourcesSheet() {
  const el = document.getElementById('sheet-resources');
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('show');
  el.style.display = '';
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.add('show');
}
function closeResourcesSheet() {
  const el = document.getElementById('sheet-resources');
  if (el) { el.classList.remove('show'); el.classList.add('hidden'); }
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.remove('show');
}

function openRecipesSheet() {
  const el = document.getElementById('sheet-recipes');
  if (!el) return;
  renderRecipesList();
  el.classList.remove('hidden');
  el.classList.add('show');
  el.style.display = '';
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.add('show');
}
function closeRecipesSheet() {
  const el = document.getElementById('sheet-recipes');
  if (el) { el.classList.remove('show'); el.classList.add('hidden'); }
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.remove('show');
}
function renderRecipesList() {
  const list = document.getElementById('recipes-list');
  if (!list) return;
  list.innerHTML = RECIPES.map((r) => (
    '<button class="recipe-card" type="button" data-recipe-id="' + r.id + '">' +
      '<div class="recipe-card-head">' +
        '<div class="recipe-card-title">' + r.title + '</div>' +
        '<div class="recipe-card-meal">' + r.meal + '</div>' +
      '</div>' +
      '<div style="font-size: 12px; color: var(--muted); line-height: 1.5;">' + r.description + '</div>' +
      '<div class="recipe-card-stats">' +
        '<span class="recipe-card-stat"><b>' + r.calories + '</b> cal</span>' +
        '<span class="recipe-card-stat"><b>' + r.protein_g + 'g</b> protein</span>' +
        '<span class="recipe-card-stat"><b>' + r.fiber_g + 'g</b> fiber</span>' +
        '<span class="recipe-card-stat"><b>' + r.prep_min + ' min</b></span>' +
      '</div>' +
    '</button>'
  )).join('');
  list.querySelectorAll('.recipe-card').forEach((b) => {
    b.addEventListener('click', () => openRecipeDetail(b.dataset.recipeId));
  });
}

function openRecipeDetail(id) {
  const r = RECIPES.find((x) => x.id === id);
  if (!r) return;
  const titleEl = document.getElementById('recipe-detail-title');
  const bodyEl = document.getElementById('recipe-detail-body');
  if (titleEl) titleEl.textContent = r.title;
  if (bodyEl) {
    bodyEl.innerHTML =
      '<div style="font-size: 10px; color: var(--cyan); letter-spacing: 0.16em; text-transform: uppercase; font-weight: 600; margin-bottom: 6px;">' + r.meal + '</div>' +
      '<div style="font-size: 13px; color: var(--text); line-height: 1.6; margin-bottom: 18px;">' + r.description + '</div>' +
      '<div class="recipe-detail-stats">' +
        '<div class="recipe-detail-stat"><div class="recipe-detail-stat-num">' + r.calories + '</div><div class="recipe-detail-stat-label">Cal</div></div>' +
        '<div class="recipe-detail-stat"><div class="recipe-detail-stat-num">' + r.protein_g + 'g</div><div class="recipe-detail-stat-label">Protein</div></div>' +
        '<div class="recipe-detail-stat"><div class="recipe-detail-stat-num">' + r.fiber_g + 'g</div><div class="recipe-detail-stat-label">Fiber</div></div>' +
        '<div class="recipe-detail-stat"><div class="recipe-detail-stat-num">' + r.prep_min + '</div><div class="recipe-detail-stat-label">Min</div></div>' +
      '</div>' +
      '<div class="recipe-section">INGREDIENTS</div>' +
      '<ul class="recipe-list">' + r.ingredients.map((i) => '<li>' + i + '</li>').join('') + '</ul>' +
      '<div class="recipe-section">STEPS</div>' +
      '<ol class="recipe-list">' + r.steps.map((s) => '<li>' + s + '</li>').join('') + '</ol>' +
      '<div class="recipe-section">SUBSTITUTIONS</div>' +
      '<div class="recipe-sub-block">' +
        r.subs.map((s) => '<div style="margin-bottom: 6px;">• ' + s + '</div>').join('') +
      '</div>';
  }
  const el = document.getElementById('sheet-recipe-detail');
  if (el) {
    el.classList.remove('hidden');
    el.classList.add('show');
    el.style.display = '';
  }
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.add('show');
}
function closeRecipeDetail() {
  const el = document.getElementById('sheet-recipe-detail');
  if (el) { el.classList.remove('show'); el.classList.add('hidden'); }
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.remove('show');
}

// === Data export sheet ===
function openExportSheet() {
  const el = document.getElementById('sheet-export');
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('show');
  el.style.display = '';
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.add('show');
  // Refresh the "last export" line from the audit table
  loadLastExportTime();
  // Reset the button state in case the user opens this twice in a row
  const btn = document.getElementById('export-download-btn');
  if (btn) { btn.disabled = false; }
  const label = document.getElementById('export-btn-label');
  if (label) label.textContent = 'Download my data (.json)';
  const msg = document.getElementById('export-msg');
  if (msg) { msg.textContent = ''; msg.style.color = ''; }
}
function closeExportSheet() {
  const el = document.getElementById('sheet-export');
  if (el) { el.classList.remove('show'); el.classList.add('hidden'); }
  const bd = document.getElementById('sheet-backdrop');
  if (bd) bd.classList.remove('show');
}
async function loadLastExportTime() {
  const lineEl = document.getElementById('export-last');
  if (!lineEl || !user) return;
  try {
    const { data } = await supa
      .from('data_exports')
      .select('exported_at')
      .order('exported_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data && data.exported_at) {
      const t = new Date(data.exported_at);
      lineEl.textContent = 'Last export: ' + t.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    } else {
      lineEl.textContent = 'No exports yet.';
    }
  } catch (e) {
    console.warn('loadLastExportTime failed', e);
  }
}
async function downloadExport() {
  if (!user) return;
  const btn = document.getElementById('export-download-btn');
  const label = document.getElementById('export-btn-label');
  const msg = document.getElementById('export-msg');
  if (msg) { msg.textContent = ''; msg.style.color = ''; }
  if (btn) btn.disabled = true;
  if (label) label.textContent = 'Preparing your export…';
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (!session) throw new Error('not_signed_in');
    const resp = await fetch(SUPABASE_URL + '/functions/v1/export-user-data', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + session.access_token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({})
    });
    if (resp.status === 429) {
      const body = await resp.json().catch(() => ({}));
      if (msg) { msg.style.color = 'var(--red)'; msg.textContent = body.message || 'You can export again in 24 hours.'; }
      return;
    }
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.error || ('HTTP ' + resp.status));
    }
    const blob = await resp.blob();
    const sizeKB = Math.max(1, Math.round(blob.size / 1024));
    // Filename comes from Content-Disposition; build a fallback in case the
    // browser doesn't expose the header to fetch().
    const cd = resp.headers.get('Content-Disposition') || '';
    let filename = 'gameoflife-export.json';
    const m = cd.match(/filename="([^"]+)"/);
    if (m) filename = m[1];
    // Trigger the download via a temporary <a>
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 100);
    if (msg) { msg.style.color = 'var(--green)'; msg.textContent = '✓ Downloaded ' + filename + ' (' + sizeKB.toLocaleString() + ' KB)'; }
    if (label) label.textContent = 'Download again';
    // Refresh the "last export" line
    loadLastExportTime();
  } catch (e) {
    if (msg) { msg.style.color = 'var(--red)'; msg.textContent = 'Export failed: ' + (e?.message || e); }
    console.warn('downloadExport failed', e);
    if (label) label.textContent = 'Download my data (.json)';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// === About / Help sheet + feedback submission ===
function openHelpSheet() {
  // Stamp build version into the about line
  const v = document.getElementById('help-build-version');
  if (v) v.textContent = (window.BUILD_VERSION || 'PWA') + (window.BUILD_TIME ? (' (' + new Date(window.BUILD_TIME).toLocaleDateString() + ')') : '');
  // Help sheet is a self-contained dialog (not the multi-form #sheet element).
  // Show it + the backdrop directly.
  const helpEl = document.getElementById('sheet-help');
  const backdrop = document.getElementById('sheet-backdrop');
  if (helpEl) {
    helpEl.classList.remove('hidden');
    helpEl.classList.add('show');
    helpEl.style.display = '';
  }
  if (backdrop) backdrop.classList.add('show');
  // Lazy-load past feedback
  if (user) loadMyFeedback();
}

function closeHelpSheet() {
  const helpEl = document.getElementById('sheet-help');
  const backdrop = document.getElementById('sheet-backdrop');
  if (helpEl) {
    helpEl.classList.remove('show');
    helpEl.classList.add('hidden');
  }
  if (backdrop) backdrop.classList.remove('show');
}

// === Account / Settings sheet ===
let accNameMode = 'alias'; // tracks current selection inside account sheet

function openAccountSheet() {
  const el = document.getElementById('sheet-account');
  const backdrop = document.getElementById('sheet-backdrop');
  if (!el) return;
  el.classList.remove('hidden');
  el.classList.add('show');
  el.style.display = '';
  if (backdrop) backdrop.classList.add('show');
  // Hydrate form fields
  const nameInput = document.getElementById('acc-name-input');
  const emailLabel = document.getElementById('acc-current-email');
  const lbCheck = document.getElementById('acc-global-lb');
  if (nameInput) nameInput.value = (profile && profile.display_name) || '';
  accNameMode = (profile && profile.display_name_is_alias === false) ? 'real' : 'alias';
  applyAccountNameMode();
  if (emailLabel) emailLabel.textContent = (user && user.email) || '—';
  if (lbCheck) lbCheck.checked = !!(profile && profile.show_on_global_leaderboard);
  // Email digest hydration (#45)
  const digestCheck = document.getElementById('acc-email-digests');
  if (digestCheck) digestCheck.checked = !!(profile && profile.email_digests_optin);
  const digestFreq = (profile && profile.email_digests_frequency) || 'daily';
  ['immediate', 'daily', 'weekly'].forEach((f) => {
    document.getElementById('acc-digest-' + f)?.classList.toggle('primary', f === digestFreq);
  });
  // Clear messages
  ['acc-name-msg', 'acc-email-msg', 'acc-pw-msg', 'acc-lb-msg', 'acc-domains-msg', 'acc-digest-msg'].forEach((id) => {
    const m = document.getElementById(id);
    if (m) { m.textContent = ''; m.className = 'auth-msg'; }
  });
  // Clear password fields
  const cur = document.getElementById('acc-cur-pw');
  const nu = document.getElementById('acc-new-pw');
  if (cur) cur.value = '';
  if (nu) nu.value = '';
  const ne = document.getElementById('acc-new-email');
  if (ne) ne.value = '';
  // Load + render custom domains and tier coupons
  loadAndRenderCustomDomains();
  loadAndRenderTierCoupons();
}

function closeAccountSheet() {
  const el = document.getElementById('sheet-account');
  const backdrop = document.getElementById('sheet-backdrop');
  if (el) { el.classList.remove('show'); el.classList.add('hidden'); }
  if (backdrop) backdrop.classList.remove('show');
}

function applyAccountNameMode() {
  const real = document.getElementById('acc-name-tab-real');
  const alias = document.getElementById('acc-name-tab-alias');
  const input = document.getElementById('acc-name-input');
  if (!real || !alias || !input) return;
  if (accNameMode === 'real') {
    real.classList.add('primary'); alias.classList.remove('primary');
    input.placeholder = 'Randy Rockwell';
  } else {
    alias.classList.add('primary'); real.classList.remove('primary');
    input.placeholder = 'ShadowFox42';
  }
  updateAccountNameHint();
}

function updateAccountNameHint() {
  const input = document.getElementById('acc-name-input');
  const hint = document.getElementById('acc-name-hint');
  if (!input || !hint) return;
  const v = input.value.trim();
  if (!v) { hint.textContent = '2–32 characters.'; hint.style.color = '#8b94b8'; return; }
  if (!NAME_RE.test(v)) { hint.textContent = 'Letters, numbers, spaces, hyphens, underscores only.'; hint.style.color = '#ff8a8a'; return; }
  hint.textContent = 'Looks good.'; hint.style.color = '#6ee7a8';
}

async function accountSaveName() {
  if (!user) return;
  const input = document.getElementById('acc-name-input');
  const msg = document.getElementById('acc-name-msg');
  const v = (input?.value || '').trim();
  if (!NAME_RE.test(v)) {
    msg.className = 'auth-msg error';
    msg.textContent = 'Pick a valid name first.';
    return;
  }
  msg.className = 'auth-msg info'; msg.textContent = 'Saving…';
  try {
    const { error } = await supa.from('profiles').upsert({
      user_id: user.id,
      display_name: v,
      display_name_is_alias: accNameMode === 'alias'
    }, { onConflict: 'user_id' });
    if (error) throw error;
    if (!profile) profile = {};
    profile.display_name = v;
    profile.display_name_is_alias = accNameMode === 'alias';
    msg.className = 'auth-msg success'; msg.textContent = 'Name updated.';
  } catch (e) {
    msg.className = 'auth-msg error'; msg.textContent = e.message || 'Save failed.';
  }
}

async function accountSavePassword() {
  if (!user) return;
  const cur = document.getElementById('acc-cur-pw').value;
  const nu = document.getElementById('acc-new-pw').value;
  const msg = document.getElementById('acc-pw-msg');
  if (!cur || cur.length < 6) { msg.className = 'auth-msg error'; msg.textContent = 'Enter your current password.'; return; }
  if (!nu || nu.length < 6) { msg.className = 'auth-msg error'; msg.textContent = 'New password must be at least 6 characters.'; return; }
  if (cur === nu) { msg.className = 'auth-msg error'; msg.textContent = 'New password must differ from current.'; return; }
  msg.className = 'auth-msg info'; msg.textContent = 'Verifying…';
  try {
    // Re-auth as a safety check: sign in with current password silently.
    // Supabase doesn't have a true re-auth API, but signInWithPassword on the
    // already-authenticated user just confirms the credential.
    const { error: reauthErr } = await supa.auth.signInWithPassword({
      email: user.email, password: cur
    });
    if (reauthErr) {
      msg.className = 'auth-msg error';
      msg.textContent = 'Current password is incorrect.';
      return;
    }
    msg.className = 'auth-msg info'; msg.textContent = 'Saving new password…';
    const { error: upErr } = await supa.auth.updateUser({ password: nu });
    if (upErr) throw upErr;
    document.getElementById('acc-cur-pw').value = '';
    document.getElementById('acc-new-pw').value = '';
    msg.className = 'auth-msg success';
    msg.textContent = 'Password updated. You will get a confirmation email at your current address.';
  } catch (e) {
    msg.className = 'auth-msg error';
    msg.textContent = e.message || 'Password change failed.';
  }
}

async function accountSaveEmail() {
  if (!user) return;
  const newEmail = document.getElementById('acc-new-email').value.trim();
  const msg = document.getElementById('acc-email-msg');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(newEmail)) {
    msg.className = 'auth-msg error'; msg.textContent = "That doesn't look like a valid email."; return;
  }
  if (newEmail.toLowerCase() === (user.email || '').toLowerCase()) {
    msg.className = 'auth-msg error'; msg.textContent = "That's already your email."; return;
  }
  msg.className = 'auth-msg info'; msg.textContent = 'Sending verification…';
  try {
    const { error } = await supa.auth.updateUser({ email: newEmail });
    if (error) throw error;
    msg.className = 'auth-msg success';
    msg.textContent = "Check your inbox at " + newEmail + " for a confirmation link. Your email won't change until you click it.";
  } catch (e) {
    msg.className = 'auth-msg error';
    msg.textContent = e.message || 'Email change failed.';
  }
}

async function accountToggleEmailDigests() {
  if (!user) return;
  const check = document.getElementById('acc-email-digests');
  const msg = document.getElementById('acc-digest-msg');
  const newVal = !!check.checked;
  msg.className = 'auth-msg info'; msg.textContent = 'Saving…';
  try {
    const { error } = await supa.from('profiles').upsert({
      user_id: user.id, email_digests_optin: newVal
    }, { onConflict: 'user_id' });
    if (error) throw error;
    if (!profile) profile = {};
    profile.email_digests_optin = newVal;
    msg.className = 'auth-msg success';
    msg.textContent = newVal ? 'Email digests turned on. We will email you at ' + (user.email || 'your address') + '.' : 'Email digests turned off.';
  } catch (e) { check.checked = !newVal; msg.className = 'auth-msg error'; msg.textContent = e.message || 'Could not save.'; }
}

async function accountSetDigestFrequency(freq) {
  if (!user) return;
  const msg = document.getElementById('acc-digest-msg');
  msg.className = 'auth-msg info'; msg.textContent = 'Saving…';
  try {
    const { error } = await supa.from('profiles').upsert({
      user_id: user.id, email_digests_frequency: freq
    }, { onConflict: 'user_id' });
    if (error) throw error;
    if (!profile) profile = {};
    profile.email_digests_frequency = freq;
    ['immediate', 'daily', 'weekly'].forEach((f) => {
      document.getElementById('acc-digest-' + f)?.classList.toggle('primary', f === freq);
    });
    msg.className = 'auth-msg success'; msg.textContent = 'Frequency set to ' + freq + '.';
  } catch (e) { msg.className = 'auth-msg error'; msg.textContent = e.message || 'Could not save.'; }
}

async function accountToggleLeaderboard() {
  if (!user) return;
  const check = document.getElementById('acc-global-lb');
  const msg = document.getElementById('acc-lb-msg');
  const newVal = !!check.checked;
  msg.className = 'auth-msg info'; msg.textContent = 'Saving…';
  try {
    const { error } = await supa.from('profiles').upsert({
      user_id: user.id, show_on_global_leaderboard: newVal
    }, { onConflict: 'user_id' });
    if (error) throw error;
    if (!profile) profile = {};
    profile.show_on_global_leaderboard = newVal;
    msg.className = 'auth-msg success';
    msg.textContent = newVal ? 'You will appear on the global leaderboard.' : 'You are off the global leaderboard.';
  } catch (e) {
    check.checked = !newVal; // revert
    msg.className = 'auth-msg error';
    msg.textContent = e.message || 'Could not save.';
  }
}

// === Custom Life Domains (#43) ===
let customDomains = [];

async function loadAndRenderCustomDomains() {
  if (!user) return;
  try {
    const { data, error } = await supa.from('custom_domain_progress').select('*');
    if (error) {
      // Table may not exist yet (migration not applied). Fail silently.
      console.warn('custom_domain_progress query failed:', error.message);
      customDomains = [];
    } else {
      customDomains = data || [];
    }
    renderCustomDomainsList();
  } catch (e) {
    console.warn('loadAndRenderCustomDomains exception:', e);
  }
}

function renderCustomDomainsList() {
  const list = document.getElementById('acc-domains-list');
  if (!list) return;
  if (!customDomains.length) {
    list.innerHTML = '<div class="empty" style="font-size:13px; color: var(--muted); padding: 8px 0; text-align: center;">No custom domains yet.</div>';
    return;
  }
  list.innerHTML = customDomains.map((d) => {
    const safeLabel = escapeHtml(d.label);
    const safeEmoji = escapeHtml(d.emoji || '⭐');
    const safeColor = (d.color || '#5fc1e8').replace(/[^#0-9a-fA-F]/g, '');
    return `<div class="conn-item" style="display:flex; gap:10px; align-items:center; border-left: 3px solid ${safeColor};">
      <div style="font-size:20px;">${safeEmoji}</div>
      <div class="conn-meta" style="flex:1;">
        <div class="conn-name">${safeLabel}</div>
        <div class="conn-sub">${(d.total_xp || 0).toLocaleString()} XP · ${d.event_count || 0} log${d.event_count === 1 ? '' : 's'}</div>
      </div>
      <button type="button" class="panel-action" data-cd-log="${d.domain_id}" data-cd-slug="${d.slug}" data-cd-label="${safeLabel}" style="padding: 6px 10px; font-size: 12px;">+ Log</button>
      <button type="button" class="panel-action" data-cd-remove="${d.domain_id}" style="padding: 6px 10px; font-size: 12px; color: var(--red); border-color: rgba(255,138,138,0.4);">×</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-cd-remove]').forEach((b) => {
    b.addEventListener('click', () => removeCustomDomain(b.dataset.cdRemove));
  });
  list.querySelectorAll('[data-cd-log]').forEach((b) => {
    b.addEventListener('click', () => logCustomDomainXP(b.dataset.cdSlug, b.dataset.cdLabel));
  });
}

function slugifyDomainLabel(label) {
  return String(label || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 32);
}

async function addCustomDomain(label, color, emoji) {
  if (!user) return;
  const msg = document.getElementById('acc-domains-msg');
  const cleanLabel = String(label || '').trim();
  const cleanColor = /^#[0-9a-fA-F]{6}$/.test(color) ? color : '#5fc1e8';
  const cleanEmoji = (String(emoji || '').trim() || '⭐').slice(0, 8);
  if (!cleanLabel || cleanLabel.length > 40) {
    msg.className = 'auth-msg error'; msg.textContent = 'Label is required (max 40 chars).'; return;
  }
  const slug = slugifyDomainLabel(cleanLabel);
  if (!slug || slug.length < 2) {
    msg.className = 'auth-msg error'; msg.textContent = 'Label needs at least 2 letters/numbers.'; return;
  }
  msg.className = 'auth-msg info'; msg.textContent = 'Adding…';
  try {
    const { error } = await supa.from('custom_domains').insert({
      user_id: user.id, slug, label: cleanLabel, color: cleanColor, emoji: cleanEmoji
    });
    if (error) {
      if (String(error.message).includes('duplicate') || String(error.code) === '23505') {
        msg.className = 'auth-msg error'; msg.textContent = 'You already have a domain with that name.';
      } else throw error;
      return;
    }
    msg.className = 'auth-msg success'; msg.textContent = 'Domain added.';
    document.getElementById('cd-label').value = '';
    document.getElementById('cd-emoji').value = '';
    document.getElementById('cd-color').value = '#5fc1e8';
    await loadAndRenderCustomDomains();
  } catch (e) {
    msg.className = 'auth-msg error'; msg.textContent = e.message || 'Add failed.';
  }
}

async function removeCustomDomain(domainId) {
  if (!user || !domainId) return;
  if (!confirm('Remove this domain? Its XP history will remain in your events log but no longer count toward any level.')) return;
  const msg = document.getElementById('acc-domains-msg');
  msg.className = 'auth-msg info'; msg.textContent = 'Removing…';
  try {
    const { error } = await supa.from('custom_domains').delete().eq('id', domainId);
    if (error) throw error;
    msg.className = 'auth-msg success'; msg.textContent = 'Removed.';
    await loadAndRenderCustomDomains();
  } catch (e) {
    msg.className = 'auth-msg error'; msg.textContent = e.message || 'Remove failed.';
  }
}

async function logCustomDomainXP(slug, label) {
  if (!user || !slug) return;
  const input = window.prompt(`How much XP do you want to log for "${label}"?\n\n(Typical: 5–50 per session)`, '20');
  if (input === null) return;
  const xp = parseInt(input, 10);
  if (isNaN(xp) || xp < 1 || xp > 10000) { toast('Enter a number between 1 and 10000.'); return; }
  const note = window.prompt('Optional note (what did you do?)', '') || '';
  try {
    // insertEvent signature: (kind, source, payload)
    await insertEvent('custom_domain', 'manual', { domain_slug: slug, xp, note });
    toast(`+${xp} XP · ${label}`);
    await loadAndRenderCustomDomains();
  } catch (e) {
    toast('Log failed: ' + (e.message || e));
  }
}

// === Tier Rewards / Coupons (#44) ===
let tierCoupons = [];

async function loadAndRenderTierCoupons() {
  if (!user) return;
  try {
    const { data, error } = await supa.from('tier_coupons')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });
    if (error) {
      console.warn('tier_coupons query failed:', error.message);
      tierCoupons = [];
    } else {
      tierCoupons = data || [];
    }
    renderTierCouponsList();
  } catch (e) {
    console.warn('loadAndRenderTierCoupons exception:', e);
  }
}

function renderTierCouponsList() {
  const list = document.getElementById('acc-coupons-list');
  if (!list) return;
  if (!tierCoupons.length) {
    list.innerHTML = '<div class="empty" style="font-size:13px; color: var(--muted); padding: 8px 0; text-align: center;">Tier up to earn your first reward.</div>';
    return;
  }
  const now = Date.now();
  list.innerHTML = tierCoupons.map((c) => {
    const expired = c.expires_at && new Date(c.expires_at).getTime() < now;
    const used = !!c.redeemed_at;
    let status = 'Active';
    let statusColor = 'var(--green)';
    if (used) { status = 'Used'; statusColor = 'var(--muted)'; }
    else if (expired) { status = 'Expired'; statusColor = 'var(--red)'; }
    return `<div class="conn-item" style="display:flex; gap:10px; align-items:center; ${used || expired ? 'opacity:0.5;' : ''}">
      <div style="font-family: 'Cinzel', serif; color: var(--gold); font-size: 13px; min-width: 70px;">${escapeHtml(c.tier_name)}</div>
      <div class="conn-meta" style="flex:1;">
        <div class="conn-name" style="font-family: 'JetBrains Mono', monospace; font-size: 12px; color: var(--cyan);">${escapeHtml(c.coupon_code || '—')}</div>
        <div class="conn-sub">${c.discount_percent}% off · ${status}</div>
      </div>
      ${(!used && !expired) ? `<button type="button" class="panel-action" data-copy-coupon="${escapeHtml(c.coupon_code || '')}" style="padding: 6px 10px; font-size: 12px;">Copy</button>` : ''}
    </div>`;
  }).join('');
  list.querySelectorAll('[data-copy-coupon]').forEach((b) => {
    b.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(b.dataset.copyCoupon); toast('Coupon copied'); }
      catch { toast(b.dataset.copyCoupon, 5000); }
    });
  });
}

// Called from loadProgress() when a tier-up is detected. Fires the
// create-tier-coupon Edge Function and refreshes the coupons list.
async function issueTierCoupon(tierName, tierRank, scope) {
  if (!user) return;
  try {
    const { data, error } = await supa.functions.invoke('create-tier-coupon', {
      body: { tier_name: tierName, tier_rank: tierRank, scope: scope || 'overall' }
    });
    if (error) { console.warn('create-tier-coupon error:', error); return; }
    if (data && data.newly_issued) {
      toast(`🎟️ Tier reward: ${data.discount_percent}% off — ${data.coupon_code}`, 6000);
      await loadAndRenderTierCoupons();
    }
  } catch (e) {
    console.warn('issueTierCoupon exception:', e);
  }
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
        if (b.newly_defeated) {
          toast('🏆 Boss defeated: ' + b.name, 4000);
          setTimeout(() => shareProgress('Boss defeated', `I just defeated "${b.name}" in Game of Life`), 2000);
        }
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
  if (isAdmin) {
    el.textContent = 'AI · unlimited';
    el.classList.remove('warn', 'empty');
    el.classList.add('unlimited');
    return;
  }
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

  // Admin / owner override — bypass FREE/TRIAL/ACTIVE pill, hide billing buttons
  if (isAdmin) {
    pill.textContent = 'OWNER';
    pill.className = 'acct-status-pill owner';
    if (tierEl) tierEl.textContent = 'ForgePoint Industries — full access';
    if (btn) btn.style.display = 'none';
    if (trialNote) trialNote.textContent = '';
    const refSection = document.getElementById('referral-section');
    if (refSection) refSection.style.display = 'none';
    return;
  }

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

// === Friends + Leaderboards ===
let friendProfiles = {}; // user_id -> { display_name }
let socActiveTab = 'friends';
let lbMetric = 'xp_7d';

async function openSocialSheet() {
  const el = document.getElementById('sheet-social');
  const backdrop = document.getElementById('sheet-backdrop');
  if (!el) return;
  el.classList.remove('hidden'); el.classList.add('show'); el.style.display = '';
  if (backdrop) backdrop.classList.add('show');
  setSocTab(socActiveTab || 'friends');
}

function closeSocialSheet() {
  const el = document.getElementById('sheet-social');
  const backdrop = document.getElementById('sheet-backdrop');
  if (el) { el.classList.remove('show'); el.classList.add('hidden'); }
  if (backdrop) backdrop.classList.remove('show');
}

function setSocTab(tab) {
  socActiveTab = tab;
  document.querySelectorAll('.soc-tab').forEach((b) => {
    b.classList.toggle('primary', b.dataset.socTab === tab);
  });
  document.querySelectorAll('.soc-panel').forEach((p) => { p.style.display = 'none'; });
  const panel = document.getElementById('soc-panel-' + tab);
  if (panel) panel.style.display = '';
  if (tab === 'friends') loadAndRenderFriends();
  if (tab === 'friends-lb') loadAndRenderFriendsLeaderboard();
  if (tab === 'global-lb') loadAndRenderGlobalLeaderboard();
}

async function loadAndRenderFriends() {
  if (!user) return;
  // Pull friendships
  const { data: rows, error } = await supa.from('friendships')
    .select('*')
    .or('user_a.eq.' + user.id + ',user_b.eq.' + user.id)
    .order('created_at', { ascending: false });
  friends = rows || [];
  // Collect counterpart user_ids
  const otherIds = friends.map((f) => f.user_a === user.id ? f.user_b : f.user_a);
  if (otherIds.length) {
    const { data: profs } = await supa.from('profiles')
      .select('user_id, display_name')
      .in('user_id', otherIds);
    friendProfiles = {};
    (profs || []).forEach((p) => { friendProfiles[p.user_id] = p; });
  } else {
    friendProfiles = {};
  }
  renderFriendsAndPending();
}

function renderFriendsAndPending() {
  const pendingList = document.getElementById('pending-list');
  const pendingSection = document.getElementById('pending-section');
  const list = document.getElementById('friends-list');
  if (!list) return;

  const accepted = friends.filter((f) => f.status === 'accepted');
  // Only show incoming pending requests (not ones I sent)
  const pendingIncoming = friends.filter((f) => f.status === 'pending' && f.requested_by && f.requested_by !== user.id);

  if (pendingSection) pendingSection.style.display = pendingIncoming.length ? '' : 'none';
  if (pendingList) {
    pendingList.innerHTML = pendingIncoming.map((f) => {
      const other = f.user_a === user.id ? f.user_b : f.user_a;
      const name = (friendProfiles[other]?.display_name) || 'A new player';
      return `<div class="conn-item" style="display:flex; gap:8px; align-items:center;">
        <div class="conn-icon">${(name[0]||'?').toUpperCase()}</div>
        <div class="conn-meta" style="flex:1;"><div class="conn-name">${escapeHtml(name)}</div><div class="conn-sub">wants to be friends</div></div>
        <button type="button" class="panel-action primary" data-friend-accept="${other}" style="padding: 6px 10px; font-size: 12px;">Accept</button>
        <button type="button" class="panel-action" data-friend-decline="${other}" style="padding: 6px 10px; font-size: 12px;">Decline</button>
      </div>`;
    }).join('');
    pendingList.querySelectorAll('[data-friend-accept]').forEach((b) => b.addEventListener('click', () => respondToRequest(b.dataset.friendAccept, true)));
    pendingList.querySelectorAll('[data-friend-decline]').forEach((b) => b.addEventListener('click', () => respondToRequest(b.dataset.friendDecline, false)));
  }

  if (!accepted.length) {
    list.innerHTML = '<div class="empty" style="font-size:13px; color: var(--muted); padding: 16px 0; text-align: center;">No friends yet.</div>';
    return;
  }
  list.innerHTML = accepted.map((f) => {
    const other = f.user_a === user.id ? f.user_b : f.user_a;
    const name = (friendProfiles[other]?.display_name) || 'Anonymous';
    return `<div class="conn-item" style="display:flex; gap:8px; align-items:center;">
      <div class="conn-icon">${(name[0]||'?').toUpperCase()}</div>
      <div class="conn-meta" style="flex:1;"><div class="conn-name">${escapeHtml(name)}</div><div class="conn-sub">friend</div></div>
      <button type="button" class="panel-action" data-friend-remove="${other}" style="padding: 6px 10px; font-size: 12px;">Remove</button>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-friend-remove]').forEach((b) => b.addEventListener('click', () => removeFriend(b.dataset.friendRemove)));
}

async function respondToRequest(otherUserId, accept) {
  try {
    const { data, error } = await supa.rpc('respond_to_friend_request', {
      other_user_id: otherUserId, accept: accept
    });
    if (error) throw error;
    if (data && data.ok === false) {
      toast('Could not respond: ' + (data.error || 'unknown'));
      return;
    }
    toast(accept ? 'Friend added.' : 'Request declined.');
    await loadAndRenderFriends();
  } catch (e) {
    toast('Error: ' + (e.message || e));
  }
}

async function removeFriend(otherUserId) {
  if (!confirm('Remove this friend?')) return;
  const { error } = await supa.from('friendships')
    .delete()
    .or(`and(user_a.eq.${user.id},user_b.eq.${otherUserId}),and(user_a.eq.${otherUserId},user_b.eq.${user.id})`);
  if (error) { toast('Remove failed: ' + error.message); return; }
  toast('Friend removed.');
  await loadAndRenderFriends();
}

async function addFriendByEmail(email) {
  const msg = document.getElementById('add-friend-msg');
  if (!email) return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    msg.className = 'auth-msg error'; msg.textContent = "That doesn't look like a valid email.";
    return;
  }
  msg.className = 'auth-msg info'; msg.textContent = 'Sending…';
  try {
    const { data, error } = await supa.rpc('send_friend_request', { target_email: email });
    if (error) throw error;
    if (data && data.ok === false) {
      const map = {
        user_not_found: "Nobody with that email is on Game of Life yet — they'd need to sign up first.",
        cannot_add_self: "That's you. Try someone else.",
        already_friends: "You're already friends with them.",
        request_already_pending: 'A request to that user is already pending.',
      };
      msg.className = 'auth-msg error';
      msg.textContent = map[data.error] || ('Error: ' + data.error);
      return;
    }
    msg.className = 'auth-msg success';
    msg.textContent = 'Request sent.';
    document.getElementById('friend-email').value = '';
    await loadAndRenderFriends();
  } catch (e) {
    msg.className = 'auth-msg error';
    msg.textContent = e.message || 'Could not send request.';
  }
}

async function loadAndRenderFriendsLeaderboard() {
  const list = document.getElementById('friends-lb-list');
  if (!list) return;
  list.innerHTML = '<div class="empty" style="font-size:13px; color: var(--muted); padding: 16px 0; text-align: center;">Loading…</div>';
  try {
    const { data, error } = await supa.from('friends_leaderboard').select('*');
    if (error) throw error;
    if (!data || !data.length) {
      list.innerHTML = '<div class="empty" style="font-size:13px; color: var(--muted); padding: 16px 0; text-align: center;">Add a friend to see leaderboards.</div>';
      return;
    }
    // Sort by selected metric
    const sorted = [...data].sort((a, b) => (Number(b[lbMetric]) || 0) - (Number(a[lbMetric]) || 0));
    list.innerHTML = sorted.map((row, i) => renderLbRow(row, i + 1, lbMetric)).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty" style="color: var(--red); padding: 16px 0; text-align: center;">' + escapeHtml(e.message || 'Load failed') + '</div>';
  }
}

async function loadAndRenderGlobalLeaderboard() {
  const list = document.getElementById('global-lb-list');
  const statusEl = document.getElementById('global-lb-status');
  if (!list) return;
  list.innerHTML = '<div class="empty" style="font-size:13px; color: var(--muted); padding: 16px 0; text-align: center;">Loading…</div>';
  // Show note if user hasn't opted in
  if (statusEl) {
    if (!profile?.show_on_global_leaderboard) {
      statusEl.style.display = '';
      statusEl.innerHTML = "You're not on this leaderboard. Opt in from Account → Leaderboards.";
    } else {
      statusEl.style.display = 'none';
    }
  }
  try {
    const { data, error } = await supa.from('global_leaderboard').select('*');
    if (error) throw error;
    if (!data || !data.length) {
      list.innerHTML = '<div class="empty" style="font-size:13px; color: var(--muted); padding: 16px 0; text-align: center;">Nobody opted in yet. Be the first.</div>';
      return;
    }
    list.innerHTML = data.map((row, i) => renderLbRow(row, i + 1, 'xp_7d')).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty" style="color: var(--red); padding: 16px 0; text-align: center;">' + escapeHtml(e.message || 'Load failed') + '</div>';
  }
}

function renderLbRow(row, rank, metric) {
  const isMe = row.user_id === user.id;
  const name = escapeHtml(row.display_name || 'Anonymous');
  let metricLabel = '';
  if (metric === 'xp_7d') metricLabel = (row.xp_7d || 0).toLocaleString() + ' XP';
  else if (metric === 'workouts_7d') metricLabel = (row.workouts_7d || 0) + ' workouts';
  else if (metric === 'workout_streak_current') metricLabel = (row.workout_streak_current || 0) + '-day streak';
  return `<div class="conn-item" style="display:flex; gap:10px; align-items:center; ${isMe ? 'background:rgba(245,200,66,0.08); border-color:rgba(245,200,66,0.4);' : ''}">
    <div style="width:24px; text-align:center; font-family:'Cinzel',serif; color:${rank<=3?'#f5c842':'#8b94b8'}; font-weight:700;">${rank}</div>
    <div class="conn-icon">${(row.display_name||'?')[0].toUpperCase()}</div>
    <div class="conn-meta" style="flex:1;">
      <div class="conn-name">${name}${isMe?' · you':''}</div>
      <div class="conn-sub">Level ${row.overall_level || 1}</div>
    </div>
    <div style="font-family:'JetBrains Mono',monospace; font-size:13px; color:var(--cyan);">${metricLabel}</div>
  </div>`;
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
    for (const d of ['body','mind','money']) {
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
      const isPlaid = c.provider === 'plaid' || c._isPlaid;
      const warn = isPlaid
        ? `Disconnect ${display} from Game of Life?\n\nThis revokes our access to your bank via Plaid and stops the monthly Plaid fee.`
        : `Remove ${display}?`;
      if (!confirm(warn)) return;
      try {
        // Use the plaid-remove Edge Function for ALL connection types so the
        // server can revoke Plaid items cleanly. It also handles IMAP / others.
        const { data: { session } } = await supa.auth.getSession();
        const r = await fetch(SUPABASE_URL + '/functions/v1/plaid-remove', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + session.access_token,
            'apikey': SUPABASE_KEY,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ connection_id: c.id })
        });
        const j = await r.json();
        if (!r.ok || j.error) {
          toast(j.error || 'Remove failed');
        } else {
          toast(isPlaid ? 'Bank disconnected · Plaid subscription stopped' : 'Removed');
        }
      } catch (err) {
        toast('Remove failed: ' + (err?.message || err));
      }
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
    // Track the most recent public_token so a flaky WebView round-trip
    // doesn't lose it (we save it to localStorage as a defensive backup,
    // and the bank-connect UI can recover by replaying it).
    const completeExchange = async (publicToken, metadata) => {
      try {
        toast('Linking ' + (metadata?.institution?.name || 'bank') + '…');
        try { localStorage.setItem('plaidPendingToken', JSON.stringify({ publicToken, institution: metadata?.institution || null, ts: Date.now() })); } catch {}
        const { data: ex, error: exErr } = await supa.functions.invoke('plaid-exchange', {
          body: { public_token: publicToken, institution: metadata?.institution || null }
        });
        if (exErr || !ex?.ok) {
          console.error('plaid-exchange failed', exErr || ex);
          toast('Link failed: ' + (ex?.error || exErr?.message || 'unknown'), 6000);
          return;
        }
        try { localStorage.removeItem('plaidPendingToken'); } catch {}
        toast(`Connected ${ex.institution_name || ''} · ${ex.accounts} accounts. Syncing…`);
        const { data: sync, error: syncErr } = await supa.functions.invoke('plaid-sync', { body: {} });
        if (syncErr) console.error('plaid-sync error', syncErr);
        toast(`+${sync?.txn_added || 0} transactions, ${sync?.balance_updates || 0} balances`, 5000);
        await loadConnections(); await refreshAfterEvent();
      } catch (e) {
        console.error('completeExchange threw', e);
        toast('Exchange failed: ' + (e?.message || e), 6000);
      }
    };

    const handler = Plaid.create({
      token: data.link_token,
      onSuccess: async (publicToken, metadata) => {
        console.log('Plaid onSuccess', { hasToken: !!publicToken, inst: metadata?.institution?.name });
        await completeExchange(publicToken, metadata);
      },
      onExit: (err, metadata) => {
        // err is non-null only when Plaid Link errored out. metadata.status tells
        // us where the user bailed (institution_not_found, etc.).
        if (err) {
          console.warn('Plaid onExit error', err, metadata);
          toast('Plaid: ' + (err.display_message || err.error_message || err.error_code || 'exited'), 5000);
        } else {
          console.log('Plaid onExit (no error)', metadata);
        }
      },
      onEvent: (eventName, metadata) => {
        console.log('Plaid event:', eventName, metadata?.view_name || '');
        // The HANDOFF event fires right before onSuccess. If we see HANDOFF but
        // never onSuccess, that's the Capacitor-WebView postMessage drop.
        if (eventName === 'HANDOFF') console.log('Plaid HANDOFF — onSuccess should fire next');
      }
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
  const today = todayLocalDateStr();
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
// === Onboarding tour ===
let onbStep = 1;
const ONB_TOTAL = 6;
let onbNameMode = 'alias'; // 'real' or 'alias'
let onbNameOnly = false;   // backfill mode — only show step 2

const NAME_RE = /^[A-Za-z0-9 _-]{2,32}$/;

function showOnboarding(forceReplay) {
  // Gate: never re-show after onboarding has been completed unless the user explicitly replays.
  // We check three signals so a flaky network or DB hiccup never re-triggers the tour:
  //   1. character.onboarding_completed_at (DB flag, source of truth)
  //   2. profile.display_name (means name picker was satisfied)
  //   3. localStorage('gol_onboarded') (offline-resilient backup)
  if (!forceReplay) {
    try { if (localStorage.getItem('gol_onboarded') === '1') return; } catch (e) {}
    const dbDone = !!(character && character.onboarding_completed_at);
    const hasName = !!(profile && profile.display_name);
    if (dbDone && hasName) {
      try { localStorage.setItem('gol_onboarded', '1'); } catch (e) {}
      return;
    }
  } else {
    // Replay: clear the local cache so it does not block re-runs.
    try { localStorage.removeItem('gol_onboarded'); } catch (e) {}
  }
  onbNameOnly = false;
  onbStep = 1;
  prefillNameInput();
  renderOnboardingStep();
  const el = document.getElementById('onboarding');
  if (el) el.classList.remove('hidden');
}

// Backfill mode: existing users who finished tour before alias step existed,
// or whose display_name was never set. Show ONLY the name picker.
function showNamePickerOnly() {
  onbNameOnly = true;
  onbStep = 2;
  prefillNameInput();
  renderOnboardingStep();
  const el = document.getElementById('onboarding');
  if (el) el.classList.remove('hidden');
  // Hide skip in backfill mode — name is required
  const skip = document.getElementById('onb-skip');
  if (skip) skip.style.display = 'none';
}

function prefillNameInput() {
  const input = document.getElementById('onb-name-input');
  if (!input) return;
  const existing = (profile && profile.display_name) || '';
  input.value = existing;
  // If user already had a name, default to "real" tab; new users default to "alias"
  onbNameMode = existing && !profile?.display_name_is_alias ? 'real' : 'alias';
  applyNameMode();
}

function applyNameMode() {
  const real = document.getElementById('onb-name-tab-real');
  const alias = document.getElementById('onb-name-tab-alias');
  const input = document.getElementById('onb-name-input');
  if (!real || !alias || !input) return;
  if (onbNameMode === 'real') {
    real.classList.remove('ghost'); real.classList.add('primary');
    alias.classList.remove('primary'); alias.classList.add('ghost');
    input.placeholder = 'Randy Rockwell';
    if (!input.value && user?.email) {
      // Pre-fill from email prefix as a soft suggestion
      const guess = user.email.split('@')[0].replace(/[._-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
      input.value = guess.slice(0, 32);
    }
  } else {
    alias.classList.remove('ghost'); alias.classList.add('primary');
    real.classList.remove('primary'); real.classList.add('ghost');
    input.placeholder = 'ShadowFox42';
  }
  updateNameHint();
  updateNextDisabledForName();
}

function updateNameHint() {
  const input = document.getElementById('onb-name-input');
  const hint = document.getElementById('onb-name-hint');
  if (!input || !hint) return;
  const v = input.value.trim();
  if (!v) {
    hint.textContent = '2–32 characters. Letters, numbers, spaces, hyphens, underscores.';
    hint.style.color = '#8b94b8';
  } else if (!NAME_RE.test(v)) {
    hint.textContent = 'Use only letters, numbers, spaces, hyphens, underscores (2–32 chars).';
    hint.style.color = '#ff8a8a';
  } else {
    hint.textContent = 'Looks good.';
    hint.style.color = '#6ee7a8';
  }
}

function updateNextDisabledForName() {
  const next = document.getElementById('onb-next');
  if (!next) return;
  if (onbStep !== 2) { next.disabled = false; return; }
  const input = document.getElementById('onb-name-input');
  const v = (input?.value || '').trim();
  next.disabled = !NAME_RE.test(v);
}

function renderOnboardingStep() {
  document.querySelectorAll('#onboarding .onb-step').forEach((el) => {
    const n = parseInt(el.dataset.step, 10);
    el.classList.toggle('hidden', n !== onbStep);
  });
  const dots = document.getElementById('onb-dots');
  if (dots) {
    dots.innerHTML = '';
    // In name-only mode, hide dots since there's just one step
    if (onbNameOnly) {
      dots.style.display = 'none';
    } else {
      dots.style.display = '';
      for (let i = 1; i <= ONB_TOTAL; i++) {
        const s = document.createElement('span');
        if (i === onbStep) s.classList.add('on');
        dots.appendChild(s);
      }
    }
  }
  const prev = document.getElementById('onb-prev');
  const next = document.getElementById('onb-next');
  if (prev) prev.disabled = onbStep === 1 || onbNameOnly;
  if (next) {
    if (onbNameOnly) next.textContent = 'Save';
    else next.textContent = (onbStep === ONB_TOTAL) ? "Let's go" : 'Next →';
  }
  updateNextDisabledForName();
}

async function saveDisplayName() {
  if (!user) return false;
  const input = document.getElementById('onb-name-input');
  const v = (input?.value || '').trim();
  if (!NAME_RE.test(v)) return false;
  try {
    const { error } = await supa.from('profiles').upsert({
      user_id: user.id,
      display_name: v,
      display_name_is_alias: onbNameMode === 'alias'
    }, { onConflict: 'user_id' });
    if (error) throw error;
    if (!profile) profile = {};
    profile.display_name = v;
    profile.display_name_is_alias = onbNameMode === 'alias';
    return true;
  } catch (e) {
    console.warn('saveDisplayName failed', e);
    if (typeof toast === 'function') toast("Couldn't save your name — try again");
    return false;
  }
}

async function completeOnboarding() {
  document.getElementById('onboarding')?.classList.add('hidden');
  const skip = document.getElementById('onb-skip');
  if (skip) skip.style.display = '';
  onbNameOnly = false;
  // Write localStorage IMMEDIATELY so a refresh-before-DB-roundtrip doesn't re-show the tour.
  try { localStorage.setItem('gol_onboarded', '1'); } catch (e) {}
  if (user) {
    try {
      await supa.from('characters').update({ onboarding_completed_at: new Date().toISOString() }).eq('user_id', user.id);
      if (character) character.onboarding_completed_at = new Date().toISOString();
    } catch (e) { console.warn('mark onboarding done failed', e); }
  }
}

// Wire onboarding buttons once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
  const next = document.getElementById('onb-next');
  const prev = document.getElementById('onb-prev');
  const skip = document.getElementById('onb-skip');
  const realTab = document.getElementById('onb-name-tab-real');
  const aliasTab = document.getElementById('onb-name-tab-alias');
  const nameInput = document.getElementById('onb-name-input');

  if (realTab) realTab.addEventListener('click', () => { onbNameMode = 'real'; applyNameMode(); });
  if (aliasTab) aliasTab.addEventListener('click', () => { onbNameMode = 'alias'; applyNameMode(); });
  if (nameInput) nameInput.addEventListener('input', () => { updateNameHint(); updateNextDisabledForName(); });

  if (next) next.addEventListener('click', async () => {
    // Step 2 → save the name before advancing or finishing
    if (onbStep === 2) {
      const ok = await saveDisplayName();
      if (!ok) return;
      if (onbNameOnly) { completeOnboarding(); return; }
    }
    if (onbStep < ONB_TOTAL) { onbStep++; renderOnboardingStep(); }
    else completeOnboarding();
  });
  if (prev) prev.addEventListener('click', () => {
    if (onbNameOnly) return;
    if (onbStep > 1) { onbStep--; renderOnboardingStep(); }
  });
  if (skip) skip.addEventListener('click', () => {
    // Don't allow skip if we're on the name step and name isn't set
    if (onbStep === 2 && !NAME_RE.test((nameInput?.value || '').trim())) {
      if (typeof toast === 'function') toast('Pick a name first — you can change it later');
      return;
    }
    completeOnboarding();
  });
});

// Returns YYYY-MM-DD in the user's local timezone (falls back to device TZ)
function todayLocalDateStr() {
  try {
    const tz = (character && character.timezone) || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    // sv-SE locale gives YYYY-MM-DD naturally
    return new Date().toLocaleDateString('sv-SE', { timeZone: tz });
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

async function maybeOfferCheckin() {
  try {
    const today = todayLocalDateStr();
    // 1. Cheap localStorage early-out (submitted or dismissed today on this device)
    const last = localStorage.getItem('lastCheckin');
    if (last === today) return;
    // 2. Authoritative DB check — has the user logged a sleep_score vital today (in their TZ)?
    if (user) {
      const tz = (character && character.timezone) || 'UTC';
      // Pull the most recent sleep_score vital and compare its local date with today
      const { data } = await supa.from('vitals')
        .select('occurred_at')
        .eq('user_id', user.id)
        .eq('kind', 'sleep_score')
        .order('occurred_at', { ascending: false })
        .limit(1);
      if (data && data.length) {
        const lastLocal = new Date(data[0].occurred_at).toLocaleDateString('sv-SE', { timeZone: tz });
        if (lastLocal === today) {
          // Already checked in today — remember so we don't query again this session
          try { localStorage.setItem('lastCheckin', today); } catch {}
          return;
        }
      }
    }
    // 3. Show the sheet, and remember dismissal so swiping it away doesn't re-nag
    setTimeout(() => {
      openSheet('checkin');
      // When the sheet is dismissed (any way other than submit), mark today so we don't pop again.
      // The submit handler already sets lastCheckin; this covers dismissal.
      const sheet = document.getElementById('sheet-checkin');
      if (sheet) {
        const observer = new MutationObserver(() => {
          if (sheet.classList.contains('hidden')) {
            try { localStorage.setItem('lastCheckin', today); } catch {}
            observer.disconnect();
          }
        });
        observer.observe(sheet, { attributes: true, attributeFilter: ['class'] });
      }
    }, 600);
  } catch (e) { console.warn('maybeOfferCheckin error', e); }
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

// Push notifications — supports both Capacitor PushNotifications (FCM on Android)
// and Web Push (PWA / iOS Safari / Chrome). Reads `kind` so the server can pick
// the right delivery channel later.
const VAPID_PUBLIC = 'BLdzQLOE0D2lT0i0JlVYku3cv-jxEbUSF1G1kV8l5jUZp6Hhxg1nhXC3ouM1NS0HmVwDXEINYTtfY7NVdB4tqWw';
function urlBase64ToUint8Array(b64) {
  const padding = '='.repeat((4 - b64.length % 4) % 4);
  const b = (b64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function pushPlatform() {
  if (window.Capacitor?.getPlatform) {
    try { return window.Capacitor.getPlatform(); } catch {}
  }
  if (/Android/.test(navigator.userAgent)) return 'android-pwa';
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return 'ios-pwa';
  return 'web';
}

// NOTE: We deliberately do NOT use @capacitor/push-notifications. That plugin
// requires Firebase Cloud Messaging to be configured (google-services.json,
// google-services Gradle plugin). Without Firebase, calling .register() crashes
// the entire APK with "Default FirebaseApp is not initialized". We rely on the
// standard Web Push API, which works in modern Android System WebView via the
// service worker — no Firebase needed.
async function enablePushWeb() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    // Web Push not supported. Try Web Push subscribe anyway — and on failure offer ntfy.sh.
    return enablePushNtfy();
  }
  const reg = await navigator.serviceWorker.ready;
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') { toast('Notifications declined'); return; }
  let sub = null;
  try {
    sub = await reg.pushManager.getSubscription();
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC) });
  } catch (e) {
    // pushManager.subscribe throws AbortError on GrapheneOS without Google services
    console.warn('Web Push subscribe failed, falling back to ntfy:', e?.message || e);
    return enablePushNtfy();
  }
  if (!sub) return enablePushNtfy();
  const j = sub.toJSON();
  const { error } = await supa.from('push_subscriptions').upsert({
    user_id: user.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth,
    kind: 'web_push', platform: pushPlatform(),
    user_agent: navigator.userAgent.slice(0, 200)
  }, { onConflict: 'user_id,endpoint' });
  if (error) { toast('Save failed: ' + error.message); return; }
  toast('Notifications enabled. Sending test…');
  try { localStorage.setItem('pushEnabled', '1'); } catch {}
  try { await supa.functions.invoke('send-push', { body: { title: 'Game of Life connected', body: 'Push notifications are live.', url: '/' } }); } catch {}
}

// Custom modal for ntfy setup. Native confirm() renders text as non-selectable —
// users can\'t copy the topic, and characters like lowercase l / uppercase I / lowercase i
// are indistinguishable. This modal shows the topic in a monospace, selectable code box
// with a one-tap Copy button.
function showNtfyTopicModal(topic) {
  return new Promise((resolve) => {
    // Remove any stale instance
    const stale = document.getElementById('ntfy-modal');
    if (stale) stale.remove();

    const wrap = document.createElement('div');
    wrap.id = 'ntfy-modal';
    wrap.style.cssText = 'position:fixed; inset:0; z-index:9997; background:rgba(7,9,18,0.85); backdrop-filter:blur(6px); display:flex; align-items:center; justify-content:center; padding:20px; padding-top:max(20px, env(safe-area-inset-top)); padding-bottom:max(20px, env(safe-area-inset-bottom)); font-family:Inter,system-ui,sans-serif; color:#e8eaef;';

    const safeTopic = topic.replace(/[&<>"\']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
    wrap.innerHTML = (
      '<div style="background:linear-gradient(180deg,#11162a,#0a0e1a); border:1px solid rgba(245,200,66,0.3); border-radius:14px; padding:22px 20px; max-width:440px; width:100%; max-height:calc(100vh - 40px); overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.7);">' +
        '<div style="font-family:\'Cinzel\', serif; font-size:14px; letter-spacing:0.16em; color:#f5c842; margin-bottom:6px;">PUSH SETUP</div>' +
        '<h3 style="margin:0 0 12px; font-size:18px; color:#e8eaef;">Standard push not available</h3>' +
        '<p style="font-size:13px; color:#a4adc4; line-height:1.55; margin:0 0 14px;">We\'ll use <b>ntfy.sh</b> instead — a free, open push service that works without Google Play Services.</p>' +

        '<div style="font-family:\'Cinzel\', serif; font-size:11px; letter-spacing:0.16em; color:#f5c842; margin:18px 0 8px;">YOUR TOPIC NAME</div>' +
        '<div style="font-size:11px; color:#8b94b8; margin-bottom:8px; line-height:1.5;">Tap inside to select, or use the button to copy.</div>' +
        '<div style="display:flex; gap:8px; align-items:stretch;">' +
          '<input type="text" id="ntfy-topic-text" value="' + safeTopic + '" readonly ' +
            'style="flex:1; min-width:0; padding:12px 14px; border-radius:8px; border:1px solid rgba(245,200,66,0.45); background:rgba(7,9,18,0.7); color:#f5c842; ' +
            'font-family:\'JetBrains Mono\', \'Courier New\', monospace; font-size:14px; letter-spacing:0.05em; ' +
            'box-sizing:border-box; -webkit-user-select:all; user-select:all;" />' +
          '<button type="button" id="ntfy-copy-btn" ' +
            'style="background:linear-gradient(135deg,#f5c842,#b89531); color:#070912; border:none; padding:0 16px; border-radius:8px; ' +
            'font-family:\'Cinzel\',serif; font-size:11px; letter-spacing:0.14em; font-weight:700; cursor:pointer; white-space:nowrap;">COPY</button>' +
        '</div>' +
        '<div id="ntfy-copy-msg" style="font-size:11px; color:#6ee7a8; margin-top:6px; min-height:14px;"></div>' +

        '<div style="font-family:\'Cinzel\', serif; font-size:11px; letter-spacing:0.16em; color:#f5c842; margin:22px 0 8px;">STEPS</div>' +
        '<ol style="margin:0; padding-left:20px; font-size:13px; line-height:1.7; color:#e8eaef;">' +
          '<li>Install <b>ntfy</b> from <b>F-Droid</b> (or the Play Store)</li>' +
          '<li>Open it, tap <b>+</b>, choose <b>Subscribe to topic</b></li>' +
          '<li>Paste the topic name (use the COPY button above)</li>' +
          '<li>Leave <b>Use another server</b> unchecked</li>' +
          '<li>Come back here and tap CONTINUE — we\'ll send a test in 5 sec</li>' +
        '</ol>' +

        '<div style="display:flex; gap:8px; margin-top:24px;">' +
          '<button type="button" id="ntfy-cancel-btn" ' +
            'style="flex:1; background:transparent; color:#a4adc4; border:1px solid rgba(255,255,255,0.15); padding:12px; border-radius:8px; ' +
            'font-family:\'Cinzel\',serif; font-size:12px; letter-spacing:0.14em; font-weight:600; cursor:pointer;">CANCEL</button>' +
          '<button type="button" id="ntfy-continue-btn" ' +
            'style="flex:2; background:linear-gradient(135deg,#5fc1e8,#2d7ba3); color:#070912; border:none; padding:12px; border-radius:8px; ' +
            'font-family:\'Cinzel\',serif; font-size:12px; letter-spacing:0.14em; font-weight:700; cursor:pointer;">CONTINUE</button>' +
        '</div>' +
      '</div>'
    );
    document.body.appendChild(wrap);

    const topicEl = wrap.querySelector('#ntfy-topic-text');
    const copyBtn = wrap.querySelector('#ntfy-copy-btn');
    const copyMsg = wrap.querySelector('#ntfy-copy-msg');
    const cancelBtn = wrap.querySelector('#ntfy-cancel-btn');
    const continueBtn = wrap.querySelector('#ntfy-continue-btn');

    // Tapping the field selects all
    topicEl.addEventListener('focus', () => topicEl.select());
    topicEl.addEventListener('click', () => topicEl.select());

    copyBtn.addEventListener('click', async () => {
      try {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          await navigator.clipboard.writeText(topic);
        } else {
          // Fallback for old WebViews
          topicEl.select();
          document.execCommand('copy');
        }
        copyMsg.textContent = '✓ Copied — paste it into the ntfy app';
        copyBtn.textContent = 'COPIED';
        setTimeout(() => { copyBtn.textContent = 'COPY'; copyMsg.textContent = ''; }, 2500);
      } catch (e) {
        copyMsg.style.color = '#e74c3c';
        copyMsg.textContent = 'Copy failed — long-press the field to select';
      }
    });

    const cleanup = (result) => {
      try { wrap.remove(); } catch {}
      resolve(result);
    };
    cancelBtn.addEventListener('click', () => cleanup(false));
    continueBtn.addEventListener('click', () => cleanup(true));
  });
}

// ntfy.sh fallback for devices without Web Push (GrapheneOS, work-locked, etc.)
// User installs ntfy from F-Droid (or any UnifiedPush client), creates a topic,
// and we route their notifications via ntfy.sh instead of Web Push.
async function enablePushNtfy() {
  if (!user) return;
  let existingTopic = null;
  try {
    const { data } = await supa.from('push_subscriptions')
      .select('endpoint')
      .eq('user_id', user.id)
      .eq('kind', 'ntfy')
      .maybeSingle();
    if (data && data.endpoint) existingTopic = data.endpoint.replace('https://ntfy.sh/', '');
  } catch {}
  const topic = existingTopic || ('gol-' + Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 10));
  const endpoint = 'https://ntfy.sh/' + topic;
  const proceed = await showNtfyTopicModal(topic);
  if (!proceed) return;
  const { error } = await supa.from('push_subscriptions').upsert({
    user_id: user.id, endpoint, p256dh: null, auth: null,
    kind: 'ntfy', platform: pushPlatform(),
    user_agent: navigator.userAgent.slice(0, 200)
  }, { onConflict: 'user_id,endpoint' });
  if (error) { toast('Save failed: ' + error.message); return; }
  try { localStorage.setItem('pushEnabled', '1'); } catch {}
  toast('ntfy topic saved: ' + topic + '. Subscribe in the ntfy app now — sending test in 5 sec…', 8000);
  setTimeout(async () => {
    try {
      await supa.functions.invoke('send-push-ntfy', { body: { title: 'Game of Life connected (ntfy)', body: 'Push via ntfy.sh is live.', url: '/' } });
    } catch (e) { console.warn('test send-push failed', e); }
  }, 5000);
}

async function enablePush() {
  // Standard Web Push first, with automatic ntfy.sh fallback on failure.
  await enablePushWeb();
}

$('enable-push-btn').addEventListener('click', enablePush);

// First-launch prompt — appears once per device until the user enables or dismisses.
function maybeOfferPush() {
  try {
    if (localStorage.getItem('pushEnabled') === '1') return;
    if (localStorage.getItem('pushDismissed') === '1') return;
    // Don't bug iOS PWA users who aren't in standalone (Web Push only works there)
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isStandalone = (window.navigator.standalone === true) || (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
    if (isIOS && !isStandalone && !(window.Capacitor)) return;
    // Defer to give the UI a chance to render
    setTimeout(() => {
      if (document.getElementById('push-prompt')) return;
      const banner = document.createElement('div');
      banner.id = 'push-prompt';
      banner.style.cssText = 'position:fixed; left:12px; right:12px; bottom:calc(12px + env(safe-area-inset-bottom)); z-index:9996; background:linear-gradient(135deg,#1a1f2e,#232a3e); border:1px solid rgba(95,193,232,0.4); border-radius:14px; padding:14px 16px; box-shadow:0 10px 40px rgba(0,0,0,0.5); font-family:Inter,system-ui,sans-serif; color:#e8eaef; display:flex; align-items:center; gap:12px;';
      banner.innerHTML = '<div style="font-size:24px;">🔔</div><div style="flex:1;min-width:0;"><div style="font-size:13px; font-weight:700; color:#5fc1e8; letter-spacing:0.04em;">Turn on reminders</div><div style="font-size:11px; color:#a4adc4; margin-top:3px; line-height:1.4;">Streak warnings · boss defeats · daily check-in nudges. Nothing else.</div></div><button id="push-prompt-enable" type="button" style="background:linear-gradient(135deg,#5fc1e8,#2d7ba3); color:#070912; border:none; padding:8px 14px; border-radius:8px; font-family:Cinzel,serif; font-size:11px; letter-spacing:0.12em; font-weight:700; cursor:pointer; white-space:nowrap;">ENABLE</button><button id="push-prompt-dismiss" type="button" aria-label="Dismiss" style="background:transparent; border:none; color:#8b94b8; font-size:22px; line-height:1; cursor:pointer; padding:0 4px;">×</button>';
      document.body.appendChild(banner);
      document.getElementById('push-prompt-enable').addEventListener('click', async () => {
        banner.remove();
        await enablePush();
      });
      document.getElementById('push-prompt-dismiss').addEventListener('click', () => {
        banner.remove();
        try { localStorage.setItem('pushDismissed', '1'); } catch {}
      });
    }, 4000);
  } catch (e) { console.warn('maybeOfferPush failed', e); }
}


// Legacy profile/friends handlers — replaced by the Account sheet (#sheet-account)
// and Social sheet (#sheet-social). Kept as no-op for safety; elements don't exist.

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
  // === Per-domain levels toggle (Body / Mind / Money panel under XP bar) ===
  const domToggle = document.getElementById('domains-toggle');
  const domPanel = document.getElementById('domains-panel');
  const domLabel = document.getElementById('domains-toggle-label');
  const domIcon = document.getElementById('domains-toggle-icon');
  if (domToggle && domPanel) {
    domToggle.addEventListener('click', () => {
      domainsExpanded = !domainsExpanded;
      domPanel.style.display = domainsExpanded ? '' : 'none';
      if (domLabel) domLabel.textContent = domainsExpanded ? 'Hide per-domain levels' : 'Show per-domain levels';
      if (domIcon) domIcon.textContent = domainsExpanded ? '▴' : '▾';
    });
  }

  // === Hamburger menu wiring ===
  const menuBtn = document.getElementById('menu-btn');
  if (menuBtn) menuBtn.addEventListener('click', openNavMenu);
  const navCloseBtn = document.getElementById('nav-menu-close');
  if (navCloseBtn) navCloseBtn.addEventListener('click', closeNavMenu);

  // Each nav-menu-item routes to its target sheet
  document.querySelectorAll('.nav-menu-item').forEach((b) => {
    b.addEventListener('click', () => {
      const target = b.dataset.nav;
      closeNavMenu();
      switch (target) {
        case 'history': openHistory(); break;
        case 'social': openSocialSheet(); break;
        case 'rules': openRulesSheet(); break;
        case 'releases': openReleasesSheet(); break;
        case 'connections': openConnectionsSheet(); break;
        case 'account': openAccountSheet(); break;
        case 'resources': openResourcesSheet(); break;
        case 'export': openExportSheet(); break;
        case 'help': openHelpSheet(); break;
      }
    });
  });

  // Wire close buttons inside each new sheet
  const rulesSheet = document.getElementById('sheet-rules');
  if (rulesSheet) {
    rulesSheet.querySelectorAll('[data-close], .sheet-close').forEach((b) => b.addEventListener('click', closeRulesSheet));
  }
  const releasesSheet = document.getElementById('sheet-releases');
  if (releasesSheet) {
    releasesSheet.querySelectorAll('[data-close], .sheet-close').forEach((b) => b.addEventListener('click', closeReleasesSheet));
  }
  const connSheet = document.getElementById('sheet-connections');
  if (connSheet) {
    connSheet.querySelectorAll('[data-close], .sheet-close').forEach((b) => b.addEventListener('click', closeConnectionsSheet));
  }

  // Additional Resources hub: close + clicking a hub card
  const resourcesSheet = document.getElementById('sheet-resources');
  if (resourcesSheet) {
    resourcesSheet.querySelectorAll('[data-close], .sheet-close').forEach((b) => b.addEventListener('click', closeResourcesSheet));
    resourcesSheet.querySelectorAll('.resource-hub-card').forEach((c) => {
      c.addEventListener('click', () => {
        const target = c.dataset.resource;
        closeResourcesSheet();
        if (target === 'recipes') openRecipesSheet();
      });
    });
  }
  // Recipes list: close + back to resources
  const recipesSheet = document.getElementById('sheet-recipes');
  if (recipesSheet) {
    recipesSheet.querySelectorAll('[data-close], .sheet-close').forEach((b) => b.addEventListener('click', closeRecipesSheet));
    const backBtn = document.getElementById('recipes-back-btn');
    if (backBtn) backBtn.addEventListener('click', () => { closeRecipesSheet(); openResourcesSheet(); });
  }
  // Export sheet: close button + download click
  const exportSheet = document.getElementById('sheet-export');
  if (exportSheet) {
    exportSheet.querySelectorAll('[data-close], .sheet-close').forEach((b) => b.addEventListener('click', closeExportSheet));
  }
  const exportBtn = document.getElementById('export-download-btn');
  if (exportBtn) exportBtn.addEventListener('click', downloadExport);

  // Recipe detail: close + back to recipes list
  const recipeDetailSheet = document.getElementById('sheet-recipe-detail');
  if (recipeDetailSheet) {
    recipeDetailSheet.querySelectorAll('[data-close], .sheet-close').forEach((b) => b.addEventListener('click', closeRecipeDetail));
    const backBtn = document.getElementById('recipe-detail-back-btn');
    if (backBtn) backBtn.addEventListener('click', () => { closeRecipeDetail(); openRecipesSheet(); });
  }

  // History sheet open + close + tab switching
  const historyBtn = document.getElementById('history-btn');
  if (historyBtn) historyBtn.addEventListener('click', openHistory);
  const historyCloseBtn = document.getElementById('history-close');
  if (historyCloseBtn) historyCloseBtn.addEventListener('click', closeHistory);
  document.querySelectorAll('.history-tab').forEach((t) => {
    t.addEventListener('click', () => {
      document.querySelectorAll('.history-tab').forEach((x) => x.classList.remove('active'));
      t.classList.add('active');
      historyTab = t.dataset.htab;
      renderHistory();
    });
  });

  // About / Help sheet open button
  const helpBtn = document.getElementById('help-btn');
  if (helpBtn) helpBtn.addEventListener('click', openHelpSheet);

  // Social sheet open button + handlers
  const socialBtn = document.getElementById('social-btn');
  if (socialBtn) socialBtn.addEventListener('click', openSocialSheet);

  const socialEl = document.getElementById('sheet-social');
  if (socialEl) {
    socialEl.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeSocialSheet));
    socialEl.querySelectorAll('.sheet-close').forEach((b) => b.addEventListener('click', closeSocialSheet));
    socialEl.querySelectorAll('.soc-tab').forEach((b) => {
      b.addEventListener('click', () => setSocTab(b.dataset.socTab));
    });
    socialEl.querySelectorAll('.lb-metric').forEach((b) => {
      b.addEventListener('click', () => {
        lbMetric = b.dataset.metric;
        socialEl.querySelectorAll('.lb-metric').forEach((x) => x.classList.toggle('primary', x === b));
        loadAndRenderFriendsLeaderboard();
      });
    });
    const addForm = document.getElementById('form-add-friend');
    if (addForm) addForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const email = document.getElementById('friend-email').value.trim();
      addFriendByEmail(email);
    });
  }

  // Account sheet open button + handlers
  const accountBtn = document.getElementById('account-btn');
  if (accountBtn) accountBtn.addEventListener('click', openAccountSheet);

  const accountEl = document.getElementById('sheet-account');
  if (accountEl) {
    accountEl.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', closeAccountSheet));
    accountEl.querySelectorAll('.sheet-close').forEach((b) => b.addEventListener('click', closeAccountSheet));

    document.getElementById('acc-name-tab-real')?.addEventListener('click', () => { accNameMode = 'real'; applyAccountNameMode(); });
    document.getElementById('acc-name-tab-alias')?.addEventListener('click', () => { accNameMode = 'alias'; applyAccountNameMode(); });
    document.getElementById('acc-name-input')?.addEventListener('input', updateAccountNameHint);

    document.getElementById('acc-name-save')?.addEventListener('click', accountSaveName);
    document.getElementById('acc-email-save')?.addEventListener('click', accountSaveEmail);
    document.getElementById('acc-pw-save')?.addEventListener('click', accountSavePassword);
    document.getElementById('acc-global-lb')?.addEventListener('change', accountToggleLeaderboard);

    // Email digests (#45)
    document.getElementById('acc-email-digests')?.addEventListener('change', accountToggleEmailDigests);
    document.getElementById('acc-digest-immediate')?.addEventListener('click', () => accountSetDigestFrequency('immediate'));
    document.getElementById('acc-digest-daily')?.addEventListener('click', () => accountSetDigestFrequency('daily'));
    document.getElementById('acc-digest-weekly')?.addEventListener('click', () => accountSetDigestFrequency('weekly'));

    // Custom domains add form (#43)
    const addDomainForm = document.getElementById('form-add-custom-domain');
    if (addDomainForm) addDomainForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const label = document.getElementById('cd-label').value;
      const color = document.getElementById('cd-color').value;
      const emoji = document.getElementById('cd-emoji').value;
      addCustomDomain(label, color, emoji);
    });

    document.getElementById('acc-signout-btn')?.addEventListener('click', async () => {
      closeAccountSheet();
      document.getElementById('logout-btn')?.click();
    });
  }

  // Close handlers for the help sheet
  const helpSheetEl = document.getElementById('sheet-help');
  if (helpSheetEl) {
    helpSheetEl.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', closeHelpSheet));
    helpSheetEl.querySelectorAll('.sheet-close').forEach(b => b.addEventListener('click', closeHelpSheet));
  }
  document.getElementById('sheet-backdrop')?.addEventListener('click', () => {
    if (helpSheetEl && helpSheetEl.classList.contains('show')) closeHelpSheet();
    if (accountEl && accountEl.classList.contains('show')) closeAccountSheet();
    if (socialEl && socialEl.classList.contains('show')) closeSocialSheet();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (helpSheetEl && helpSheetEl.classList.contains('show')) closeHelpSheet();
    if (accountEl && accountEl.classList.contains('show')) closeAccountSheet();
    if (socialEl && socialEl.classList.contains('show')) closeSocialSheet();
  });

  const helpShare = document.getElementById('help-share-btn');
  if (helpShare) helpShare.addEventListener('click', () => shareApp());

  const helpReplay = document.getElementById('help-replay-tour');
  if (helpReplay) helpReplay.addEventListener('click', () => {
    closeHelpSheet();
    setTimeout(() => showOnboarding(true), 200);
  });

  const fbForm = document.getElementById('form-feedback');
  if (fbForm) fbForm.addEventListener('submit', submitFeedback);
});

// Boot
(async () => {
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (session) await onSignedIn(session.user);
    else { hide($('loading')); show($('auth-screen')); checkForAppUpdates(); }
  } catch (e) { surfaceFatal(e?.message || String(e), e?.stack); }
})();

// === Service-worker update flow (Claude-style) ===
function showSwUpdateBanner(waitingSw) {
  if (document.getElementById('update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:linear-gradient(135deg,#f5c842,#b89531);color:#070912;padding:calc(12px + env(safe-area-inset-top, 0px)) 16px 12px 16px;display:flex;align-items:center;gap:12px;box-shadow:0 6px 24px rgba(0,0,0,0.55);font-family:Inter,system-ui,sans-serif;border-bottom:1px solid rgba(0,0,0,0.2);';
  banner.innerHTML = '<div style="flex:1;font-weight:600;font-size:13px;">New version of Game of Life is ready.</div><button id="update-apply-btn" style="background:#070912;color:#f5c842;border:none;padding:8px 14px;border-radius:6px;font-weight:700;cursor:pointer;font-size:12px;">Apply</button><button id="update-dismiss-btn" style="background:transparent;color:#070912;border:none;font-size:18px;cursor:pointer;padding:4px 6px;">\u00d7</button>';
  document.body.appendChild(banner);
  document.getElementById('update-apply-btn').addEventListener('click', () => {
    if (waitingSw && waitingSw.postMessage) waitingSw.postMessage({ type: 'SKIP_WAITING' });
    navigator.serviceWorker.addEventListener('controllerchange', () => window.location.reload(), { once: true });
  });
  document.getElementById('update-dismiss-btn').addEventListener('click', () => {
    banner.remove();
    try { localStorage.setItem('swUpdateDismissedAt', String(Date.now())); } catch {}
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    try {
      navigator.serviceWorker.register('/sw.js').then((reg) => {
        reg.addEventListener('updatefound', () => {
          const sw = reg.installing;
          if (!sw) return;
          sw.addEventListener('statechange', () => {
            if (sw.state === 'installed' && navigator.serviceWorker.controller) {
              const dismissedAt = parseInt(localStorage.getItem('swUpdateDismissedAt') || '0', 10);
              if (!dismissedAt || (Date.now() - dismissedAt) > 12 * 3600 * 1000) {
                showSwUpdateBanner(sw);
              }
            }
          });
        });
      });
    } catch (e) { console.warn('SW register failed', e); }
  });
}
