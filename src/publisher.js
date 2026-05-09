import { callClaude, supabase, extractText, simpleHash, MODEL_FETCH, MODEL_GENERATE, generateSlug, getEditorialNotes } from './utils.js';
import { normalizeTitle, titleSimilarity } from './processor.js';
import { extractFacts, writeTransfer, extractFactsForStory, SKIP_STORY_TYPES } from './firewall.js';
import { getLastFixtures, getBJKStanding } from './api-football.js';

// ─── FACTUAL GROUNDING ────────────────────────────────────────
// Fetches verified API-Football stats and returns a Turkish-language
// "DOĞRULANMIŞ VERİLER" block that is prepended to every synthesis prompt.
// Prevents Claude from making false situational claims (wrong league position,
// fabricated results, "kritik viraj" framing without supporting data).
// Returns '' gracefully if API is unavailable so generation continues.
async function buildGroundingContext(env) {
  try {
    const [fixtures, standing] = await Promise.all([
      getLastFixtures(env, 5),
      getBJKStanding(env),
    ]);
    const lines = [];

    if (standing) {
      const all = standing.all || {};
      const gf  = all.goals?.for    ?? 0;
      const ga  = all.goals?.against ?? 0;
      lines.push(
        `Süper Lig: ${standing.rank}. sıra | ${standing.points} puan | ` +
        `${all.played ?? '?'} maç (${all.win ?? 0}G ${all.draw ?? 0}B ${all.lose ?? 0}M) | ` +
        `${gf} gol attı, ${ga} gol yedi`
      );
    }

    const finished = (fixtures || []).filter(f => f.is_finished);
    if (finished.length > 0) {
      const rows = finished.map(f => {
        const outcome = f.score_bjk > f.score_opp ? 'G' : f.score_bjk === f.score_opp ? 'B' : 'M';
        return `${f.opponent} ${f.score_bjk}-${f.score_opp}(${outcome})`;
      });
      lines.push(`Son maçlar (yeniden eskiye): ${rows.join(', ')}`);
    }

    if (lines.length === 0) return '';
    return (
      `\n\nDOĞRULANMIŞ VERİLER (API-Football, ${new Date().toISOString().slice(0, 10)}):\n` +
      lines.join('\n') +
      `\nSadece bu verilere dayanan durum değerlendirmesi yap — "kritik viraj", "büyük kriz" gibi yorumlar bu sayılarca desteklenmelidir.`
    );
  } catch {
    return '';
  }
}

// ─── HOT NEWS DELAY ──────────────────────────────────────────
// P4 articles must not publish within 15 minutes of source pubDate.
// See DECISIONS.md 2026-04-28 — Hot News delay.
const HOT_NEWS_DELAY_MS = 15 * 60 * 1000;

export function isHotNewsHeld(article) {
  if (!article.is_p4) return false;
  if (!article.published_at) return false;
  const age = Date.now() - new Date(article.published_at).getTime();
  return age < HOT_NEWS_DELAY_MS;
}

