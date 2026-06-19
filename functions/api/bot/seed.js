// POST /api/bot/seed
// One-time bot seeding endpoint. Call with ?start=0&count=50, then ?start=50&count=50, etc.
// Protected by X-Internal-Secret header (same as XP_TOKEN_SECRET).
//
// Creates real Supabase auth users with realistic Turkish profiles,
// 90 days of historical XP events, streaks, and badges.
// Call in batches: 40 calls × 50 bots = 2000 total.

import { json, err } from '../_shared/auth.js';
import { sbGet, sbPost, sbPatch, sbRpc } from '../_shared/xp.js';

// ── Name pools ────────────────────────────────────────────────────────────────

const MALE_FIRST = [
  'Mehmet','Ali','Ahmet','Mustafa','Murat','Emre','Burak','Cem','Onur','Tolga',
  'Barış','Umut','Volkan','Kerem','Berk','Yusuf','Furkan','Sinan','Gökhan','Serkan',
  'Haluk','Selim','Tarık','Erhan','Alp','Soner','Koray','Engin','Ferhat','Halit',
  'İlker','Tayfun','Cenk','Efe','Deniz','Bülent','Ercan','Ekrem','Okan','Taner',
  'Hakan','Uğur','Sedat','Levent','Caner','Atakan','Doruk','Kaan','Arda','Berkay',
];
const FEMALE_FIRST = [
  'Fatma','Ayşe','Zeynep','Emine','Merve','Elif','Seda','Burcu','Tuğba','Pınar',
  'Gözde','Büşra','Neslihan','Ayla','Serap','Canan','Dilek','Ebru','Gül','Hande',
  'Kübra','Leyla','Meltem','Özge','Selin','Bahar','Esra','Filiz','Yasemin','İrem',
];
const ALL_FIRST = [...MALE_FIRST, ...FEMALE_FIRST]; // 80 names
const SURNAMES = [
  'Yılmaz','Kaya','Demir','Çelik','Şahin','Doğan','Arslan','Kılıç','Aslan','Çetin',
  'Öztürk','Yıldız','Aydın','Özdemir','Koç','Kurt','Can','Polat','Tekin','Aksoy',
  'Bulut','Kaplan','Duman','Yavuz','Çakır','Ateş','Taş','Özkan','Güler','Torun',
  'Bozkurt','Tuncer','Uçar','Toprak','Korkmaz','Keskin','Altın','Erol','Işık','Kara',
  'Mutlu','Fidan','Uysal','Bayrak','Vural','Güneş','Altan','Başar','Aktaş','Erdal',
]; // 50 surnames — 80×50=4000 unique combos > 2000 bots

// BJK opponents for fake historical predictions
const OPPONENTS = [
  'Fenerbahçe','Galatasaray','Trabzonspor','Başakşehir','Sivasspor',
  'Kasımpaşa','Antalyaspor','Alanyaspor','Konyaspor','Kayserispor',
  'Rizespor','Gaziantep','Hatayspor','Adana Demirspor','Samsunspor',
];
// Realistic scorelines (slight home bias)
const SCORELINES = [
  [2,0],[2,1],[1,0],[3,1],[3,0],[1,1],[2,2],[0,0],[1,2],[0,1],[0,2],
];

// ── Helpers ───────────────────────────────────────────────────────────────────

function toAscii(str) {
  return str.toLowerCase()
    .replace(/ı/g,'i').replace(/İ/g,'i')
    .replace(/ü/g,'u').replace(/Ü/g,'u')
    .replace(/ö/g,'o').replace(/Ö/g,'o')
    .replace(/ğ/g,'g').replace(/Ğ/g,'g')
    .replace(/ş/g,'s').replace(/Ş/g,'s')
    .replace(/ç/g,'c').replace(/Ç/g,'c')
    .replace(/â/g,'a').replace(/î/g,'i').replace(/û/g,'u');
}

