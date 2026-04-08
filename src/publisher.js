import { callClaude, supabase, extractText, simpleHash, MODEL_FETCH } from './utils.js';
import { normalizeTitle, titleSimilarity } from './processor.js';

// ─── PUBLISH MODE DECISION ────────────────────────────────────
export function decidePublishMode(article) {
  const cat   = (article.category     || '').toLowerCase();
  const type  = (article.content_type || '').toLowerCase();
  const trust = (article.trust        || '').toLowerCase();
  const nvs   = article.nvs || 0;

  const today   = new Date().toISOString().slice(0, 10);
  const pubDate = (article.published_at || '').slice(0, 10);
  const isToday = pubDate === today;

  if (cat === 'match' && type === 'fact' && isToday)  return 'template_matchday';
  if (trust === 'official')                            return 'template_official';
  if (cat === 'match' && type === 'fact' && !isToday) return 'template_postmatch';
  if (cat === 'injury')                               return 'template_injury';
  if (cat === 'transfer' && nvs >= 70)                return 'template_transfer';
  if (nvs >= 55 && article.url && article.url !== '#') return 'copy_source';
  return 'rss_summary';
}

// ─── CLEAN RSS TEXT (no Claude) ───────────────────────────────
export function cleanRSS(text) {
  if (!text) return '';
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/devamı için tıklayınız\.?/gi, '')
    .replace(/ayrıntılar için tıklayınız\.?/gi, '')
    .replace(/haber detayı için tıklayınız\.?/gi, '')
    .replace(/işte (maçın |o |tüm )?detaylar(ı)?\.?/gi, '')
    .replace(/işte ayrıntılar\.?/gi, '')
    .replace(/işte o anlar\.?/gi, '')
    .replace(/son dakika beşiktaş haberleri[^.]*/gi, '')
    .replace(/bjk spor haberi[^)]*/gi, '')
    .replace(/\(bjk spor haberi\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\.\s*$/, '.')
    .slice(0, 300);
}

// ─── OG IMAGE EXTRACTION ─────────────────────────────────────
function extractOGImage(html) {
  const m = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
         || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
  return m ? m[1].trim() : '';
}

// Lightweight fetch — reads full response but only parses head section for og:image
async function fetchOGImage(url) {
  if (!url || url === '#') return '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kartalix/1.0)' },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return '';
    const html = await res.text();
    return extractOGImage(html.slice(0, 5000));
  } catch (e) {
    return '';
  }
}

// ─── READABILITY PROXY ───────────────────────────────────────
// Returns { content, image_url }
async function fetchViaReadability(url) {
  if (!url || url === '#') return { content: '', image_url: '' };
  try {
    const proxyUrl = `https://pitchos-proxy.onrender.com/article?url=${encodeURIComponent(url)}`;
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
    const data = await res.json();

    const clean = (data.content || '')
      .replace(/Küçük Normal Orta Büyük[\s\S]{0,100}/gi, '')
      .replace(/Ana Sayfa Yazı Boyutu[\s\S]{0,100}/gi, '')
      .replace(/ABONE OL[\s\S]{0,50}/gi, '')
      .replace(/\d+\s+(?=[A-ZÇĞİÖŞÜa-zçğışöşü])/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 5000);

    console.log(`READABILITY [${url.slice(0, 50)}]: ${clean.length} chars`);
    return { content: clean, image_url: data.image_url || '' };
  } catch(e) {
    console.error(`READABILITY FAILED [${url.slice(0, 50)}]:`, e.message);
    return { content: '', image_url: '' };
  }
}