// ─── PUBLISH MODE DECISION ────────────────────────────────────
export function decidePublishMode(article) {
  const cat   = (article.category     || '').toLowerCase();
  const type  = (article.content_type || '').toLowerCase();
  const trust = (article.trust        || '').toLowerCase();
  const nvs   = article.nvs || 0;

  // Hot News hold: P4 articles younger than 15 minutes are not published
  if (isHotNewsHeld(article)) return 'hot_news_hold';

  const today   = new Date().toISOString().slice(0, 10);
  const pubDate = (article.published_at || '').slice(0, 10);
  const isToday = pubDate === today;

  if (cat === 'match' && type === 'fact' && isToday)  return 'template_matchday';
  if (trust === 'official')                            return 'template_official';
  if (cat === 'match' && type === 'fact' && !isToday) return 'template_postmatch';
  if (cat === 'injury')                               return 'template_injury';
  if (cat === 'transfer' && nvs >= 70)                return 'template_transfer';
  // copy_source restricted to non-P4 sources only
  if (nvs >= 55 && article.url && article.url !== '#' && !article.is_p4) return 'copy_source';
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

// ─── VERIFIER GATE ────────────────────────────────────────────
// Post-generation Haiku call. Extracts factual claims (standings, scores,
// recent results) and cross-checks against grounding data.
// Fails open — if API data is unavailable or call errors, returns passed:true.
async function verifyArticle(body, groundingCtx, env) {
  if (!groundingCtx || !groundingCtx.includes('DOĞRULANMIŞ VERİLER')) {
    return { passed: true, issues: [] };
  }
  const prompt = `Aşağıdaki Beşiktaş haberinde yer alan somut olgusal iddiaları (sıralama, puan, skor, son maç sonuçları) doğrulanmış verilerle karşılaştır. Yalnızca açık çelişkileri listele — belirsiz veya genel ifadeleri işaretleme.
${groundingCtx}

MAKALE:
${body.slice(0, 1200)}

JSON formatında yanıt ver, başka hiçbir şey ekleme:
Sorun yoksa: {"passed":true,"issues":[]}
Sorun varsa: {"passed":false,"issues":["iddia X ama gerçek Y"]}`;

  try {
    const res = await callClaude(env, MODEL_FETCH, prompt, false, 150);
    const text = extractText(res.content).trim();
    const m = text.match(/\{[\s\S]*?\}/);
    if (!m) return { passed: true, issues: [] };
    const parsed = JSON.parse(m[0]);
    return { passed: !!parsed.passed, issues: Array.isArray(parsed.issues) ? parsed.issues.slice(0, 5) : [] };
  } catch {
    return { passed: true, issues: [] };
  }
}

export { buildGroundingContext, verifyArticle };

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
export async function fetchViaReadability(url) {
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
  const notes = await getEditorialNotes(env, ['match', 'news']);
  const prompt = `${notes}Bu Beşiktaş maç haberinden aşağıdaki bilgileri çıkar ve JSON olarak döndür.
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
// extractFacts is capped at MAX_FACTS_EXTRACTS per run — each is a Claude call.
// Articles arrive sorted by NVS, so only the highest-value P4 articles get facts.
const MAX_FACTS_EXTRACTS = 5;

async function synthesizeArticle(article, env) {
  const srcUrl = article.url || article.original_url || '';
  let sourceText = article.summary || '';
  if (srcUrl && srcUrl !== '#') {
    try {
      const proxyUrl = 'https://pitchos-proxy.onrender.com/article?url=' + encodeURIComponent(srcUrl);
      const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(12000) });
      if (res.ok) {
        const data = await res.json();
        if (data.content && data.content.length > 200) sourceText = data.content.slice(0, 2000);
      }
    } catch(e) {}
  }
  const [editorialCtx, groundingCtx] = await Promise.all([
    getEditorialNotes(env, ['general', 'style']),
    buildGroundingContext(env),
  ]);
  const prompt = `Sen Kartalix'in Beşiktaş spor editörüsün. Aşağıdaki kaynak metinden özgün bir Kartalix haberi yaz.

Kaynak başlık: ${article.title}
Kaynak metin: ${sourceText}${editorialCtx}${groundingCtx}

Kurallar:
- 250-350 kelime
- Türkçe, doğrudan gazetecilik diliyle yaz
- "...kaynağına göre" veya "...iddia ediyor" gibi ifadeler kullanma — bilgiyi doğrudan sun
- Haber cümlesiyle başla (kim ne yaptı/oldu)
- BJK taraftarının perspektifinden, analitik ve yoğun bir ses tonu
- Paragraflar arası boş satır bırak
- DOĞRULANMIŞ VERİLERle çelişen ifade kullanma

Sadece haber metnini yaz, başlık veya ekstra açıklama ekleme.`;

  const res = await callClaude(env, MODEL_FETCH, prompt, false, 600);
  let body = extractText(res.content).trim();

  const verification = await verifyArticle(body, groundingCtx, env);
  if (!verification.passed && verification.issues.length > 0) {
    console.log(`VERIFY FAIL: ${verification.issues.join('; ')}`);
    try {
      const fixPrompt = prompt + `\n\nDİKKAT — aşağıdaki olgusal hatalar tespit edildi, düzelt:\n${verification.issues.join('\n')}`;
      const res2 = await callClaude(env, MODEL_FETCH, fixPrompt, false, 600);
      const body2 = extractText(res2.content).trim();
      if (body2.length > 200) {
        console.log(`VERIFY REGENERATED OK`);
        return { body: body2, needs_review: false, verification_result: { passed: true, issues: [], regenerated: true } };
      }
    } catch {}
    console.log(`VERIFY FAIL — needs_review flagged`);
    return { body, needs_review: true, verification_result: verification };
  }

  return { body, needs_review: false, verification_result: verification };
}

export async function writeArticles(articles, site, env) {
  const results = [];
  let factsExtracted = 0;

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const mode = decidePublishMode(article);
    let published = { ...article, publish_mode: mode };

    if (mode === 'template_matchday') {
      const written = await writeMatchDay(article, env);
      if (written) published = written;
      else published.summary = cleanRSS(article.summary || article.description || '');
      await new Promise(r => setTimeout(r, 300));

    } else if (mode === 'template_transfer') {
      try {
        const facts   = await extractFacts(article, env);
        const written = await writeTransfer(facts, env);
        published = { ...published, ...written, _facts: facts };
      } catch (e) {
        console.error('Firewall/writeTransfer failed:', e.message, '| article:', article.title?.slice(0, 60));
        published.summary      = cleanRSS(article.summary || article.description || '');
        published.full_body    = published.summary;
        published.publish_mode = 'rss_summary';
      }
      await new Promise(r => setTimeout(r, 300));

    } else if (article.treatment === 'embed') {
      // YouTube embed — video is the content, no facts/synthesis needed
      try {
        const card = await generateVideoEmbed(article._video, site, env);
        if (card) published = { ...article, ...card, publish_mode: 'video_embed', nvs: article.nvs_hint || article.nvs || 72 };
      } catch (e) {
        console.error('YT embed in writeArticles failed:', e.message, '|', article.title?.slice(0, 50));
      }

    } else {
      published.summary   = cleanRSS(article.summary || article.description || '');
      published.full_body = published.summary;
      published.publish_mode = 'rss_summary';

      // Auto-synthesis: for high-NVS articles, fetch source and write a full Kartalix article
      if ((article.nvs || 0) >= 60 && results.filter(r => r.publish_mode === 'synthesis').length < 4) {
        try {
          const result = await synthesizeArticle(article, env);
          const body = result.body;
          if (body && body.length > 200) {
            published.full_body          = body;
            published.publish_mode       = 'synthesis';
            published.needs_review       = result.needs_review || false;
            published.verification_result = result.verification_result || null;
            console.log(`SYNTHESIS OK [${article.nvs}]: "${article.title?.slice(0, 50)}" — ${body.length}ch${result.needs_review ? ' ⚠️ needs_review' : ''}`);
          }
        } catch(e) {
          console.error('Synthesis failed:', e.message, '|', article.title?.slice(0, 50));
        }
        await new Promise(r => setTimeout(r, 300));
      }

      // Extract facts for story matching (top P4 articles only, capped at MAX_FACTS_EXTRACTS).
      // Classifies story type first — skips match_result/squad (handled by templates).
      if (article.is_p4 && factsExtracted < MAX_FACTS_EXTRACTS) {
        try {
          const facts = await extractFactsForStory(article, env);
          if (!SKIP_STORY_TYPES.has(facts.story_type)) {
            published._facts = facts;
            console.log(`FACTS [${facts.story_type}]: "${article.title?.slice(0, 50)}"`);
          } else {
            console.log(`FACTS [${facts.story_type}]: skipped story intake — "${article.title?.slice(0, 50)}"`);
          }
          factsExtracted++;
        } catch (e) {
          console.error('extractFactsForStory failed:', e.message, '| article:', article.title?.slice(0, 60));
        }
        await new Promise(r => setTimeout(r, 200));
      }
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
    publish_mode:        a.publish_mode || 'rss_summary',
    needs_review:        a.needs_review || false,
    verification_result: a.verification_result || null,
    status:              'published',
    reviewed_by:         'auto',
    fetched_at:   a.published_at || a.fetched_at || new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    slug:         a.slug || generateSlug(a.title, a.published_at || a.fetched_at),
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
    error_message:      funnelStats
      ? JSON.stringify({ ...funnelStats, _error: errorMsg || null })
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
// injuries: array from getInjuries() — used directly when provided.
// cachedArticles: kept for weather context only (RSS fallback removed).
export async function generateMatchDayCard(match, cachedArticles, site, env, injuries = null) {
  const platformName  = site?.display_name || site?.name || 'Kartalix';
  const platformEmoji = site?.emoji || '🦅';

  const weather = await fetchWeather(match.venue_lat, match.venue_lon, env);

  // Build absent player list from API injuries (authoritative)
  const cezalilar   = (injuries || []).filter(i => i.type === 'Suspension').map(i => i.name);
  const sakatlıklar = (injuries || []).filter(i => i.type !== 'Suspension').map(i => i.name);

  // Build context strings for the prose prompt
  const matchDate   = new Date(match.date).toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric' });
  const homeAway    = match.home ? 'ev sahibi olarak' : 'deplasmanda';
  const venueText   = match.home ? `Tüpraş Stadyumu` : `${match.venue}, ${match.venue_city}`;
  const eksikler    = [
    ...cezalilar.map(p => `${p} (cezalı)`),
    ...sakatlıklar.map(p => `${p} (sakat)`),
  ];
  const eksikText   = eksikler.length ? eksikler.join(', ') : 'yok';
  const weatherCtx  = weather
    ? `Hava durumu: ${weather.description}, ${weather.temp}°C, rüzgar ${weather.wind} km/s`
    : '';

  // Haiku writes the full article body as natural Turkish news prose
  const t05Notes = await getEditorialNotes(env, ['match', 'T05']);
  const prosePrompt = `${t05Notes}Sen Kartalix'in spor editörüsün. Aşağıdaki bilgileri kullanarak doğal, akıcı Türkçe bir maç önizleme haberi yaz.

MAÇ BİLGİLERİ:
- Ev sahibi/Deplasman: Beşiktaş ${homeAway}
- Rakip: ${match.opponent}
- Tarih: ${matchDate}, Saat: ${match.time}
- Stat: ${venueText}
- Lig/Kupa: ${match.league}${match.week ? ', ' + match.week + '. Hafta' : ''}
- Yayıncı: ${match.tv}
- Eksik oyuncular: ${eksikText}
${weatherCtx ? '- ' + weatherCtx : ''}

YAZI KURALLARI:
- 3-4 kısa paragraf, toplam ~180-220 kelime
- İlk paragraf: maçı ve önemi tanıt (ne zaman, nerede, ne için)
- İkinci paragraf: kısa bağlam — Beşiktaş'ın bu maçtaki durumu, puan tablosundaki yeri veya kupa hedefi
- Üçüncü paragraf: eksik oyuncular ve kadro durumu (yoksa "tam kadro" de)
- Son cümle: yayın bilgisi + taraftara çağrı
- Emoji KULLANMA, başlık/madde listesi KULLANMA — düz paragraf
- SEO için şu kelimeleri doğal kullan: "${match.team}", "${match.opponent}", "maç önizlemesi", "${match.league}"${match.week ? ', "' + match.week + '. hafta"' : ''}

Sadece haber metnini yaz, başlık ekleme.`;

  let body = '';
  try {
    const res = await callClaude(env, 'claude-haiku-4-5-20251001', prosePrompt, false, 600);
    body = extractText(res.content).trim();
  } catch(e) {
    console.error('T05 prose generation failed:', e.message);
  }

  // Fallback if Claude call fails
  if (!body) {
    const wText = weather ? ` Maç saatinde ${weather.description} bekleniyor, sıcaklık ${weather.temp}°C.` : '';
    body = `${match.league}${match.week ? ' ' + match.week + '. haftasında' : ''} Beşiktaş, ${matchDate} tarihinde saat ${match.time}'de ${venueText}'nda ${homeAway} ${match.opponent} ile karşılaşıyor.${wText}\n\nMaç ${match.tv} ekranlarından canlı yayınlanacak.\n\n${eksikler.length ? 'Eksik oyuncular: ' + eksikText + '.' : 'Beşiktaş maça tam kadro çıkıyor.'}\n\nKartalix tüm gelişmeleri takip etmeye devam edecek. Hadi Beşiktaş!`;
  }

  const oppSlug   = match.opponent.toLowerCase().replace(/\s+/g, '-').replace(/[ğ]/g,'g').replace(/[ü]/g,'u').replace(/[ş]/g,'s').replace(/[ı]/g,'i').replace(/[ö]/g,'o').replace(/[ç]/g,'c');
  const weekSlug  = match.week ? `-super-lig-${match.week}-hafta` : '';
  const title     = `Beşiktaş - ${match.opponent} Maç Önizlemesi | ${matchDate}${match.week ? ', ' + match.week + '. Hafta' : ''}`;
  const summary   = `Beşiktaş, ${matchDate} tarihinde saat ${match.time}'de ${venueText}'nda ${match.opponent} ile ${match.league} kapsamında karşılaşıyor. ${eksikler.length ? 'Eksikler: ' + eksikText + '.' : 'Tam kadro.'}`.slice(0, 300);

  return {
    title,
    summary,
    full_body:           body,
    source_name:         platformName,
    source:              platformName,
    source_emoji:        platformEmoji,
    is_kartalix_content: true,
    trust:               'official',
    sport:               'football',
    category:            'Match',
    content_type:        'template',
    publish_mode:        'match_day_template',
    nvs:                 85,
    golden_score:        5,
    url:                 `https://kartalix.com/mac/${match.date}-besiktas-${oppSlug}${weekSlug}-mac-onizlemesi`,
    image_url:           '',
    is_template:         true,
    published_at:        new Date().toISOString(),
    template_id:         '05',
  };
}

// ─── TEMPLATE 08b — MUHTEMEL 11 ──────────────────────────────
export async function generateMuhtemel11(match, articles, site, env) {
  const platformName  = site?.display_name || site?.name || 'Kartalix';
  const platformEmoji = site?.emoji || '🦅';
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

  if (lineupArticles.length === 0) {
    console.log('TEMPLATE 08b: no lineup articles found, skipping');
    return null;
  }

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
      signal: AbortSignal.timeout(8000),
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    const data = await response.json();
    try {
      const text = data.content?.[0]?.text || '{}';
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        lineupData = JSON.parse(jsonMatch[0]);
      }
    } catch(e) {
      console.error('Muhtemel 11 JSON parse error:', e.message);
      console.error('Raw text was:', data.content?.[0]?.text?.slice(0, 200));
      return null;
    }
    console.log('TEMPLATE 08b: confidence', lineupData.confidence, 'players', lineupData.players?.length);
  } catch(e) {
    console.error('Muhtemel 11 extraction error:', e.message);
    return null;
  }

  if (lineupData.confidence < 50 || (lineupData.players?.length || 0) < 8) {
    console.log('TEMPLATE 08b: confidence too low or not enough players, skipping');
    return null;
  }

  const matchDate  = new Date(match.date).toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric' });
  const oppSlug    = match.opponent.toLowerCase().replace(/\s+/g,'-').replace(/[ğ]/g,'g').replace(/[ü]/g,'u').replace(/[ş]/g,'s').replace(/[ı]/g,'i').replace(/[ö]/g,'o').replace(/[ç]/g,'c');
  const formation  = lineupData.formation || '';
  const players    = lineupData.players || [];

  // Prose intro + structured lineup
  const t08bNotes = await getEditorialNotes(env, ['match', 'T08b']);
  const prosePrompt = `${t08bNotes}Sen Kartalix'in spor editörüsün. Aşağıdaki bilgilerle kısa, doğal Türkçe bir "muhtemel 11" haberi yaz.

MAÇ: Beşiktaş - ${match.opponent} | ${matchDate} ${match.time} | ${match.league}${match.week ? ' ' + match.week + '. Hafta' : ''}
MUHTEMEL 11 (${formation}): ${players.join(', ')}
${lineupData.source_quote ? 'KAYNAK ALINTILAR: "' + lineupData.source_quote + '"' : ''}

KURALLAR:
- 2 kısa paragraf (toplam ~80-100 kelime), sonra ayrı satırda kadro listesi
- 1. paragraf: maçı tanıt, muhtemel 11'in nasıl belirlendiğini yaz
- 2. paragraf: dizilişi ve dikkat çeken seçimleri yorumla (varsa)
- Ardından: "Beşiktaş'ın Muhtemel 11'i (${formation}):" başlığı ve oyuncu listesi
- Emoji KULLANMA, resmi açıklama bekleniyor notunu ekle
- SEO: "Beşiktaş muhtemel 11", "${match.opponent} maçı", "${matchDate}" doğal geçsin

Sadece haber metnini yaz.`;

  let prose = '';
  try {
    const res = await callClaude(env, 'claude-haiku-4-5-20251001', prosePrompt, false, 500);
    prose = extractText(res.content).trim();
  } catch(e) { console.error('T08b prose failed:', e.message); }

  if (!prose) {
    prose = `${match.team}, ${matchDate} tarihinde oynayacağı ${match.opponent} maçı için ${formation ? formation + ' dizilişiyle' : ''} sahaya çıkması bekleniyor.\n\nBeşiktaş'ın Muhtemel 11'i (${formation}):\n${players.map((p,i)=>`${i+1}. ${p}`).join('\n')}\n\nBu muhtemel kadrodur, resmi açıklama bekleniyor.`;
  }

  const title   = `Beşiktaş'ın ${match.opponent} Maçı Muhtemel 11'i – ${matchDate}`;
  const summary = `Beşiktaş, ${matchDate} tarihinde ${match.opponent} karşısında ${formation ? formation + ' dizilişiyle' : ''} sahaya çıkması bekleniyor. Muhtemel 11: ${players.slice(0,5).join(', ')} ve diğerleri.`.slice(0, 300);

  return {
    title,
    summary,
    full_body:           prose,
    source_name:         platformName,
    source:              platformName,
    source_emoji:        platformEmoji,
    is_kartalix_content: true,
    trust:               'official',
    sport:               'football',
    category:            'Match',
    content_type:        'template',
    publish_mode:        'muhtemel_lineup_template',
    nvs:                 75,
    golden_score:        4,
    url:                 `https://kartalix.com/mac/${match.date}-besiktas-${oppSlug}-muhtemel-11`,
    image_url:           '',
    is_template:         true,
    published_at:        new Date().toISOString(),
    template_id:         '08b',
  };
}