// Deterministic metadata per bot index (0-1999)
function botMeta(index) {
  const firstName = ALL_FIRST[index % ALL_FIRST.length];
  const surname   = SURNAMES[Math.floor(index / ALL_FIRST.length) % SURNAMES.length];
  const f = toAscii(firstName);
  const s = toAscii(surname);

  // Username pattern varies naturally across the range
  const pattern = index % 5;
  const year    = 1975 + (index % 38); // birth years 1975-2012
  let username;
  if (pattern === 0)      username = `${f}${s}`;
  else if (pattern === 1) username = `${f}_${s}`;
  else if (pattern === 2) username = `${f}${year}`;
  else if (pattern === 3) username = `${f}.${s}${year % 100}`;
  else                    username = `${f}_${s}${year % 100}`;

  const display_name = `${firstName} ${surname[0]}.`;
  const email        = `bot_${index}_${f}${s.slice(0,4)}@pitchos-bots.internal`;
  const avatar_url   = `https://api.dicebear.com/7.x/avataaars-neutral/svg?seed=${username}&backgroundColor=b6e3f4,c0aede,ffd5dc`;

  // Tier distribution across 2000 bots
  let bot_tier, bot_activity_rate, days_back;
  if (index < 100) {
    bot_tier = 'power';   bot_activity_rate = 0.90; days_back = 120;
  } else if (index < 500) {
    bot_tier = 'regular'; bot_activity_rate = 0.55; days_back = 90;
  } else if (index < 1300) {
    bot_tier = 'casual';  bot_activity_rate = 0.25; days_back = 45;
  } else {
    bot_tier = 'dormant'; bot_activity_rate = 0;    days_back = 21;
  }

  return { firstName, surname, display_name, email, username, avatar_url, bot_tier, bot_activity_rate, days_back };
}

// Random float seeded only by call position — good enough for one-time history
function rand() { return Math.random(); }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }

// UTC+3 offset — bots appear as Turkish users
function trtHour(date, minHour, maxHour) {
  const h = minHour + Math.floor(rand() * (maxHour - minHour + 1));
  const m = Math.floor(rand() * 60);
  const d = new Date(date);
  d.setUTCHours(h - 3, m, Math.floor(rand() * 60), 0); // subtract UTC+3 offset
  return d.toISOString();
}