// ─── MATCH DAY TEMPLATE (Haiku extracts facts) ───────────────
async function writeMatchDay(article, env) {
  const prompt = `Bu Beşiktaş maç haberinden aşağıdaki bilgileri çıkar ve JSON olarak döndür.
Sadece JSON döndür, başka hiçbir şey yazma.

Haber: ${article.title} — ${cleanRSS(article.summary || article.description || '')}

{
  "rakip": "rakip takım adı",
  "tarih": "gün ve tarih",
  "saat": "maç saati (İstanbul saatiyle)",
  "stadyum": "stadyum adı",
  "tv_kanali": "yayıncı kanal",
  "mac_turu": "lig/kupa adı",
  "is_home": true
}

Bilmiyorsan null yaz.`;

  try {
    const res  = await callClaude(env, MODEL_FETCH, prompt, false, 300);
    const text = extractText(res.content);
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const data = JSON.parse(match[0]);

    const homeAway = data.is_home ? 'Ev Sahibi' : 'Deplasman';
    const body =
      `⚽ MAÇ GÜNÜ\n\n` +
      `${data.mac_turu || 'Süper Lig'} — ${data.tarih || 'Bugün'}\n` +
      `🕐 Saat: ${data.saat || '?'} (İstanbul)\n` +
      `🏟️ ${data.stadyum || '?'} (${homeAway})\n` +
      `📺 ${data.tv_kanali || 'beIN Sports'}\n\n` +
      `Beşiktaş, ${data.rakip || 'rakibi'} ile karşılaşıyor.`;

    return { ...article, full_body: body, publish_mode: 'template_matchday', usage: res.usage };
  } catch (e) {
    console.error('writeMatchDay failed:', e.message);
    return null;
  }
}

// ─── WRITE ARTICLES (Readability for top 3 only, rss_summary rest) ─
export async function writeArticles(articles, site, env) {
  const results = [];

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const mode = decidePublishMode(article);
    let published = { ...article, publish_mode: mode };

    if (mode === 'template_matchday') {
      const written = await writeMatchDay(article, env);
      if (written) published = written;
      else published.summary = cleanRSS(article.summary || article.description || '');
      await new Promise(r => setTimeout(r, 300));

    } else {
      // Use RSS summary — Readability runs separately via /enrich endpoint
      published.summary   = cleanRSS(article.summary || article.description || '');
      published.full_body = published.summary;
      published.publish_mode = 'rss_summary';
    }

    results.push(published);
  }

  return results;
}

// ─── SUPABASE SAVES ───────────────────────────────────────────
export async function saveArticles(env, siteId, articles) {
  if (!articles || articles.length === 0) return;

  const rows = articles.map(a => ({
    site_id:      siteId,
    source_type:  'rss',
    source_name:  a.source_name || a.source || 'Unknown',
    original_url: a.url || a.original_url || '',
    title:        a.title || '',
    summary:      a.summary || '',
    full_body:    a.full_body || '',
    category:     a.category || 'Club',
    content_type: a.content_type || 'fact',
    sport:        a.sport || 'football',
    nvs_score:    a.nvs || a.nvs_score || 0,
    nvs_notes:    a.nvs_notes || '',
    golden_score: a.golden_score != null ? String(a.golden_score) : null,
    image_url:    a.image_url || '',
    publish_mode: a.publish_mode || 'rss_summary',
    status:       'published',
    reviewed_by:  'auto',
    fetched_at:   a.fetched_at || new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
  }));

  console.log('SUPABASE INSERT: attempting', rows.length, 'rows');
  console.log('SUPABASE SAMPLE ROW:', JSON.stringify(rows[0]).slice(0, 200));

  const result = await supabase(env, 'POST', '/rest/v1/content_items', rows);

  if (result && result.error) {
    console.error('SUPABASE INSERT ERROR:', JSON.stringify(result.error));
  } else {
    console.log('SUPABASE INSERT OK:', rows.length, 'articles saved');
  }

  return result;
}

export async function logFetch(env, siteId, status, stats, errorMsg, funnelStats) {
  console.log(
    `logFetch [${status}] raw:${funnelStats?.raw_fetched||stats.raw_fetched||0}` +
    ` →kw:${funnelStats?.after_keyword||0} →title:${funnelStats?.after_title||stats.after_title||0}` +
    ` scored:${funnelStats?.scored||0} pub:${stats.published||0} €${(stats.costEur||0).toFixed(4)}`
  );
  const row = {
    site_id:            siteId,
    trigger_type:       'cron',
    status,
    items_fetched:      funnelStats?.raw_fetched  || stats.raw_fetched   || 0,
    items_scored:       funnelStats?.after_title  || stats.after_title   || 0,
    items_published:    stats.published           || 0,
    items_queued:       stats.queued              || 0,
    items_rejected:     stats.rejected            || 0,
    claude_calls:       stats.claudeCalls         || 0,
    tokens_input:       stats.tokensIn            || 0,
    tokens_output:      stats.tokensOut           || 0,
    estimated_cost_eur: stats.costEur             || 0,
    model_used:         `${MODEL_FETCH}`,
    error_message:      status === 'success' && funnelStats
      ? JSON.stringify(funnelStats)
      : errorMsg || null,
    duration_ms:        stats.durationMs          || null,
  };
  await supabase(env, 'POST', '/rest/v1/fetch_logs', row);
}