// ─── TEMPLATE 09 — CONFIRMED LINEUP ──────────────────────────
// lineup: result of getFixtureLineup() from API-Football.
// Returns null if lineup not yet available (cron retries next tick).
// API provides confirmed starting XI ~60min before kickoff.
export async function generateConfirmedLineup(match, lineup, site, env) {
  if (!lineup || lineup.startXI.length < 8) return null;

  const platformName  = site?.display_name || site?.name || 'Kartalix';
  const platformEmoji = site?.emoji || '🦅';

  const matchDate = new Date(match.date).toLocaleDateString('tr-TR', { day:'numeric', month:'long', year:'numeric' });
  const oppSlug   = match.opponent.toLowerCase().replace(/\s+/g,'-').replace(/[ğ]/g,'g').replace(/[ü]/g,'u').replace(/[ş]/g,'s').replace(/[ı]/g,'i').replace(/[ö]/g,'o').replace(/[ç]/g,'c');
  const formation = lineup.formation || '';
  const players   = lineup.startXI.map(p => p.name);
  const bench     = lineup.substitutes.map(p => p.name);
  const coach     = lineup.coach || 'Sergen Yalçın';

  console.log(`TEMPLATE 09: API lineup — ${formation} — ${players.join(', ')}`);

  const t09Notes = await getEditorialNotes(env, ['match', 'T09']);
  const prosePrompt = `${t09Notes}Sen Kartalix'in spor editörüsün. Beşiktaş'ın resmi ilk 11'i açıklandı. Kısa, haber dilinde Türkçe yaz.

MAÇ: Beşiktaş - ${match.opponent} | ${matchDate} ${match.time} | ${match.league}${match.week ? ' ' + match.week + '. Hafta' : ''}
ANTRENÖR: ${coach}
RESMİ İLK 11 (${formation}): ${players.join(', ')}
${bench.length ? 'YEDEKLER: ' + bench.join(', ') : ''}

KURALLAR:
- 2 kısa paragraf (~80 kelime), ardından kadro listesi
- 1. paragraf: kadronun açıklandığını haber ver, maçı tanıt
- 2. paragraf: dikkat çekici seçim veya sürpriz varsa yorumla, yoksa ${coach}'ın tercihleri olarak çerçevele
- Ardından "Beşiktaş'ın İlk 11'i (${formation}):" başlığı ve oyuncu listesi
- SEO: "Beşiktaş ilk 11", "${match.opponent} maçı" doğal geçsin
- Emoji KULLANMA

Sadece haber metnini yaz.`;

  let prose = '';
  try {
    const res = await callClaude(env, 'claude-haiku-4-5-20251001', prosePrompt, false, 500);
    prose = extractText(res.content).trim();
  } catch(e) { console.error('T09 prose failed:', e.message); }

  if (!prose) {
    prose = `Beşiktaş, ${matchDate} tarihinde oynayacağı ${match.opponent} maçının ilk 11'ini açıkladı. ${coach}, ${formation ? formation + ' dizilişini' : 'kadrosunu'} belirledi.\n\nBeşiktaş'ın İlk 11'i (${formation}):\n${players.map((p,i)=>`${i+1}. ${p}`).join('\n')}\n\nResmi kadro açıklandı.`;
  }

  const title   = `Beşiktaş'ın ${match.opponent} Maçı İlk 11'i Belli Oldu | ${matchDate}`;
  const summary = `${coach}, ${matchDate} tarihindeki ${match.opponent} maçı için ilk 11'i açıkladı. ${formation ? 'Diziliş: ' + formation + '.' : ''} ${players.slice(0,5).join(', ')} ve diğerleri sahada.`.slice(0, 300);

  return {
    title,
    summary,
    full_body:           prose,
    source_name:         platformName,
    source:              platformName,
    source_emoji:        platformEmoji,
    is_kartalix_content: true,
    trust:               'official',
    sport:               'football',
    category:            'Match',
    content_type:        'template',
    publish_mode:        'lineup_template',
    nvs:                 88,
    golden_score:        5,
    url:                 `https://kartalix.com/mac/${match.date}-besiktas-${oppSlug}-ilk-11`,
    image_url:           '',
    is_template:         true,
    published_at:        new Date().toISOString(),
    template_id:         '09',
  };
}

// ─── T-REF REFEREE PROFILE ────────────────────────────────────
// Fires once per match in the 24–48h pre-match window.
// referee: string from normalizeFixture(). stats: BJK disciplinary
// history under this referee (computed from last fixtures).
export async function generateRefereeProfile(match, referee, refStats, site, env) {
  if (!referee) return null;

  const statLines = refStats ? [
    refStats.bjk_games != null      ? `Yönettiği BJK maçları: ${refStats.bjk_games}` : null,
    refStats.bjk_wins != null       ? `Sonuçlar: ${refStats.bjk_wins}G ${refStats.bjk_draws}B ${refStats.bjk_losses}M` : null,
    refStats.bjk_yellow != null     ? `BJK'ya gösterilen sarı kart (ortalama): ${refStats.bjk_yellow}` : null,
    refStats.bjk_red != null && refStats.bjk_red > 0 ? `BJK'ya gösterilen kırmızı kart: ${refStats.bjk_red}` : null,
  ].filter(Boolean).join('\n') : '(geçmiş istatistik yok)';

  const trefNotes = await getEditorialNotes(env, ['match', 'T-REF']);
  const prompt = `${trefNotes}Sen Kartalix'in spor editörüsün. Beşiktaş'ın ${match.opponent} maçını yönetecek hakemi tanıtan kısa bir haber yaz.

HAKEM: ${referee}
MAÇ: ${match.date} saat ${match.time} — ${match.opponent} — ${match.league}

GEÇMIŞ HAKEM-BJK İSTATİSTİKLERİ:
${statLines}

YAZIM KURALLARI:
- 150–220 kelime, haber dili
- Giriş: hakemin kim olduğu ve bu maçı yöneteceği
- Orta: Beşiktaş maçlarındaki geçmişi — rakamları doğal dile dök
- Son: bu maçta dikkat edilecek kural uygulaması veya tarz (istatistikten çıkar, yoksa genel bir not)
- "Kaynaklara göre" kullanma
- Emoji, başlık veya alt başlık yazma — sadece haber gövdesi

Sadece Türkçe haber metnini yaz.`;

  const res  = await callClaude(env, MODEL_GENERATE, prompt, false, 700);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const title   = `${match.opponent} Maçının Hakemi: ${referee}`;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary,
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    65,
    publish_mode: 'template_referee',
    status:       'published',
    template_id:  'T-REF',
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T-REF: "${title.slice(0, 60)}" → ${body.split(/\s+/).length} words`);
  return saved?.[0] || { title, summary, full_body: body, template_id: 'T-REF', slug, published_at: new Date().toISOString() };
}

// ─── T01 MATCH PREVIEW ────────────────────────────────────────
// 300–400 word pre-match article. Fires 0–48h before kickoff.
// Inputs: normalizeFixture object, last-5 H2H array, Open-Meteo current object.
export async function generateMatchPreview(match, h2h, weather, standing, site, env) {
  const oppSlug = (match.opponent || '').toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');

  const h2hLines = (h2h || []).slice(0, 5).map(f => {
    const home = f.home ? 'Beşiktaş' : f.opponent;
    const away = f.home ? f.opponent : 'Beşiktaş';
    const res  = f.score_bjk > f.score_opp ? 'G' : f.score_bjk < f.score_opp ? 'M' : 'B';
    return `${f.date}: ${home} ${f.score_bjk ?? '?'}-${f.score_opp ?? '?'} ${away} (BJK: ${res})`;
  }).join('\n') || '(geçmiş karşılaşma verisi yok)';

  const weatherLine = weather
    ? `Hava durumu: ${Math.round(weather.temperature_2m)}°C, rüzgar ${Math.round(weather.windspeed_10m)} km/s`
    : '';

  const standingsLine = standing || '';

  const t01Notes = await getEditorialNotes(env, ['match', 'template', 'T01']);
  const prompt = `${t01Notes}Sen Kartalix'in kıdemli spor editörüsün. Beşiktaş'ın bu haftaki maçı için özgün bir ön analiz haberi yaz.

MAÇ:
${match.home ? 'Beşiktaş (Ev)' : 'Beşiktaş (Deplasman)'} vs ${match.opponent}
${match.league}${match.round ? ' — ' + match.round : ''}
${match.date} saat ${match.time} (Türkiye saati)
Stadyum: ${match.venue}, ${match.venue_city}
${weatherLine}
${standingsLine ? 'PUAN DURUMU: ' + standingsLine : ''}

SON 5 KARŞILAŞMA (H2H):
${h2hLines}

YAZIM KURALLARI:
- 300–400 kelime, profesyonel Türkçe haber dili
- İlk paragraf: maçın somut önemi — puan durumunu rakamlarla belirt (kaçıncı sıra, kaç puan, üst ve alt sıralarla fark). Soyut değil, özgül ol: "X puan geride olan Y takımının baskısı" gibi.
- İkinci paragraf: H2H geçmişini doğal şekilde aktar
- Üçüncü paragraf: Beşiktaş'ın son formu
- Son paragraf: beklenti — bu maçtan puan kaybının tabloya somut etkisini belirt
- Hava durumu bilgisi varsa kısa bir cümleyle aktar
- "Kaynaklara göre" gibi ifade kullanma — Kartalix'in kendi analizi
- Emoji, başlık veya alt başlık yazma — sadece haber gövdesi

Sadece Türkçe haber metnini yaz.`;

  const res  = await callClaude(env, MODEL_GENERATE, prompt, false, 1500);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const title   = `${match.home ? match.opponent + ' - Beşiktaş' : 'Beşiktaş - ' + match.opponent} Maç Önü`;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary,
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    82,
    publish_mode: 'template_preview',
    status:       'published',
    template_id:  'T01',
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T01 PREVIEW: "${title.slice(0, 60)}" → ${body.split(/\s+/).length} words`);
  return saved?.[0] || { title, summary, full_body: body, template_id: 'T01', slug, published_at: new Date().toISOString() };
}

