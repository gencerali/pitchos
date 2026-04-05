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

// ─── FETCH FULL SOURCE CONTENT (no Claude) ───────────────────
// Returns { content, image_url }
export async function fetchSourceContent(url) {
  if (!url || url === '#') return { content: '', image_url: '' };
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kartalix/1.0)' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { content: '', image_url: '' };
    const html = await res.text();
    const image_url = extractOGImage(html.slice(0, 5000));
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const start = text.search(/beşiktaş|besiktas|bjk/i);
    const excerpt = start > 100 ? text.slice(start - 100) : text;
    return { content: excerpt.slice(0, 4000), image_url };
  } catch (e) {
    console.error('fetchSourceContent failed:', url, e.message);
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

// ─── WRITE ARTICLES (decision-based, no Sonnet) ───────────────
export async function writeArticles(articles, site, env) {
  const results = [];

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const mode = decidePublishMode(article);
    let published = { ...article, publish_mode: mode };

    if (i === 0) {
      console.log('ARTICLE 1 mode:', mode);
      console.log('ARTICLE 1 url:', article.url);
      console.log('ARTICLE 1 full_body before:', article.full_body?.length || 0);
    }

    if (mode === 'template_matchday') {
      const written = await writeMatchDay(article, env);
      if (written) published = written;
      else published.summary = cleanRSS(article.summary || article.description || '');
      await new Promise(r => setTimeout(r, 300));

    } else if (mode === 'copy_source') {
      const fetched  = await fetchSourceContent(article.url);
      const content  = fetched?.content  || '';
      const ogImage  = fetched?.image_url || '';
      console.log(`copy_source [${article.title?.slice(0, 40)}]: content=${content.length} chars, img=${!!ogImage}`);
      if (i === 0) {
        console.log('ARTICLE 1 fetchSourceContent result:', {
          content_length: fetched?.content?.length || 0,
          image_url: fetched?.image_url || 'none',
          first_100_chars: fetched?.content?.slice(0, 100) || 'empty',
        });
      }
      published = {
        ...article,
        publish_mode: 'copy_source',
        full_body:  content.length > 100 ? content : cleanRSS(article.summary || ''),
        summary:    content.length > 100
          ? content.slice(0, 300).replace(/\s+/g, ' ').trim()
          : cleanRSS(article.summary || ''),
        image_url:  ogImage || article.image_url || '',
      };
      if (i === 0) {
        console.log('ARTICLE 1 full_body after:', published.full_body?.length || 0);
      }
      await new Promise(r => setTimeout(r, 300));

    } else {
      published.summary    = cleanRSS(article.summary || article.description || '');
      published.full_body  = published.summary;
      // Fetch og:image for rss_summary articles that have a real URL
      if (article.url && article.url !== '#' && !article.image_url) {
        published.image_url = await fetchOGImage(article.url);
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
export async function cacheToKV(env, site, toPublish, toQueue) {
  const existing   = await getCachedArticles(env, site.short_code);
  const mergedKV   = mergeAndDedupe([...toPublish, ...toQueue, ...existing], 20);
  console.log(`KV cache: ${mergedKV.length} articles, full_body lengths: ${mergedKV.map(a => a.full_body?.length || 0).join(',')}`);
  console.log('KV CACHE article 1 full_body:', mergedKV[0]?.full_body?.length || 0);
  await env.PITCHOS_CACHE.put(
    `articles:${site.short_code}`,
    JSON.stringify(mergedKV.map(a => ({
      title:        a.title        || '',
      summary:      cleanRSS(a.summary || a.description || ''),
      full_body:    a.full_body ? cleanRSS(a.full_body) : cleanRSS(a.summary || a.description || ''),
      source:       a.source       || a.source_name || '',
      url:          a.url          || a.original_url || '',
      category:     a.category     || 'Haber',
      nvs:          a.nvs          || a.nvs_score   || 0,
      golden_score: a.golden_score || null,
      time_ago:     a.time_ago     || 'Güncel',
      is_fresh:     a.is_fresh     ?? true,
      sport:        a.sport        || 'football',
      publish_mode: a.publish_mode || 'rss_summary',
      image_url:    a.image_url    || '',
    }))),
    { expirationTtl: 7200 }
  );
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
    .sort((a, b) => (b.nvs || 0) - (a.nvs || 0))
    .slice(0, limit);
}