// ─── KV CACHE ─────────────────────────────────────────────────
export async function cacheToKV(env, siteCode, articles) {
  try {
    const key = `articles:${siteCode}`;
    const value = JSON.stringify(articles);
    console.log(`KV WRITE: key=${key} articles=${articles.length} size=${value.length} chars`);
    await env.PITCHOS_CACHE.put(key, value, { expirationTtl: 7200 });
    console.log(`KV WRITE SUCCESS: ${key}`);
  } catch(e) {
    console.error(`KV WRITE FAILED:`, e.message);
  }
}

export async function getCachedArticles(env, siteCode) {
  const cached = await env.PITCHOS_CACHE.get(`articles:${siteCode}`);
  return cached ? JSON.parse(cached) : [];
}

export function mergeAndDedupe(articles, limit) {
  const seen = new Set();
  return articles
    .filter(a => {
      const hash = simpleHash(a.title);
      if (seen.has(hash)) return false;
      seen.add(hash);
      return true;
    })
    .sort((a, b) => {
      // Pin template cards to top regardless of NVS
      if (a.template_id && !b.template_id) return -1;
      if (!a.template_id && b.template_id) return 1;
      return (b.nvs || 0) - (a.nvs || 0);
    })
    .slice(0, limit);
}

// ─── WEATHER ─────────────────────────────────────────────────
async function fetchWeather(lat, lon, env) {
  try {
    console.log('WEATHER: fetching for', lat, lon);
    console.log('WEATHER: key available:', !!env.OPENWEATHER_KEY);
    const url = `https://api.openweathermap.org/data/2.5/weather?lat=${lat}&lon=${lon}&appid=${env.OPENWEATHER_KEY}&units=metric&lang=tr`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    console.log('WEATHER: response status', res.status);
    if (!res.ok) return null;
    const data = await res.json();
    console.log('WEATHER: result', JSON.stringify(data));
    return {
      temp:        Math.round(data.main?.temp || 0),
      feels_like:  Math.round(data.main?.feels_like || 0),
      description: data.weather?.[0]?.description || '',
      wind:        Math.round((data.wind?.speed || 0) * 3.6),
      icon:        data.weather?.[0]?.main || '',
    };
  } catch(e) {
    console.error('Weather fetch failed:', e.message);
    return null;
  }
}

function weatherEmoji(icon) {
  const map = {
    'Clear':        '☀️',
    'Clouds':       '☁️',
    'Rain':         '🌧️',
    'Drizzle':      '🌦️',
    'Thunderstorm': '⛈️',
    'Snow':         '🌨️',
    'Mist':         '🌫️',
    'Fog':          '🌫️',
  };
  return map[icon] || '🌤️';
}