function generateEvents(user_id, site_id, meta) {
  const events = [];
  const predictions = [];
  const now = new Date();
  const { bot_activity_rate, days_back, bot_tier } = meta;

  // Leave the last 7 days for the live tick — don't seed recent data
  for (let d = days_back; d > 7; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().slice(0, 10);

    // Daily checkin
    if (rand() < bot_activity_rate) {
      events.push({
        user_id, site_id,
        action_id: 'daily_checkin',
        xp_earned: 10, base_xp: 10, multiplier: 1.0,
        source_ref: null, nullified: false,
        created_at: trtHour(date, 7, 22),
      });
    }

    // Article reads (power/regular only)
    if (bot_tier !== 'dormant' && rand() < bot_activity_rate * 0.7) {
      const reads = bot_tier === 'power' ? (rand() < 0.5 ? 2 : 1) : 1;
      for (let r = 0; r < reads; r++) {
        events.push({
          user_id, site_id,
          action_id: 'read_article',
          xp_earned: 5, base_xp: 5, multiplier: 1.0,
          source_ref: `hist_art_${dateStr}_${r}`,
          nullified: false,
          created_at: trtHour(date, 9, 23),
        });
      }
    }

    // Poll votes (~3 days/week treated as "poll days": Mon, Wed, Fri)
    const dow = date.getDay(); // 0=Sun
    const isPollDay = [1, 3, 5].includes(dow);
    if (isPollDay && bot_tier !== 'dormant' && rand() < bot_activity_rate * 0.6) {
      events.push({
        user_id, site_id,
        action_id: 'poll_vote',
        xp_earned: 15, base_xp: 15, multiplier: 1.0,
        source_ref: `hist_poll_${dateStr}`,
        nullified: false,
        created_at: trtHour(date, 12, 21),
      });
    }

    // Score predictions — Tue & Sat as approximate "match days"
    const isMatchDay = [2, 6].includes(dow);
    if (isMatchDay && bot_tier !== 'dormant' && rand() < bot_activity_rate * 0.75) {
      const [hs, as_] = pick(SCORELINES);
      const matchId = `hist_match_${dateStr}`;
      events.push({
        user_id, site_id,
        action_id: 'predict_score',
        xp_earned: 30, base_xp: 30, multiplier: 1.0,
        source_ref: matchId,
        nullified: false,
        created_at: trtHour(date, 14, 20),
      });
      // Small chance of exact-score bonus
      if (rand() < 0.12) {
        events.push({
          user_id, site_id,
          action_id: 'exact_score_bonus',
          xp_earned: 100, base_xp: 100, multiplier: 1.0,
          source_ref: matchId,
          nullified: false,
          created_at: trtHour(date, 22, 23),
        });
      }
      // Insert into score_predictions for profile history visibility
      const opponent = pick(OPPONENTS);
      const isHome = rand() < 0.5;
      predictions.push({
        user_id, site_id,
        match_id: matchId,
        home_team: isHome ? 'Beşiktaş' : opponent,
        away_team: isHome ? opponent : 'Beşiktaş',
        home_score: hs, away_score: as_,
        xp_awarded: 30, outcome_awarded: rand() < 0.4, bonus_awarded: rand() < 0.12,
        actual_home_score: rand() < 0.5 ? hs : pick([0,1,2,3]),
        actual_away_score: rand() < 0.5 ? as_ : pick([0,1,2]),
        created_at: trtHour(date, 14, 20),
      });
    }

    // Starting 11 (power bots on match days)
    if (isMatchDay && bot_tier === 'power' && rand() < 0.60) {
      events.push({
        user_id, site_id,
        action_id: 'starting_11',
        xp_earned: 50, base_xp: 50, multiplier: 1.0,
        source_ref: `hist_match_${dateStr}`,
        nullified: false,
        created_at: trtHour(date, 10, 17),
      });
    }
  }

  return { events, predictions };
}

function computeStreak(events) {
  const checkinDays = new Set(
    events
      .filter(e => e.action_id === 'daily_checkin')
      .map(e => e.created_at.slice(0, 10))
  );

  const today = new Date();
  let current = 0;
  let longest = 0;
  let lastDate = null;

  // Walk backwards from yesterday (today's checkin comes from the live tick)
  for (let d = 1; d <= 365; d++) {
    const date = new Date(today);
    date.setDate(date.getDate() - d);
    const dateStr = date.toISOString().slice(0, 10);
    if (checkinDays.has(dateStr)) {
      current++;
      longest = Math.max(longest, current);
      if (!lastDate) lastDate = dateStr;
    } else {
      break; // streak broken
    }
  }

  return { current_streak: current, longest_streak: longest, last_checkin_date: lastDate };
}

// Simplified badge award for historical data — avoids the per-bot N+1 of checkBadges()
async function awardHistoricalBadges(env, user_id, site_id, events, streakData) {
  const total_xp   = events.reduce((s, e) => s + (e.nullified ? 0 : e.xp_earned), 0);
  const { current_streak: cs, longest_streak: ls } = streakData;
  const actionCounts = {};
  for (const e of events) actionCounts[e.action_id] = (actionCounts[e.action_id] ?? 0) + 1;

  const candidates = [];

  // XP milestones
  if (total_xp >= 500)   candidates.push('xp_500');
  if (total_xp >= 2000)  candidates.push('xp_2000');
  if (total_xp >= 10000) candidates.push('xp_10000');

  // Streak badges (use longest streak for history)
  if (ls >= 3)  candidates.push('streak_3');
  if (ls >= 7)  candidates.push('streak_7');
  if (ls >= 15) candidates.push('streak_shield');
  if (ls >= 20) candidates.push('streak_gold');
  if (ls >= 30) candidates.push('streak_sadakat');

  // Level-based tier badges
  const levelRows = await sbRpc(env, 'get_user_level', { total_xp }).catch(() => []);
  const level = levelRows[0]?.level ?? 1;
  if (level >= 4)  candidates.push('tier_taraftar');
  if (level >= 7)  candidates.push('tier_kapali_tribun');
  if (level >= 10) candidates.push('tier_carsi_ruhu');
  if (level >= 13) candidates.push('tier_efsane');

  // Activity badges
  const reads = actionCounts['read_article'] ?? 0;
  if (reads >= 1)   candidates.push('first_read');
  if (reads >= 10)  candidates.push('articles_10');
  if (reads >= 25)  candidates.push('articles_25');
  if (reads >= 50)  candidates.push('articles_50');
  if (reads >= 100) candidates.push('articles_100');

  // Insert all in one bulk post
  if (!candidates.length) return;
  const rows = candidates.map(badge_id => ({ user_id, site_id, badge_id }));
  await sbPost(env, 'user_badges', rows).catch(() => {}); // ignore duplicates
}