// ─── T03 FORM GUIDE ──────────────────────────────────────────
// Fires once in 48–72h pre-match window. Last 5 results + standing trend.
// recentFixtures: getLastFixtures() array (5 items). standing: BJK row from getStandings().
export async function generateFormGuide(match, recentFixtures, standing, site, env) {
  if (!recentFixtures || recentFixtures.length < 3) return null;

  const formLine = recentFixtures.slice(0, 5).map(f => {
    const res = f.score_bjk > f.score_opp ? 'G' : f.score_bjk < f.score_opp ? 'M' : 'B';
    const venue = f.home ? 'Ev' : 'D';
    const scoreline = f.home
      ? `Beşiktaş ${f.score_bjk}-${f.score_opp} ${f.opponent}`
      : `${f.opponent} ${f.score_opp}-${f.score_bjk} Beşiktaş`;
    return `${f.date} [${venue}] ${scoreline} → ${res}`;
  }).join('\n');

  const formString = recentFixtures.slice(0, 5)
    .map(f => f.score_bjk > f.score_opp ? 'G' : f.score_bjk < f.score_opp ? 'M' : 'B')
    .join('');

  const standingLine = standing
    ? `${standing.rank}. sıra — ${standing.points} puan (${standing.all?.win}G ${standing.all?.draw}B ${standing.all?.lose}M)`
    : '';

  const t03Notes = await getEditorialNotes(env, ['match', 'T03']);
  const prompt = `${t03Notes}Sen Kartalix'in kıdemli spor editörüsün. Beşiktaş'ın ${match.opponent} maçı öncesinde güncel form durumunu analiz eden bir haber yaz.

SON 5 SONUÇ (yeniden eskiye):
${formLine}
Form özeti: ${formString}

PUAN DURUMU:
${standingLine || '(puan durumu verisi yok)'}

ÖNÜMÜZDEKÜ MAÇ: ${match.opponent} — ${match.date} saat ${match.time}

YAZIM KURALLARI:
- 300–400 kelime, analitik haber dili
- Giriş: son 5 maçtaki genel tablonun özeti — "G G M B G" gibi sıralamayı söze dök
- Ev/deplasman ayrımını vurgula
- Puan durumunu ve üst/alt sıra rakiplerine mesafeyi rakamlarla belirt
- Son paragraf: bu form tablosuyla ${match.opponent} maçına girerken beklenti
- Emoji, başlık veya alt başlık yazma — sadece haber gövdesi

Sadece Türkçe haber metnini yaz.`;

  const res  = await callClaude(env, MODEL_GENERATE, prompt, false, 1200);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const title   = `Beşiktaş'ın Formu: ${formString} — ${match.opponent} Maçı Öncesi`;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary,
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    70,
    publish_mode: 'template_form_guide',
    status:       'published',
    template_id:  'T03',
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T03 FORM: "${title.slice(0, 60)}" → ${body.split(/\s+/).length} words`);
  return saved?.[0] || { title, summary, full_body: body, template_id: 'T03', slug, published_at: new Date().toISOString() };
}

// ─── T07 INJURY & SUSPENSION REPORT ──────────────────────────
// Fires once per match in the 24–48h pre-match window.
// injuries: getInjuries() array. rssArticles: recent cached articles for context.
export async function generateInjuryReport(match, injuries, rssArticles, site, env) {
  const injured    = injuries.filter(i => i.type !== 'Suspension');
  const suspended  = injuries.filter(i => i.type === 'Suspension');

  // Supplement with any RSS headlines mentioning injury/suspension keywords
  const injuryKeywords = /sakatlık|sakatland|kadro dışı|cezalı|süspansiyon|suspended|injured|injury/i;
  const rssContext = (rssArticles || [])
    .filter(a => injuryKeywords.test(a.title + ' ' + (a.summary || '')))
    .slice(0, 4)
    .map(a => `- ${a.title}`)
    .join('\n');

  const injuredLines = injured.length
    ? injured.map(p => `${p.name}${p.reason ? ' (' + p.reason + ')' : ''}${p.return && p.return !== 'Unknown' ? ' — tahmini dönüş: ' + p.return : ''}`).join('\n')
    : '(API sakatlık kaydı yok)';

  const suspendedLines = suspended.length
    ? suspended.map(p => `${p.name}${p.reason ? ' (' + p.reason + ')' : ''}`).join('\n')
    : '(API ceza kaydı yok)';

  const t07Notes = await getEditorialNotes(env, ['match', 'T07']);
  const prompt = `${t07Notes}Sen Kartalix'in kıdemli spor editörüsün. Beşiktaş'ın ${match.opponent} maçı öncesinde eksik oyuncu ve cezalı listesini içeren bir haber yaz.

MAÇ: ${match.date} saat ${match.time} — ${match.opponent} — ${match.league}

API VERİSİ — SAKATLAR:
${injuredLines}

API VERİSİ — CEZALILAR:
${suspendedLines}

${rssContext ? 'SON HABERLERDEN İLGİLİ BAŞLIKLAR:\n' + rssContext : ''}

YAZIM KURALLARI:
- 250–350 kelime, haber dili
- Sakatlıklar ve cezalar ayrı ele al
- Dönüş tarihi biliniyorsa belirt; bilinmiyorsa "belirsiz" de
- Kadro etkisini (o oyuncunun pozisyonu, alternatif kim olabilir) değerlendir
- API verisi kesin yokluğu gösterir — haberlerde farklı rakam geçse de API'yi öncele
- Veri yetersizse "kesin bilgi gelmedi, takip edilecek" tonunda yaz
- Emoji, başlık veya alt başlık yazma — sadece haber gövdesi

Sadece Türkçe haber metnini yaz.`;

  const res  = await callClaude(env, MODEL_GENERATE, prompt, false, 1000);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const totalAbsent = injuries.length;
  const title   = totalAbsent > 0
    ? `${match.opponent} Maçı Öncesi ${totalAbsent} Eksik`
    : `${match.opponent} Maçı Öncesi Sakatlık ve Ceza Durumu`;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary,
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    75,
    publish_mode: 'template_injury_report',
    status:       'published',
    template_id:  'T07',
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T07 INJURY: "${title.slice(0, 60)}" → ${body.split(/\s+/).length} words`);
  return saved?.[0] || { title, summary, full_body: body, template_id: 'T07', slug, published_at: new Date().toISOString() };
}