// ─── TEMPLATE 05 — MATCH DAY CARD ────────────────────────────
export async function generateMatchDayCard(match, cachedArticles, env) {
  // Extract injury/suspension info from cached articles
  const injuryArticles = (cachedArticles || [])
    .filter(a => {
      const text = ((a.title || '') + ' ' + (a.summary || '')).toLowerCase();
      return (text.includes('cezalı') || text.includes('sakatlık') ||
              text.includes('kadro dışı') || text.includes('yok')) &&
             (text.includes('beşiktaş') || text.includes('bjk'));
    })
    .slice(0, 3);

  // Fetch weather for match location
  const weather = await fetchWeather(match.venue_lat, match.venue_lon, env);

  // Build weather line
  const weatherLine = weather
    ? `${weatherEmoji(weather.icon)} Hava Durumu: ${weather.temp}°C, ${weather.description}, Rüzgar ${weather.wind} km/s`
    : null;

  // Extract injury info via Haiku if we have articles
  let injuryInfo = 'Kadro bilgisi bekleniyor';
  if (injuryArticles.length > 0) {
    try {
      const injuryPrompt = `Aşağıdaki haberlerden Beşiktaş'ın ${match.opponent} maçı için eksik oyuncularını çıkar.
Sadece JSON döndür: {"cezalilar": ["isim"], "sakatlıklar": ["isim"], "ozet": "1 cümle özet"}
Bilmiyorsan null yaz, ASLA uydurma.

${injuryArticles.map(a => `Başlık: ${a.title}\n${(a.summary||'').slice(0,200)}`).join('\n\n')}`;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 200,
          messages: [{ role: 'user', content: injuryPrompt }],
        }),
      });
      const data = await response.json();
      const text = data.content?.[0]?.text || '{}';
      const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());

      const cezalilar = parsed.cezalilar || [];
      const sakatlıklar = (parsed.sakatlıklar || []).filter(p => !cezalilar.includes(p));
      const parts = [];
      if (cezalilar.length) parts.push(`🚫 Cezalı: ${cezalilar.join(', ')}`);
      if (sakatlıklar.length) parts.push(`🏥 Sakat: ${sakatlıklar.join(', ')}`);
      if (parts.length) injuryInfo = parts.join(' | ');
      else if (parsed.ozet) injuryInfo = parsed.ozet;
    } catch(e) {
      console.error('Injury extraction error:', e.message);
    }
  }

  // Build match day card body
  const matchDate = match.date.split('-').reverse().join('.');
  const isHome = match.home;
  const matchup = isHome
    ? `${match.team} vs ${match.opponent}`
    : `${match.opponent} vs ${match.team} (Deplasman)`;

  const body = [
    `🦅 MAÇ GÜNÜ`,
    ``,
    `⚽ ${matchup}`,
    `🏆 ${match.league} · ${match.week}. Hafta`,
    ``,
    `📅 ${matchDate} · ${match.time} (İstanbul)`,
    `🏟️ ${match.venue} · ${match.venue_city}`,
    `📺 ${match.tv}`,
    weatherLine ? weatherLine : '',
    ``,
    `⚠️ KADRO DURUMU:`,
    injuryInfo,
    ``,
    `🔵 Muhtemel 11 ve hakem açıklamaları yakında...`,
    ``,
    `Herkese iyi seyirler! 🖤🤍`,
  ].filter(l => l !== null).join('\n');

  const summary = `${match.team} bugün ${match.time}'de ${isHome ? 'Tüpraş Stadyumu\'nda' : match.venue_city + "'de"} ${match.opponent} ile karşılaşıyor. ${weatherLine || ''} ${injuryInfo}`;

  return {
    title:        `Maç Günü! ${match.team} - ${match.opponent} | ${match.time}`,
    summary:      summary.slice(0, 300),
    full_body:    body,
    source_name:  'Kartalix',
    source:       'Kartalix',
    trust:        'official',
    sport:        'football',
    category:     'Match',
    content_type: 'template',
    publish_mode: 'match_day_template',
    nvs:          85,
    golden_score: 5,
    url:          `https://kartalix.com/mac/${match.date}-${match.team.toLowerCase()}-${match.opponent.toLowerCase().replace(/\s/g,'-')}`,
    image_url:    '',
    is_template:  true,
    template_id:  '05',
  };
}