// ── Auth user creation ────────────────────────────────────────────────────────

async function createAuthUser(env, meta) {
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    },
    body: JSON.stringify({
      email: meta.email,
      password: `BotPwd!${Math.random().toString(36).slice(2)}X9`,
      email_confirm: true,
      user_metadata: { username: meta.username, display_name: meta.display_name },
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Auth create failed: ${res.status} ${text}`);
  }
  return res.json();
}

// ── Main handler ──────────────────────────────────────────────────────────────

export async function onRequest({ request, env }) {
  if (request.method !== 'POST') return err('Method not allowed', 405);
  if (request.headers.get('X-Internal-Secret') !== env.XP_TOKEN_SECRET)
    return err('Forbidden', 403);

  const body = await request.json().catch(() => ({}));
  const start = Math.max(0, parseInt(body.start ?? 0, 10));
  const count = Math.min(50, Math.max(1, parseInt(body.count ?? 50, 10)));

  // Resolve site_id from the kartalix.com domain
  const sites = await sbGet(env, `sites?domain=eq.kartalix.com&select=id&limit=1`);
  const site_id = sites[0]?.id;
  if (!site_id) return err('kartalix.com site not found in sites table', 404);

  const results = { start, count, created: 0, skipped: 0, failed: 0, errors: [] };

  for (let i = start; i < start + count; i++) {
    const meta = botMeta(i);
    try {
      // Skip if username already exists
      const existing = await sbGet(env, `profiles?username=eq.${encodeURIComponent(meta.username)}&select=id&limit=1`);
      if (existing.length) { results.skipped++; continue; }

      // Create Supabase auth user
      const authUser = await createAuthUser(env, meta);
      const user_id  = authUser.id;

      // Create profile
      await sbPost(env, 'profiles', {
        id: user_id,
        site_id,
        username:          meta.username,
        display_name:      meta.display_name,
        avatar_url:        meta.avatar_url,
        is_bot:            true,
        bot_tier:          meta.bot_tier,
        bot_activity_rate: meta.bot_activity_rate,
      });

      // Generate and insert historical XP events
      const { events, predictions } = generateEvents(user_id, site_id, meta);

      if (events.length) {
        // Bulk insert — Supabase accepts array body
        await sbPost(env, 'xp_events', events);
      }
      if (predictions.length) {
        await sbPost(env, 'score_predictions', predictions).catch(() => {}); // non-fatal
      }

      // Compute and store streak
      const streakData = computeStreak(events);
      if (streakData.last_checkin_date) {
        await sbPost(env, 'user_streaks', {
          user_id, site_id,
          current_streak:    streakData.current_streak,
          longest_streak:    streakData.longest_streak,
          last_checkin_date: streakData.last_checkin_date,
          shield_active:     false,
          streak_started_at: new Date().toISOString(),
        });
      }

      // Award historical badges
      await awardHistoricalBadges(env, user_id, site_id, events, streakData);

      results.created++;
    } catch (e) {
      results.failed++;
      results.errors.push({ index: i, username: meta.username, error: e.message });
    }
  }

  return json(results);
}
