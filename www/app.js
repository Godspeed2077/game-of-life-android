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
let balances = [];
let rules = [];
let releases = [];
let isAdmin = false;
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

async function onSignedIn(u) {
  user = u;
  hide($('auth-screen'));
  hide($('loading'));
  show($('main-app'));
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
    loadReleases(), checkAdmin()
  ]);
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

async function toggleQuest(q) {
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
  await Promise.all([loadCharacter(), loadSummary(), loadStreaks(), loadTxns7(), loadBalances()]);
  render();
}

async function logMeal(description, photoDataUrl) {
  let macros = null;
  try {
    const { data } = await supa.functions.invoke('parse-meal', { body: { description, photo: photoDataUrl || null } });
    if (data && (data.calories || data.protein_g)) macros = data;
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
  toast(`+${type} · ${durationMin} min`);
  await refreshAfterEvent();
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
  const titles = { meal: 'Log Meal', workout: 'Log Workout', money: 'Log Money', email: 'Connect Email Account', boss: 'New Boss', checkin: 'Day Start', rule: 'New Rule', release: 'New Release' };
  $('sheet-title').textContent = titles[kind] || 'Log';
  ['meal','workout','money','email','boss','checkin','rule','release'].forEach(k => {
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
  renderConnections();
  // Character
  $('char-name').value = character.name || '';
  $('char-class').value = character.class || '';
  $('char-level').textContent = character.level;
  $('xp-current').textContent = character.xp;
  $('xp-next').textContent = character.xp_to_next;
  $('xp-fill').style.width = Math.min(100, (character.xp / Math.max(1, character.xp_to_next)) * 100) + '%';
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
    filtered.sort((a,b) => (a.status === b.status ? 0 : a.status === 'active' ? -1 : 1));
    for (const q of filtered) {
      const el = document.createElement('div');
      el.className = `quest-item type-${q.type} ${q.status === 'completed' ? 'completed' : ''}`;
      el.innerHTML = `
        <div class="quest-check"></div>
        <div class="quest-body">
          <div class="quest-title"></div>
          <div class="quest-meta"><span class="quest-xp">+${q.xp_reward} XP</span>${q.completed_at ? ' · done ' + relTime(q.completed_at) : ''}</div>
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
    el.innerHTML = `
      <div class="boss-head"><div class="boss-name"></div><div class="boss-reward">+${b.xp_reward} XP</div></div>
      <div class="boss-bar-wrap"><div class="boss-bar" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="boss-meta">
        <div class="boss-hp">${fmtHp(b.hp_current, b.hp_unit)} / ${fmtHp(b.hp_total, b.hp_unit)} (${pct.toFixed(0)}%)</div>
        <div class="boss-actions">
          ${b.status === 'active' ? `<button class="boss-action" data-act="add">+ HP</button>` : ''}
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
      const { data } = await supa.functions.invoke('parse-workout', { body: { description: desc, photo: workoutMedia.photo || null } });
      if (data) {
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
      const { data } = await supa.functions.invoke('sync-imap', { body: {} });
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
$('form-boss').addEventListener('submit', async (e) => {
  e.preventDefault();
  const name = $('boss-name').value.trim();
  const desc = $('boss-desc').value.trim() || null;
  const hp = parseFloat($('boss-hp').value);
  const unit = $('boss-unit').value;
  const xp = parseInt($('boss-xp').value, 10) || 500;
  if (!name || !hp) return;
  closeSheet();
  await supa.from('bosses').insert({ user_id: user.id, name, description: desc, hp_total: hp, hp_unit: unit, xp_reward: xp });
  toast('Boss added: ' + name);
  await loadBosses(); renderBosses();
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
    const { data, error } = await supa.functions.invoke('generate-side-quests', { body: {} });
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

// Collapsible toggles
document.querySelectorAll('[data-toggle]').forEach(b => {
  b.addEventListener('click', () => document.getElementById(b.dataset.toggle).classList.toggle('collapsed'));
});

// Boot
(async () => {
  try {
    const { data: { session } } = await supa.auth.getSession();
    if (session) await onSignedIn(session.user);
    else { hide($('loading')); show($('auth-screen')); }
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