// ─── TEMPLATE 08b — MUHTEMEL 11 ──────────────────────────────
export async function generateMuhtemel11(match, articles, site, env) {
  const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
  const now = Date.now();

  const lineupArticles = (articles || [])
    .filter(a => {
      const ts = a.published_at || a.fetched_at;
      if (ts && (now - new Date(ts).getTime()) > TWENTY_FOUR_HOURS) return false;
      const text = ((a.title || '') + ' ' + (a.full_body || a.summary || '')).toLowerCase();
      return (text.includes('muhtemel 11') || text.includes('beklenen kadro') ||
              text.includes('ilk 11') || text.includes('kadro belli') ||
              text.includes('sahaya çıkıyor') || text.includes('ilk kadro')) &&
             (text.includes('beşiktaş') || text.includes('bjk'));
    })
    .slice(0, 3);

  if (lineupArticles.length === 0) return null;

  const SQUAD = [
    'ersin', 'vasquez', 'murillo', 'agbadou', 'djalo', 'uduokhai',
    'emirhan', 'rıdvan', 'taylan', 'sazdağı', 'özcan',
    'orkun', 'kökçü', 'ndidi', 'asllani', 'salih', 'kartal kayra',
    'rashica', 'olaitan', 'cerny', 'abraham', 'el bilal', 'oh',
    'jota', 'cengiz', 'hekimoğlu', 'sergen', 'yalçın'
  ];

  const prompt = `Aşağıdaki haberlerden Beşiktaş'ın ${match.opponent} maçı için muhtemel 11'ini çıkar.
Sadece JSON döndür:
{
  "players": ["isim1", "isim2", ...],
  "formation": "4-2-3-1",
  "confidence": 0-100,
  "type": "muhtemel",
  "source_quote": "haberdeki ilgili cümle"
}
En az 8 oyuncu bulamazsan confidence: 0 yaz.
ASLA uydurma. Sadece haberde geçen isimler.

Bilinen kadro: ${SQUAD.join(', ')}

${lineupArticles.map(a =>
  `Kaynak: ${a.source_name || a.source}\nBaşlık: ${a.title}\n${(a.full_body || a.summary || '').slice(0, 400)}`
).join('\n\n')}`;

  let lineupData = { players: [], formation: null, confidence: 0, type: 'muhtemel' };
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    lineupData = JSON.parse(text.replace(/```json|```/g, '').trim());
    console.log('TEMPLATE 08b: confidence', lineupData.confidence, 'players', lineupData.players?.length);
  } catch(e) {
    console.error('Muhtemel 11 extraction error:', e.message);
    return null;
  }

  if (lineupData.confidence < 50 || (lineupData.players?.length || 0) < 8) {
    console.log('TEMPLATE 08b: confidence too low or not enough players, skipping');
    return null;
  }

  const playersList = lineupData.players.map((p, i) => `${i + 1}. ${p}`).join('\n');

  const body = [
    `🦅 ${match.team.toUpperCase()}'IN MUHTEMEL 11'İ`,
    ``,
    `⚽ ${match.team} - ${match.opponent}`,
    `🏆 ${match.league} · ${match.week}. Hafta`,
    `📅 ${match.date.split('-').reverse().join('.')} · ${match.time}`,
    ``,
    lineupData.formation ? `📋 Beklenen Diziliş: ${lineupData.formation}` : '',
    ``,
    `👕 MUHTEMEL 11:`,
    playersList,
    ``,
    lineupData.source_quote ? `"${lineupData.source_quote}"` : '',
    ``,
    `⚠️ Bu muhtemel kadrodur, resmi açıklama bekleniyor.`,
    ``,
    `Hadi Beşiktaş! 🖤🤍`,
  ].filter(l => l !== null && l !== undefined).join('\n');

  const summary = `${match.team}'ın ${match.opponent} maçı için muhtemel 11'i belli oldu. ${lineupData.formation ? 'Beklenen diziliş: ' + lineupData.formation : ''}`;

  return {
    title:        `${match.team}'ın Muhtemel 11'i: ${match.opponent} Maçı İçin Beklenen Kadro`,
    summary,
    full_body:    body,
    source_name:  'Kartalix',
    source:       'Kartalix',
    trust:        'official',
    sport:        'football',
    category:     'Match',
    content_type: 'template',
    publish_mode: 'muhtemel_lineup_template',
    nvs:          75,
    golden_score: 4,
    url:          `https://kartalix.com/mac/${match.date}-besiktas-${match.opponent.toLowerCase().replace(/\s/g,'-')}-muhtemel`,
    image_url:    '',
    is_template:  true,
    template_id:  '08b',
  };
}