// ─── T02 H2H HISTORY ─────────────────────────────────────────
// Fires once in 24–72h pre-match window. Writes a standalone H2H history article.
// Uses up to 10 past meetings; needs at least 2 to be meaningful.
export async function generateH2HHistory(match, h2h, site, env) {
  if (!h2h || h2h.length < 2) return null;

  const wins   = h2h.filter(f => f.score_bjk > f.score_opp).length;
  const draws  = h2h.filter(f => f.score_bjk === f.score_opp).length;
  const losses = h2h.filter(f => f.score_bjk < f.score_opp).length;
  const goalsFor     = h2h.reduce((s, f) => s + (f.score_bjk ?? 0), 0);
  const goalsAgainst = h2h.reduce((s, f) => s + (f.score_opp ?? 0), 0);

  const matchLines = h2h.slice(0, 10).map(f => {
    const home = f.home ? 'Beşiktaş' : f.opponent;
    const away = f.home ? f.opponent : 'Beşiktaş';
    const res  = f.score_bjk > f.score_opp ? 'G' : f.score_bjk < f.score_opp ? 'M' : 'B';
    return `${f.date} | ${home} ${f.score_bjk ?? '?'}-${f.score_opp ?? '?'} ${away} [BJK: ${res}] — ${f.league}`;
  }).join('\n');

  const t02Notes = await getEditorialNotes(env, ['match', 'T02']);
  const prompt = `${t02Notes}Sen Kartalix'in kıdemli spor editörüsün. Beşiktaş ile ${match.opponent} arasındaki tarihsel rakamları içeren bir H2H geçmiş haberi yaz.

MAÇ BAĞLAMI:
${match.date} saat ${match.time} — ${match.league}${match.round ? ', ' + match.round : ''}

SON ${h2h.length} KARŞILAŞMA (yeniden eskiye):
${matchLines}

ÖZET RAKAMLAR:
${h2h.length} maçta: Beşiktaş ${wins} galibiyet, ${draws} beraberlik, ${losses} mağlubiyet
Beşiktaş toplam gol: ${goalsFor} attı / ${goalsAgainst} yedi

YAZIM KURALLARI:
- 300–400 kelime, profesyonel Türkçe haber dili
- Giriş: iki takım arasındaki rekabetin genel tablosu (kaç maç, galibiyet dağılımı)
- Orta: son maçlardan öne çıkan örüntüler — gol trendi, ağırlıklı ev/deplasman performansı
- Son: bu istatistiklerin önümüzdeki maç için ne anlama geldiği
- Tarihlerden spesifik maç sonuçlarını doğal biçimde kullan
- Emoji, başlık veya alt başlık yazma — sadece haber gövdesi

Sadece Türkçe haber metnini yaz.`;

  const res  = await callClaude(env, MODEL_GENERATE, prompt, false, 1200);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const title   = `Beşiktaş - ${match.opponent} Rekabeti: Tarihsel Rakamlar`;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary,
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    72,
    publish_mode: 'template_h2h',
    status:       'published',
    template_id:  'T02',
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T02 H2H: "${title.slice(0, 60)}" → ${body.split(/\s+/).length} words`);
  return saved?.[0] || { title, summary, full_body: body, template_id: 'T02', slug, published_at: new Date().toISOString() };
}

// ─── T10 GOAL FLASH ───────────────────────────────────────────
// Short article (100–150 words) per goal event during live match.
// goalEvent: a single event object from the API events array.
export async function generateGoalFlash(match, goalEvent, site, env) {
  const scorer  = goalEvent.player?.name  || 'Bilinmeyen';
  const assister = goalEvent.assist?.name || null;
  const minute  = goalEvent.time?.elapsed || '?';
  const isOwnGoal = goalEvent.detail === 'Own Goal';
  const isPenalty = goalEvent.detail === 'Penalty';

  const t10Notes = await getEditorialNotes(env, ['match', 'template', 'T10']);
  const prompt = `${t10Notes}Sen Kartalix'in maç muhabirsin. Beşiktaş maçında gol anını haber yap.

GOL BİLGİSİ:
Dakika: ${minute}'
Atan: ${scorer}${isOwnGoal ? ' (Kendi Kalesine)' : ''}${isPenalty ? ' (Penaltı)' : ''}
${assister ? 'Asist: ' + assister : ''}
Anlık Skor: Beşiktaş ${match.score_bjk ?? 0}-${match.score_opp ?? 0} ${match.opponent} (Beşiktaş ${match.home ? 'ev sahibi' : 'deplasman'})

YAZIM KURALLARI:
- 100–150 kelime, son dakika flash haber üslubu
- İlk cümle: kim, kaçıncı dakikada, nasıl attı
- Skor durumunu belirt
- Kısa ve heyecanlı ama abartısız
- Emoji veya başlık yazma`;

  const res  = await callClaude(env, MODEL_FETCH, prompt, false, 400);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const bjkScore = match.score_bjk ?? 0;
  const oppScore = match.score_opp ?? 0;
  const title    = isOwnGoal
    ? `${minute}' | ${scorer} kendi kalesine — ${match.opponent} ${oppScore}-${bjkScore} Beşiktaş`
    : `${minute}' GOL: ${scorer}! Beşiktaş ${bjkScore}-${oppScore} ${match.opponent}`;
  const slug     = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary:      body.slice(0, 200),
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    90,
    publish_mode: 'template_goal_flash',
    status:       'published',
    template_id:  'T10',
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T10 GOAL FLASH: "${title}"`);
  return saved?.[0] || { title, full_body: body, template_id: 'T10', slug, published_at: new Date().toISOString() };
}

// ─── T11 RESULT FLASH ─────────────────────────────────────────
// 300–400 word post-match result article. Fires on FT detection.
// fixture: normalizeFixture object. players: getFixturePlayers array.
export async function generateResultFlash(fixture, players, site, env, events = []) {
  const bjkWon  = fixture.score_bjk > fixture.score_opp;
  const draw    = fixture.score_bjk === fixture.score_opp;
  const result  = bjkWon ? 'Beşiktaş kazandı' : draw ? 'Beraberlik' : 'Beşiktaş kaybetti';

  const topPlayers = (players || []).slice(0, 3).map(p =>
    `${p.name}: puan ${p.rating}, ${p.goals} gol, ${p.assists} asist, ${p.minutesPlayed} dk`
  ).join('\n') || '(oyuncu verisi yok)';

  const eventsBlock = events.length
    ? events.join('\n')
    : '(maç olayı verisi yok — sadece skoru yaz, emin olmadığın olayları uydurma)';

  const t11Notes = await getEditorialNotes(env, ['match', 'template', 'T11']);
  const prompt = `${t11Notes}Sen Kartalix'in kıdemli spor editörüsün. Biten Beşiktaş maçını haber yap.

MAÇ SONUCU:
${fixture.home ? 'Beşiktaş (Ev)' : 'Beşiktaş (Deplasman)'} vs ${fixture.opponent}
Skor: Beşiktaş ${fixture.score_bjk} - ${fixture.score_opp} ${fixture.opponent}
${fixture.league}${fixture.round ? ' — ' + fixture.round : ''}
Sonuç: ${result}

MAÇ OLAYLARI (dakika, olay, oyuncu, takım):
${eventsBlock}

ÖNE ÇIKAN OYUNCULAR:
${topPlayers}

YAZIM KURALLARI:
- 300–400 kelime, maç sonu haber üslubu
- Sadece MAÇ OLAYLARI bölümündeki gerçek olayları kullan — uydurma
- İlk paragraf: sonuç, skor, önem
- İkinci paragraf: maçın seyri (gol, kart, VAR olaylarını bağlam içinde aktar)
- Üçüncü paragraf: performans değerlendirmesi
- Son paragraf: bu sonucun tablo/hedeflere etkisi
- "Kaynaklara göre" ifadesi kullanma
- Emoji veya başlık yazma — sadece haber gövdesi`;

  const res  = await callClaude(env, MODEL_GENERATE, prompt, false, 1500);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const score   = `${fixture.score_bjk}-${fixture.score_opp}`;
  const title   = fixture.home
    ? `Beşiktaş ${score} ${fixture.opponent} | Maç Sonucu`
    : `${fixture.opponent} ${fixture.score_opp}-${fixture.score_bjk} Beşiktaş | Maç Sonucu`;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary,
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    88,
    publish_mode: 'template_result',
    status:       'published',
    template_id:  'T11',
    fixture_id:   fixture.fixture_id || null,
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T11 RESULT FLASH: "${title}"`);
  return saved?.[0] || { title, summary, full_body: body, template_id: 'T11', fixture_id: fixture.fixture_id || null, slug, published_at: new Date().toISOString() };
}

// ─── T13 MAN OF THE MATCH ─────────────────────────────────────
// Fires after FT, requires at least 3 rated players. Dedicated spotlight
// article on the best-rated BJK player. Distinct from T11 (result) —
// T13 is a player-focused piece for that specific game.
export async function generateManOfTheMatch(fixture, players, site, env) {
  if (!players || players.length < 3) return null;
  const mom = players[0]; // already sorted by rating desc
  if (!mom.rating || mom.rating < 6.0) return null;

  const topThree = players.slice(0, 3).map(p =>
    `${p.name}: ${p.rating} puan, ${p.goals} gol, ${p.assists} asist, ${p.minutesPlayed} dk`
  ).join('\n');

  const result = fixture.score_bjk > fixture.score_opp ? 'galibiyet'
    : fixture.score_bjk === fixture.score_opp ? 'beraberlik' : 'mağlubiyet';
  // Always home_team home_score - away_score away_team
  const scoreline = fixture.home
    ? `Beşiktaş ${fixture.score_bjk ?? '?'}-${fixture.score_opp ?? '?'} ${fixture.opponent}`
    : `${fixture.opponent} ${fixture.score_opp ?? '?'}-${fixture.score_bjk ?? '?'} Beşiktaş`;

  const t13Notes = await getEditorialNotes(env, ['match', 'T13']);
  const prompt = `${t13Notes}Sen Kartalix'in maç muhabirsin. Beşiktaş maçında en iyi performansı sergileyen oyuncuyu öne çıkaran bir haber yaz.

MAÇ: ${scoreline} — ${fixture.league || 'Trendyol Süper Lig'}
SONUÇ: ${result}

OYUNCU PUANLARI (en iyi 3):
${topThree}

OYUN KAHRAMANI: ${mom.name} (${mom.rating} puan)

YAZIM KURALLARI:
- 250–350 kelime, Türkçe haber dili
- Giriş: oyuncunun bu maçtaki belirleyici rolü ve maç sonucu
- Orta: performansın somut detayları — istatistikleri doğal şekilde aktar, kuru liste yapma
- Son: bu performansın sezon ya da takım bağlamındaki anlamı
- Emoji, başlık veya alt başlık yazma — sadece haber gövdesi
- "Maçın adamı" klişesinden kaçın, özgün bir açılış cümlesi kur

Sadece Türkçe haber metnini yaz.`;

  const res  = await callClaude(env, MODEL_GENERATE, prompt, false, 1000);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const resultTag = result === 'galibiyet' ? 'Fırtınası' : result === 'beraberlik' ? 'Performansı' : 'Öne Çıktı';
  const title   = `${mom.name} ${resultTag}: ${scoreline}`;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary,
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    80,
    publish_mode: 'template_motm',
    status:       'published',
    template_id:  'T13',
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T13 MOTM: "${title.slice(0, 60)}" → ${body.split(/\s+/).length} words`);
  return saved?.[0] || { title, summary, full_body: body, template_id: 'T13', slug, published_at: new Date().toISOString() };
}

// ─── T12 MATCH REPORT ─────────────────────────────────────────
// Full post-match analysis ~500 words. Fires after T11/T13.
// Combines: result, xG, possession, shots, top player ratings, key events.
// stats: getFixtureStats output (may be null — degrades gracefully).
export async function generateMatchReport(fixture, players, stats, site, env, events = []) {
  const bjkWon = fixture.score_bjk > fixture.score_opp;
  const draw   = fixture.score_bjk === fixture.score_opp;
  const result = bjkWon ? 'Beşiktaş galip' : draw ? 'Beraberlik' : 'Beşiktaş mağlup';

  const scoreline = fixture.home
    ? `Beşiktaş ${fixture.score_bjk ?? '?'}-${fixture.score_opp ?? '?'} ${fixture.opponent}`
    : `${fixture.opponent} ${fixture.score_opp ?? '?'}-${fixture.score_bjk ?? '?'} Beşiktaş`;

  const topPlayers = (players || []).slice(0, 5).map(p =>
    `${p.name}: ${p.rating} puan, ${p.goals}G ${p.assists}A, ${p.minutesPlayed}dk`
  ).join('\n') || '(oyuncu puanı yok)';

  const statsLines = stats ? [
    stats.xg            != null ? `Beklenen gol (xG): ${stats.xg}` : null,
    stats.possession    != null ? `Top hakimiyeti: ${stats.possession}` : null,
    stats.shots_total   != null ? `Şut: ${stats.shots_total} (isabetli: ${stats.shots_on_target ?? '?'})` : null,
    stats.passes_acc    != null ? `Pas isabeti: ${stats.passes_acc}` : null,
    stats.corners       != null ? `Korner: ${stats.corners}` : null,
    stats.yellow_cards  != null ? `Sarı kart: ${stats.yellow_cards}` : null,
  ].filter(Boolean).join('\n') : '(istatistik verisi yok)';

  const eventsBlock = events.length
    ? events.join('\n')
    : '(maç olayı verisi yok — sadece skoru yaz, emin olmadığın olayları uydurma)';

  const t12Notes = await getEditorialNotes(env, ['match', 'T12']);
  const prompt = `${t12Notes}Sen Kartalix'in kıdemli spor editörüsün. Biten Beşiktaş maçı için kapsamlı bir maç raporu yaz.

MAÇ: ${scoreline}
${fixture.league}${fixture.round ? ' — ' + fixture.round : ''}
${fixture.home ? 'Beşiktaş (Ev)' : 'Beşiktaş (Deplasman)'}
Sonuç: ${result}

MAÇ OLAYLARI (dakika, olay, oyuncu, takım):
${eventsBlock}

BEŞİKTAŞ İSTATİSTİKLERİ:
${statsLines}

OYUNCU PUANLARI (en iyi 5):
${topPlayers}

YAZIM KURALLARI:
- 450–550 kelime, derinlikli maç analizi
- Sadece MAÇ OLAYLARI bölümündeki gerçek olayları kullan — uydurma
- Giriş: skoru, yeri ve anlık tablo etkisini net say
- Olaylar paragrafı: gol, kart, VAR kararlarını kronolojik bağlamda aktar
- xG paragrafı: gerçek gol sayısıyla xG'yi karşılaştır — "hak ettiğinden fazla/az mı kazandı?" sorusunu yanıtla
- Performans paragrafı: en yüksek puanlı oyuncuları bağlam içinde değerlendir
- Son paragraf: bu sonucun sezon hedeflerine somut etkisi
- İstatistikleri doğal dile dök — kuru liste yapma
- Emoji, başlık veya alt başlık yazma — sadece haber gövdesi

Sadece Türkçe haber metnini yaz.`;

  const res  = await callClaude(env, MODEL_GENERATE, prompt, false, 1800);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const title   = `Maç Raporu: ${scoreline}`;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary,
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    85,
    publish_mode: 'template_match_report',
    status:       'published',
    template_id:  'T12',
    fixture_id:   fixture.fixture_id || null,
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T12 MATCH REPORT: "${title.slice(0, 60)}" → ${body.split(/\s+/).length} words`);
  return saved?.[0] || { title, summary, full_body: body, template_id: 'T12', fixture_id: fixture.fixture_id || null, slug, published_at: new Date().toISOString() };
}

