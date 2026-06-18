import { json, err, corsHeaders } from './_shared/auth.js';

const EMOTION_KEYS = ['atesli', 'mutlu', 'uzgun', 'kizgin', 'hayal_kirikligi'];

function buildConclusion(breakdown, total) {
  if (total === 0) return { dominant: null, dominantPct: 0, negPct: 0, posPct: 0, conclusion: 'Henüz tepki bekleniyor.' };

  const dominant = EMOTION_KEYS.reduce((a, b) => breakdown[a] >= breakdown[b] ? a : b);
  const dominantPct = Math.round(breakdown[dominant] / total * 100);
  const negPct = Math.round((breakdown.uzgun + breakdown.kizgin + breakdown.hayal_kirikligi) / total * 100);
  const posPct = Math.round((breakdown.atesli + breakdown.mutlu) / total * 100);

  let conclusion;
  if (dominantPct >= 50) {
    conclusion = {
      atesli:           'Taraftar ateşli! Heyecan dorukta.',
      mutlu:            'Taraftar mutlu! Olumlu bir atmosfer hakim.',
      uzgun:            'Taraftar üzgün. Zor bir dönemden geçiyoruz.',
      kizgin:           'Taraftar kızgın! Tepkiler yoğun.',
      hayal_kirikligi:  'Hayal kırıklığı hakim. Beklentiler karşılanmadı.',
    }[dominant];
  } else if (negPct >= 60) {
    conclusion = 'Karamsar bir atmosfer var. Taraftar sabırsız.';
  } else if (posPct >= 60) {
    conclusion = 'Olumlu bir enerji hakim. Taraftar umutlu.';
  } else {
    conclusion = 'Taraftarın duyguları karışık. Her şey mümkün.';
  }

  return { dominant, dominantPct, negPct, posPct, conclusion };
}

export async function onRequest({ request, env }) {
  if (request.method === 'OPTIONS') return corsHeaders();
  if (request.method !== 'GET') return err('GET only', 405);

  const url   = new URL(request.url);
  const slug  = url.searchParams.get('slug') || null;
  const days  = Math.min(parseInt(url.searchParams.get('window') || '30', 10) || 30, 90);

  const base    = env.SUPABASE_URL;
  const apikey  = env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_ANON_KEY;
  const headers = { apikey, Authorization: `Bearer ${apikey}`, Accept: 'application/json' };

  // Build filter: per-article or site-wide rolling window
  const since = new Date(Date.now() - days * 86400_000).toISOString();
  let filter  = `created_at=gte.${encodeURIComponent(since)}&reaction=not.eq.like&reaction=not.eq.dislike&select=reaction`;
  if (slug) filter = `article_slug=eq.${encodeURIComponent(slug)}&` + filter;

  const res = await fetch(`${base}/rest/v1/article_reactions?${filter}`, { headers });
  if (!res.ok) return err('upstream error', 502);

  const rows = await res.json();
  const breakdown = Object.fromEntries(EMOTION_KEYS.map(k => [k, 0]));
  for (const row of rows) {
    if (breakdown[row.reaction] !== undefined) breakdown[row.reaction]++;
  }
  const total = EMOTION_KEYS.reduce((s, k) => s + breakdown[k], 0);
  const { dominant, dominantPct, negPct, posPct, conclusion } = buildConclusion(breakdown, total);

  return json({
    total,
    breakdown,
    dominant,
    dominant_pct:   dominantPct,
    negative_pct:   negPct,
    positive_pct:   posPct,
    conclusion,
    window_days:    slug ? null : days,
  }, 200);
}