// ─── TEMPLATE 09 — CONFIRMED LINEUP ──────────────────────────
export async function generateConfirmedLineup(match, articles, site, env) {
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const now = Date.now();

  // Only articles from last 2 hours qualify for confirmed lineup
  const lineupArticles = (articles || [])
    .filter(a => {
      const ts = a.published_at || a.fetched_at;
      if (ts && (now - new Date(ts).getTime()) > TWO_HOURS) return false;
      const text = ((a.title || '') + ' ' + (a.full_body || a.summary || '')).toLowerCase();
      return (text.includes('ilk 11') || text.includes('kadro belli') ||
              text.includes('sahaya çıkıyor') || text.includes('ilk kadro') ||
              text.includes('startın')) &&
             (text.includes('beşiktaş') || text.includes('bjk'));
    })
    .slice(0, 3);

  if (lineupArticles.length === 0) return null;

  const SQUAD = [
    'ersin', 'vasquez', 'murillo', 'agbadou', 'djalo', 'uduokhai',
    'emirhan', 'rıdvan', 'taylan', 'sazdağı', 'özcan',
    'orkun', 'kökçü', 'ndidi', 'asllani', 'salih', 'kartal kayra',
    'rashica', 'olaitan', 'cerny', 'abraham', 'el bilal', 'oh',
    'jota', 'cengiz', 'hekimoğlu', 'sergen', 'yalçın'
  ];

  const prompt = `Aşağıdaki haberlerden Beşiktaş'ın ${match.opponent} maçı için RESMI ilk 11'ini çıkar.
Sadece JSON döndür:
{
  "players": ["isim1", "isim2", ...],
  "formation": "4-2-3-1",
  "confidence": 0-100,
  "type": "confirmed" veya "muhtemel",
  "source_quote": "haberdeki ilgili cümle"
}
type: "confirmed" → sadece resmi açıklama veya kesin kadro haberleri.
type: "muhtemel" → tahmin veya spekülasyon.
En az 8 oyuncu bulamazsan confidence: 0 yaz.
ASLA uydurma. Sadece haberde geçen isimler.

Bilinen kadro: ${SQUAD.join(', ')}

${lineupArticles.map(a =>
  `Kaynak: ${a.source_name}\nBaşlık: ${a.title}\n${(a.full_body || a.summary || '').slice(0, 400)}`
).join('\n\n')}`;

  let lineupData = { players: [], formation: null, confidence: 0 };
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    lineupData = JSON.parse(text.replace(/```json|```/g, '').trim());
    console.log('TEMPLATE 09: confidence', lineupData.confidence, 'type', lineupData.type, 'players', lineupData.players?.length);
  } catch(e) {
    console.error('Lineup extraction error:', e.message);
    return null;
  }

  // Require confirmed type, min confidence 70, min 8 players
  if (lineupData.type === 'muhtemel') {
    console.log('TEMPLATE 09: type is muhtemel, not confirmed — skipping (use 08b instead)');
    return null;
  }
  if (lineupData.confidence < 70 || (lineupData.players?.length || 0) < 8) {
    console.log('TEMPLATE 09: confidence too low or not enough players, skipping');
    return null;
  }

  const playersList = lineupData.players
    .map((p, i) => `${i + 1}. ${p}`)
    .join('\n');

  const body = [
    `🦅 ${match.team.toUpperCase()}'IN 11'İ BELLİ OLDU!`,
    ``,
    `⚽ ${match.team} - ${match.opponent}`,
    `🏆 ${match.league} · ${match.week}. Hafta`,
    `📅 ${match.date.split('-').reverse().join('.')} · ${match.time}`,
    ``,
    lineupData.formation ? `📋 Diziliş: ${lineupData.formation}` : '',
    ``,
    `👕 İLK 11:`,
    playersList,
    ``,
    lineupData.source_quote ? `"${lineupData.source_quote}"` : '',
    ``,
    `✅ Resmi kadro açıklandı.`,
    ``,
    `Hadi Beşiktaş! 🖤🤍`,
  ].filter(l => l !== null && l !== undefined).join('\n');

  const summary = `${match.team} ${match.opponent} maçı için ${lineupData.players?.length} oyuncudan oluşan ilk 11'ini belirledi. ${lineupData.formation ? 'Diziliş: ' + lineupData.formation : ''}`;

  return {
    title:        `${match.team}'ın 11'i Belli Oldu! ${match.opponent} Maçı Başlıyor`,
    summary,
    full_body:    body,
    source_name:  'Kartalix',
    source:       'Kartalix',
    trust:        'official',
    sport:        'football',
    category:     'Match',
    content_type: 'template',
    publish_mode: 'lineup_template',
    nvs:          85,
    golden_score: 5,
    url:          `https://kartalix.com/mac/${match.date}-besiktas-${match.opponent.toLowerCase().replace(/\s/g,'-')}-lineup`,
    image_url:    '',
    is_template:  true,
    template_id:  '09',
  };
}