// ─── T-VID YOUTUBE EMBED ─────────────────────────────────────
// Embed-only treatment: 1-sentence Haiku intro from video title + YouTube iframe.
// No captions, no facts, no firewall needed — the video IS the content.
export async function generateVideoEmbed(video, site, env) {
  const prompt = `Sen Kartalix'in spor editörüsün. Aşağıdaki YouTube videosunu Türkçe tek bir cümleyle tanıt. Sade, bilgilendirici haber dili kullan. Emoji veya başlık yazma.

Video: ${video.title}
Kanal: ${video.channel_name}

Sadece tanıtım cümlesini yaz.`;

  const res   = await callClaude(env, 'claude-haiku-4-5-20251001', prompt, false, 100);
  const intro = extractText(res.content).trim();
  if (!intro) return null;

  const full_body = `<p>${intro}</p>\n<div class="yt-embed" style="margin:1.5rem 0"><iframe width="100%" height="380" src="https://www.youtube.com/embed/${video.video_id}" frameborder="0" allowfullscreen loading="lazy" style="border-radius:6px;display:block"></iframe></div>`;
  const title     = video.title;
  const slug      = generateSlug(title, video.published_at);
  const nvs       = video.channel_tier === 'official' ? 82 : 72;

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'youtube',
    source_name:  video.channel_name,
    original_url: `https://www.youtube.com/watch?v=${video.video_id}`,
    title,
    summary:      intro,
    full_body,
    category:     'Video',
    content_type: 'youtube_embed',
    sport:        'football',
    nvs_score:    nvs,
    publish_mode: 'youtube_embed',
    status:       'published',
    template_id:  'T-VID',
    slug,
    published_at: video.published_at,
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T-VID: "${title.slice(0, 60)}" [${video.channel_name}]`);
  return saved?.[0] || { title, summary: intro, full_body, template_id: 'T-VID', slug,
    published_at: video.published_at, source_name: video.channel_name, nvs_score: nvs };
}

// ─── MATCH VIDEO TEMPLATES ───────────────────────────────────
// T-VID-HLT highlights / T-VID-GOL goal clip / T-VID-INT interview /
// T-VID-BP press conference / T-VID-REF referee analysis.
// All Super Lig only. match = nextMatch object from backgroundWork.
export async function generateMatchVideoEmbed(video, videoType, match, site, env) {
  const opp  = match?.opponent || 'rakip';
  const isPost = video.published_at > (match?.kickoff_iso || '');

  const typeConfig = {
    highlights: {
      template: 'T-VID-HLT', nvs: 85,
      prompt: `Beşiktaş'ın ${opp} karşısındaki Trendyol Süper Lig maçının özetini gösteren bu videoyu Türkçe 1-2 cümleyle tanıt. Sade haber dili, emoji yok.`,
    },
    goal_bjk: {
      template: 'T-VID-GOL', nvs: 80,
      prompt: `Beşiktaş'ın ${opp} karşısındaki maçta attığı golü gösteren bu klip için Türkçe 1 cümlelik tanıtım yaz. Sade haber dili, emoji yok.`,
    },
    press_conf: {
      template: 'T-VID-BP', nvs: 82,
      prompt: `Beşiktaş teknik direktörünün ${opp} maçı ${isPost ? 'sonrası' : 'öncesi'} basın toplantısını tanıtan Türkçe 1 cümle yaz. Sade haber dili, emoji yok.`,
    },
    interview: {
      template: 'T-VID-INT', nvs: 78,
      prompt: `Beşiktaş ${opp} maçı ${isPost ? 'sonrası' : 'öncesi'} röportajını tanıtan Türkçe 1 cümle yaz. Sade haber dili, emoji yok.`,
    },
    referee: {
      template: 'T-VID-REF', nvs: 72,
      prompt: `Beşiktaş ${opp} karşılaşmasındaki hakem kararlarını değerlendiren bu videoyu tanıtan Türkçe 1 cümle yaz. Sade haber dili, emoji yok.`,
    },
  };

  const cfg = typeConfig[videoType] || typeConfig.interview;

  const res   = await callClaude(env, 'claude-haiku-4-5-20251001',
    `Sen Kartalix'in spor editörüsün. ${cfg.prompt}\n\nVideo başlığı: ${video.title}\nKanal: ${video.channel_name}\n\nSadece tanıtım metnini yaz.`,
    false, 150);
  const intro = extractText(res.content).trim();
  if (!intro) return null;

  const full_body = `<p>${intro}</p>\n<div class="yt-embed" style="margin:1.5rem 0"><iframe width="100%" height="380" src="https://www.youtube.com/embed/${video.video_id}" frameborder="0" allowfullscreen loading="lazy" style="border-radius:6px;display:block"></iframe></div>`;
  const title     = video.title;
  const slug      = generateSlug(title, video.published_at);

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'youtube',
    source_name:  video.channel_name,
    original_url: `https://www.youtube.com/watch?v=${video.video_id}`,
    title,
    summary:      intro,
    full_body,
    category:     'Video',
    content_type: 'youtube_embed',
    sport:        'football',
    nvs_score:    cfg.nvs,
    publish_mode: `youtube_${videoType}`,
    status:       'published',
    template_id:  cfg.template,
    slug,
    published_at: video.published_at,
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`${cfg.template}: "${title.slice(0, 60)}" [${video.channel_name}]`);
  return saved?.[0] || { title, summary: intro, full_body, template_id: cfg.template, slug,
    published_at: video.published_at, source_name: video.channel_name, nvs_score: cfg.nvs };
}

// ─── T-xG DELTA ──────────────────────────────────────────────
// Post-match edge case: fires only when |BJK goals − BJK xG| > 1.2.
// stats: getFixtureStats output. Must have stats.xg to fire.
export async function generateXGDelta(fixture, stats, site, env) {
  if (!stats || stats.xg == null) return null;
  const xg    = parseFloat(stats.xg);
  const goals = fixture.score_bjk ?? 0;
  const delta = goals - xg;
  if (Math.abs(delta) <= 1.2) return null;

  const overPerformed = delta > 0;
  const scoreline = fixture.home
    ? `Beşiktaş ${fixture.score_bjk ?? '?'}-${fixture.score_opp ?? '?'} ${fixture.opponent}`
    : `${fixture.opponent} ${fixture.score_opp ?? '?'}-${fixture.score_bjk ?? '?'} Beşiktaş`;

  const statsLines = [
    `Beşiktaş golleri: ${goals}`,
    `Beklenen gol (xG): ${xg.toFixed(2)}`,
    `Fark: ${delta > 0 ? '+' : ''}${delta.toFixed(2)}`,
    stats.shots_total   != null ? `Şut: ${stats.shots_total} (isabetli: ${stats.shots_on_target ?? '?'})` : null,
    stats.possession    != null ? `Top hakimiyeti: ${stats.possession}` : null,
  ].filter(Boolean).join('\n');

  const txgNotes = await getEditorialNotes(env, ['match', 'T12']);
  const prompt = `${txgNotes}Sen Kartalix'in veri analistsin. Beşiktaş bu maçta beklenen golün ${overPerformed ? 'belirgin şekilde üzerinde' : 'belirgin şekilde altında'} gol attı. Bu istatistiksel tabloyu analiz eden kısa bir haber yaz.

MAÇ: ${scoreline}
${fixture.league}${fixture.round ? ' — ' + fixture.round : ''}

BEŞİKTAŞ İSTATİSTİKLERİ:
${statsLines}

YAZIM KURALLARI:
- 200–300 kelime, analitik ton
- Giriş: xG ile gerçek gol sayısı arasındaki farkı somut rakamlarla belirt ("beklenen gol sayısı" kavramını bir cümlede tanımla)
- Orta: bu farkın ne anlama geldiğini açıkla — ${overPerformed ? 'şans faktörü mü, kaleci üstü bitiricilik mi?' : 'pozisyon israfı mı, rakip kalecisi mi?'}
- Son: bu trendin sezon bağlamındaki anlamı
- Emoji, başlık veya alt başlık yazma — sadece haber gövdesi

Sadece Türkçe haber metnini yaz.`;

  const res  = await callClaude(env, MODEL_GENERATE, prompt, false, 900);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const direction = overPerformed ? 'Üstünde' : 'Altında';
  const title   = `xG Analizi: Beşiktaş Beklentinin ${direction} — ${scoreline}`;
  const summary = body.replace(/\n+/g, ' ').slice(0, 300);
  const slug    = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id:      site.id,
    source_type:  'kartalix',
    source_name:  'Kartalix',
    original_url: '',
    title,
    summary,
    full_body:    body,
    category:     'Match',
    content_type: 'kartalix_generated',
    sport:        'football',
    nvs_score:    78,
    publish_mode: 'template_xg_delta',
    status:       'published',
    template_id:  'T-XG',
    slug,
    published_at: new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    reviewed_by:  'auto',
  });

  console.log(`T-XG DELTA: "${title.slice(0, 60)}" delta=${delta.toFixed(2)} → ${body.split(/\s+/).length} words`);
  return saved?.[0] || { title, summary, full_body: body, template_id: 'T-XG', slug, published_at: new Date().toISOString() };
}

