// GET /api/quests — today's 3 daily quests with user progress
// Quests rotate by day-of-week; progress computed from today's xp_events (no extra writes).

import { getUser, json, err, corsHeaders } from './_shared/auth.js';
import { getSiteId } from './_shared/site.js';
import { sbGet } from './_shared/xp.js';

const DAY_QUESTS = [
  // 0 Sunday
  [
    { id: 'checkin', action: 'daily_checkin',   target: 1, label: 'Günlük giriş yap' },
    { id: 'read2',   action: 'read_article',    target: 2, label: '2 haber oku'       },
    { id: 'video',   action: 'watch_video_30s', target: 1, label: 'Video izle'        },
  ],
  // 1 Monday
  [
    { id: 'checkin', action: 'daily_checkin',   target: 1, label: 'Günlük giriş yap' },
    { id: 'read3',   action: 'read_article',    target: 3, label: '3 haber oku'       },
    { id: 'predict', action: 'predict_score',   target: 1, label: 'Skor tahmin et'    },
  ],
  // 2 Tuesday
  [
    { id: 'checkin', action: 'daily_checkin',   target: 1, label: 'Günlük giriş yap' },
    { id: 'react',   action: 'react_article',   target: 1, label: 'Habere tepki ver'  },
    { id: 'comment', action: 'comment',         target: 1, label: 'Yorum yap'         },
  ],
  // 3 Wednesday
  [
    { id: 'checkin', action: 'daily_checkin',   target: 1, label: 'Günlük giriş yap' },
    { id: 'read3',   action: 'read_article',    target: 3, label: '3 haber oku'       },
    { id: 'share',   action: 'share_link',      target: 1, label: 'Haber paylaş'      },
  ],
  // 4 Thursday
  [
    { id: 'checkin', action: 'daily_checkin',   target: 1, label: 'Günlük giriş yap' },
    { id: 'predict', action: 'predict_score',   target: 1, label: 'Skor tahmin et'    },
    { id: 'comment', action: 'comment',         target: 1, label: 'Yorum yap'         },
  ],
  // 5 Friday
  [
    { id: 'checkin', action: 'daily_checkin',   target: 1, label: 'Günlük giriş yap' },
    { id: 'read5',   action: 'read_article',    target: 5, label: '5 haber oku'       },
    { id: 'comment', action: 'comment',         target: 1, label: 'Yorum yap'         },
  ],
  // 6 Saturday
  [
    { id: 'checkin', action: 'daily_checkin',   target: 1, label: 'Günlük giriş yap' },
    { id: 'video',   action: 'watch_video_30s', target: 1, label: 'Video izle'        },
    { id: 'share',   action: 'share_link',      target: 1, label: 'Haber paylaş'      },
  ],
];

const DAY_NAMES = ['Pazar', 'Pazartesi', 'Salı', 'Çarşamba', 'Perşembe', 'Cuma', 'Cumartesi'];

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('Method not allowed', 405);

  const [user, site_id] = await Promise.all([getUser(request, env), getSiteId(request, env)]);
  if (!user) return err('Unauthorized', 401);
  if (!site_id) return err('Site not found', 404);

  const now = new Date();
  const dayOfWeek = now.getUTCDay();
  const quests = DAY_QUESTS[dayOfWeek];

  // UTC midnight — same boundary used by daily cap logic
  const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();

  // Deduplicate actions, fetch all in parallel
  const actions = [...new Set(quests.map(q => q.action))];
  const countMap = {};
  await Promise.all(actions.map(async action => {
    const rows = await sbGet(env,
      `xp_events?user_id=eq.${user.id}&site_id=eq.${site_id}&action_id=eq.${action}&created_at=gte.${encodeURIComponent(since)}&nullified=eq.false&select=id&limit=10`
    ).catch(() => []);
    countMap[action] = rows.length;
  }));

  const questsWithProgress = quests.map(q => {
    const progress = Math.min(countMap[q.action] ?? 0, q.target);
    return { ...q, progress, done: progress >= q.target };
  });

  const completed = questsWithProgress.filter(q => q.done).length;

  return json({
    day: DAY_NAMES[dayOfWeek],
    quests: questsWithProgress,
    completed,
    all_done: completed === quests.length,
  });
}