// ─── T-HT HALFTIME REPORT ─────────────────────────────────────
// Fires once when liveFixture.status === 'HT'. Summarises first half.
// allEvents: raw /fixtures/events response array for the fixture.
export async function generateHalftimeReport(match, allEvents, site, env) {
  const bjkGoals = (allEvents || []).filter(e => e.type === 'Goal' && e.team?.id === 549 && e.detail !== 'Missed Penalty');
  const oppGoals = (allEvents || []).filter(e => e.type === 'Goal' && e.team?.id !== 549 && e.detail !== 'Missed Penalty');
  const bjkCards = (allEvents || []).filter(e => e.type === 'Card' && e.team?.id === 549);
  const oppCards = (allEvents || []).filter(e => e.type === 'Card' && e.team?.id !== 549);

  const htNotes = await getEditorialNotes(env, ['match', 'template', 'T-HT']);
  const prompt = `${htNotes}Sen Kartalix'in maç muhabirsin. İlk yarı sona erdi. Kısa devre özeti yaz.

MAÇ: Beşiktaş (${match.home ? 'ev sahibi' : 'deplasman'}) vs ${match.opponent}
DEVRE SKORU: Beşiktaş ${match.score_bjk ?? 0}-${match.score_opp ?? 0} ${match.opponent}

İLK YARI OLAYLARI:
BJK Golleri: ${bjkGoals.length > 0 ? bjkGoals.map(e => `${e.time?.elapsed}' ${e.player?.name}${e.detail === 'Own Goal' ? ' (KK)' : e.detail === 'Penalty' ? ' (P)' : ''}`).join(', ') : 'Yok'}
Rakip Golleri: ${oppGoals.length > 0 ? oppGoals.map(e => `${e.time?.elapsed}' ${e.player?.name}${e.detail === 'Own Goal' ? ' (KK)' : ''}`).join(', ') : 'Yok'}
BJK Kartları: ${bjkCards.length > 0 ? bjkCards.map(e => `${e.time?.elapsed}' ${e.player?.name} (${e.detail})`).join(', ') : 'Yok'}
Rakip Kartları: ${oppCards.length > 0 ? oppCards.map(e => `${e.time?.elapsed}' ${e.player?.name} (${e.detail})`).join(', ') : 'Yok'}

YAZIM KURALLARI:
- 120–180 kelime, devre arası flash haber üslubu
- İlk cümle skoru ve genel durumu özetle
- Öne çıkan olayları belirt
- İkinci yarı için tek cümle beklenti
- Emoji veya başlık yazma`;

  const res  = await callClaude(env, MODEL_FETCH, prompt, false, 500);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const bjk  = match.score_bjk ?? 0;
  const opp  = match.score_opp ?? 0;
  const title = bjk > opp
    ? `Devre: Beşiktaş ${bjk}-${opp} önde (${match.opponent})`
    : bjk === opp
    ? `Devre: Beraberlik — Beşiktaş ${bjk}-${opp} ${match.opponent}`
    : `Devre: Beşiktaş ${bjk}-${opp} geride (${match.opponent})`;
  const slug = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id: site.id, source_type: 'kartalix', source_name: 'Kartalix', original_url: '',
    title, summary: body.slice(0, 200), full_body: body, category: 'Match',
    content_type: 'kartalix_generated', sport: 'football', nvs_score: 85,
    publish_mode: 'template_halftime', status: 'published', template_id: 'T-HT',
    slug, published_at: new Date().toISOString(), reviewed_at: new Date().toISOString(), reviewed_by: 'auto',
  });
  console.log(`T-HT HALFTIME: "${title}"`);
  return saved?.[0] || { title, full_body: body, template_id: 'T-HT', slug, published_at: new Date().toISOString() };
}

// ─── T-RED RED CARD FLASH ─────────────────────────────────────
// Fires on any new Red Card or Yellow+Red event for either team.
// cardEvent: single event from /fixtures/events (type === 'Card').
export async function generateRedCardFlash(match, cardEvent, site, env) {
  const player   = cardEvent.player?.name || 'Bilinmeyen';
  const minute   = cardEvent.time?.elapsed || '?';
  const isOurs   = cardEvent.team?.id === 549;
  const isSecond = (cardEvent.detail || '').toLowerCase().includes('yellow red');

  const notes = await getEditorialNotes(env, ['match', 'template', 'T-RED']);
  const prompt = `${notes}Sen Kartalix'in maç muhabirsin. Kırmızı kart haberi yaz.

KART: ${minute}' — ${player} (${isOurs ? 'Beşiktaş' : match.opponent})
TÜR: ${isSecond ? 'İkinci sarı — kırmızı kart' : 'Direkt kırmızı kart'}
ANLИК SKOR: Beşiktaş ${match.score_bjk ?? 0}-${match.score_opp ?? 0} ${match.opponent}

YAZIM KURALLARI:
- 80–120 kelime, son dakika flash
- Kim, hangi takım, kaçıncı dakika, kart türü
- ${isOurs ? 'Beşiktaş 10 kişi kaldı — dezavantajı belirt' : 'Rakip 10 kişi kaldı — üstünlüğü belirt'}
- Emoji veya başlık yazma`;

  const res  = await callClaude(env, MODEL_FETCH, prompt, false, 350);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const title = isOurs
    ? `${minute}' KIRMIZI KART — Beşiktaş 10 kişi: ${player}`
    : `${minute}' KIRMIZI KART — ${match.opponent} 10 kişi: ${player}`;
  const slug = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id: site.id, source_type: 'kartalix', source_name: 'Kartalix', original_url: '',
    title, summary: body.slice(0, 200), full_body: body, category: 'Match',
    content_type: 'kartalix_generated', sport: 'football', nvs_score: 88,
    publish_mode: 'template_red_card', status: 'published', template_id: 'T-RED',
    slug, published_at: new Date().toISOString(), reviewed_at: new Date().toISOString(), reviewed_by: 'auto',
  });
  console.log(`T-RED CARD FLASH: "${title}"`);
  return saved?.[0] || { title, full_body: body, template_id: 'T-RED', slug, published_at: new Date().toISOString() };
}

// ─── T-VAR VAR DECISION FLASH ─────────────────────────────────
// Fires on any new VAR event detected in /fixtures/events.
// varEvent: single event from /fixtures/events (type === 'Var').
export async function generateVARFlash(match, varEvent, site, env) {
  const minute  = varEvent.time?.elapsed || '?';
  const detail  = varEvent.detail  || '';
  const player  = varEvent.player?.name || '';
  const comment = varEvent.comments || '';

  const notes = await getEditorialNotes(env, ['match', 'template', 'T-VAR']);
  const prompt = `${notes}Sen Kartalix'in maç muhabirsin. VAR kararı haberi yaz.

VAR OLAYI: ${minute}' — ${detail}
${player ? 'İlgili Oyuncu: ' + player : ''}
${comment ? 'Açıklama: ' + comment : ''}
ANLИК SKOR: Beşiktaş ${match.score_bjk ?? 0}-${match.score_opp ?? 0} ${match.opponent}

YAZIM KURALLARI:
- 80–120 kelime, son dakika flash
- VAR kararının ne olduğunu ve sonucunu açıkla
- Maça etkisini belirt
- Emoji veya başlık yazma`;

  const res  = await callClaude(env, MODEL_FETCH, prompt, false, 350);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const title = `${minute}' VAR: ${detail || 'Karar inceleniyor'} — Beşiktaş ${match.score_bjk ?? 0}-${match.score_opp ?? 0} ${match.opponent}`;
  const slug  = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id: site.id, source_type: 'kartalix', source_name: 'Kartalix', original_url: '',
    title, summary: body.slice(0, 200), full_body: body, category: 'Match',
    content_type: 'kartalix_generated', sport: 'football', nvs_score: 85,
    publish_mode: 'template_var', status: 'published', template_id: 'T-VAR',
    slug, published_at: new Date().toISOString(), reviewed_at: new Date().toISOString(), reviewed_by: 'auto',
  });
  console.log(`T-VAR FLASH: "${title}"`);
  return saved?.[0] || { title, full_body: body, template_id: 'T-VAR', slug, published_at: new Date().toISOString() };
}

// ─── T-PEN MISSED PENALTY FLASH ───────────────────────────────
// Fires when a Missed Penalty event appears in /fixtures/events (either team).
// penEvent: single event from /fixtures/events (detail === 'Missed Penalty').
export async function generateMissedPenaltyFlash(match, penEvent, site, env) {
  const player = penEvent.player?.name || 'Bilinmeyen';
  const minute = penEvent.time?.elapsed || '?';
  const isOurs = penEvent.team?.id === 549;

  const notes = await getEditorialNotes(env, ['match', 'template', 'T-PEN']);
  const prompt = `${notes}Sen Kartalix'in maç muhabirsin. Kaçırılan penaltı haberi yaz.

PENALTİ: ${minute}' — ${player} (${isOurs ? 'Beşiktaş' : match.opponent}) penaltı kaçırdı
ANLІК SKOR: Beşiktaş ${match.score_bjk ?? 0}-${match.score_opp ?? 0} ${match.opponent}

YAZIM KURALLARI:
- 80–120 kelime, son dakika flash
- Kim, hangi dakika, hangi takım
- ${isOurs ? 'Beşiktaş için kaçırılan fırsat — psikolojik etkiyi belirt' : 'Rakip penaltı kaçırdı — avantajı belirt'}
- Emoji veya başlık yazma`;

  const res  = await callClaude(env, MODEL_FETCH, prompt, false, 350);
  const body = extractText(res.content).trim();
  if (!body) return null;

  const title = isOurs
    ? `${minute}' Beşiktaş penaltı kaçırdı — ${player}`
    : `${minute}' ${match.opponent} penaltı kaçırdı — ${player}`;
  const slug  = generateSlug(title, new Date().toISOString());

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id: site.id, source_type: 'kartalix', source_name: 'Kartalix', original_url: '',
    title, summary: body.slice(0, 200), full_body: body, category: 'Match',
    content_type: 'kartalix_generated', sport: 'football', nvs_score: 82,
    publish_mode: 'template_missed_pen', status: 'published', template_id: 'T-PEN',
    slug, published_at: new Date().toISOString(), reviewed_at: new Date().toISOString(), reviewed_by: 'auto',
  });
  console.log(`T-PEN MISSED PENALTY: "${title}"`);
  return saved?.[0] || { title, full_body: body, template_id: 'T-PEN', slug, published_at: new Date().toISOString() };
}

// ─── ORIGINAL NEWS SYNTHESIS ──────────────────────────────────
// Generates an original Kartalix article from 1-3 P4 source articles
// covering the same story. No source attribution — pure Kartalix voice.
export async function generateOriginalNews(sources, site, env) {
  const sourceBlocks = sources.map((a, i) =>
    `[Kaynak ${i + 1}] Başlık: ${a.title}\n${(a.summary || '').slice(0, 600)}`
  ).join('\n\n');

  const [editorialCtx, groundingCtx] = await Promise.all([
    getEditorialNotes(env, ['general', 'style']),
    buildGroundingContext(env),
  ]);

  const isNationalTeam = sources.some(a =>
    /milli takım|milli maç|a milli|b milli|national team|türkiye \d|\d\. türkiye/i.test(a.title + ' ' + (a.summary || ''))
  );
  const isOtherSport = sources.some(a =>
    /hentbol|basketbol|voleybol|e-?spor/i.test(a.title + ' ' + (a.summary || ''))
  );

  const hasBjkPlayer = sources.some(a =>
    /beşiktaş(lı|'tan|'ın|'a)?/i.test(a.title + ' ' + (a.summary || ''))
  );
  const sportCtx = isNationalTeam
    ? hasBjkPlayer
      ? `\nMİLLİ TAKIM HABERİ: Haberde Beşiktaşlı oyuncuların performansını ön plana çıkar — oynadığı dakikalar, attığı goller/asistler, önemli anlar. Beşiktaş bağlantısını güçlü tut.`
      : `\nMİLLİ TAKIM HABERİ: Türk millî takımının sonucunu ve önemli anları anlat. Dünya Kupası veya büyük turnuva bağlamında Türk spor kamuoyunun ilgisini çekecek bir haber yaz. Beşiktaşlı oyuncu varsa özellikle belirt, yoksa genel millî heyecanı yansıt.`
    : isOtherSport
    ? `\nDİĞER SPOR DALI: Beşiktaş'ın bu branştaki başarısını futbol fanatiği bir okuyucuya da heyecan verecek şekilde anlat — kulüp kimliğini, turnuva bağlamını ve skoru net ortaya koy.`
    : '';

  const prompt = `Sen Kartalix'in Beşiktaş spor editörüsün. Aşağıdaki kaynak bilgilerden yola çıkarak tamamen özgün bir Kartalix haberi yaz.${editorialCtx}${sportCtx}${groundingCtx}

${sourceBlocks}

KURALLAR:
- 300–400 kelime, Türkçe
- Hiçbir kaynağa atıf yapma — "kaynağına göre", "iddia ediyor", "bildirildi" gibi ifadeler yasak
- Bilgiyi Kartalix'in kendi sesi olarak doğrudan sun
- Haber cümlesiyle başla (kim, ne, ne zaman)
- BJK taraftarının perspektifinden, analitik ve güçlü bir ses tonu
- Paragraflar arası boş satır bırak
- DOĞRULANMIŞ VERİLERle çelişen durum yorumu yapma
- Sadece haber metnini yaz, başlık ekleme`;

  const res = await callClaude(env, MODEL_GENERATE, prompt, false, 800);
  let body = extractText(res.content).trim();
  if (!body || body.length < 150) return null;

  let needsReview = false;
  let verificationResult = null;
  const verification = await verifyArticle(body, groundingCtx, env);
  if (!verification.passed && verification.issues.length > 0) {
    console.log(`ORIGINAL NEWS VERIFY FAIL: ${verification.issues.join('; ')}`);
    try {
      const fixPrompt = prompt + `\n\nDİKKAT — aşağıdaki olgusal hatalar tespit edildi, düzelt:\n${verification.issues.join('\n')}`;
      const res2 = await callClaude(env, MODEL_GENERATE, fixPrompt, false, 800);
      const body2 = extractText(res2.content).trim();
      if (body2.length > 150) { body = body2; verificationResult = { passed: true, regenerated: true, issues: [] }; }
      else { needsReview = true; verificationResult = verification; }
    } catch { needsReview = true; verificationResult = verification; }
  } else {
    verificationResult = verification;
  }

  const primary = sources[0];
  const slug = generateSlug(primary.title, new Date().toISOString().slice(0, 10));

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id: site.id, source_type: 'kartalix', source_name: 'Kartalix', original_url: '',
    title: primary.title, summary: body.slice(0, 220), full_body: body,
    category: primary.category || 'Club', content_type: 'kartalix_generated',
    sport: 'football', nvs_score: primary.nvs || 65,
    publish_mode: 'original_synthesis', status: 'published',
    needs_review: needsReview, verification_result: verificationResult,
    slug, published_at: new Date().toISOString(), reviewed_at: new Date().toISOString(), reviewed_by: 'auto',
  }).catch(() => null);

  console.log(`ORIGINAL NEWS: "${primary.title?.slice(0, 60)}" (${sources.length} source(s))`);
  return {
    title:               primary.title,
    summary:             body.slice(0, 220),
    full_body:           body,
    source_name:         'Kartalix',
    source:              'Kartalix',
    published_at:        new Date().toISOString(),
    is_kartalix_content: true,
    is_template:         false,
    publish_mode:        'original_synthesis',
    nvs:                 primary.nvs || 65,
    category:            primary.category || 'Club',
    slug,
    url:                 '',
    source_url:          '',
    image_url:           '',
    is_p4:               false,
    is_fresh:            true,
    sport:               'football',
    template_id:         null,
    fixture_id:          null,
    needs_review:        needsReview,
    verification_result: verificationResult,
    ...(saved?.[0] ? { id: saved[0].id } : {}),
  };
}

// Daily digest of Fırat Günayer's Rabona Digital videos.
// Combines transcripts from all of today's videos into one analysis article.
// Called once per day — caller must gate with a KV date-key.
export async function generateRabonaDigest(videos, transcripts, site, env) {
  if (!transcripts.length) return null;

  const today = new Date().toISOString().slice(0, 10);
  const videoBlocks = transcripts.map((t, i) =>
    `[Video ${i + 1}] "${videos[i].title}"\n${t.slice(0, 800)}`
  ).join('\n\n---\n\n');

  const prompt = `Sen Kartalix'in Beşiktaş spor editörüsün. Fırat Günayer, Rabona Digital'de bugün Beşiktaş hakkında analiz videoları yayınladı. Aşağıda bu videoların transkriptleri var.

${videoBlocks}

GÖREV: Bu transkriptlerden yola çıkarak Fırat Günayer'in bugünkü Beşiktaş analizini özetleyen özgün bir Kartalix haberi yaz.

KURALLAR:
- İlk satır: okuyucunun tıklamak isteyeceği, merak uyandıran Türkçe bir başlık. Gerçek içeriği yansıtsın, clickbait olmasın. "BAŞLIK: " öneki ile yaz.
- Ardından boş bir satır bırak
- 250–350 kelime haber metni
- "Fırat Günayer'e göre" veya benzeri atıf kullanabilirsin
- En önemli görüş ve argümanları ön plana çıkar
- BJK taraftarının ilgisini çekecek analitik dil kullan
- Paragraflar arası boş satır bırak`;

  const res = await callClaude(env, MODEL_GENERATE, prompt, false, 750);
  const raw  = extractText(res.content).trim();
  if (!raw || raw.length < 150) return null;

  const titleMatch = raw.match(/^BAŞLIK:\s*(.+)/m);
  const title = titleMatch ? titleMatch[1].trim() : videos[0].title;
  const body  = raw.replace(/^BAŞLIK:.*\n+/m, '').trim();
  if (body.length < 150) return null;
  const slug  = generateSlug(title, today);

  const saved = await supabase(env, 'POST', '/rest/v1/content_items', {
    site_id: site.id, source_type: 'youtube', source_name: 'Rabona Digital',
    original_url: `https://www.youtube.com/c/RabonaDigital`,
    title, summary: body.slice(0, 220), full_body: body,
    category: 'Analiz', content_type: 'kartalix_generated',
    sport: 'football', nvs_score: 74,
    publish_mode: 'rabona_digest', status: 'published',
    slug, published_at: new Date().toISOString(),
    reviewed_at: new Date().toISOString(), reviewed_by: 'auto',
  }).catch(() => null);

  console.log(`RABONA DIGEST: ${transcripts.length} video(s) → "${title.slice(0, 60)}"`);
  return {
    title, summary: body.slice(0, 220), full_body: body,
    source_name: 'Rabona Digital', source: 'Rabona Digital',
    published_at: new Date().toISOString(),
    is_kartalix_content: true, is_template: false,
    publish_mode: 'rabona_digest', nvs: 74,
    category: 'Analiz', slug, url: '', source_url: '',
    image_url: '', is_p4: false, is_fresh: true, sport: 'football',
    template_id: null, fixture_id: null,
    ...(saved?.[0] ? { id: saved[0].id } : {}),
  };
}
