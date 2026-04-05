import { callClaude, MODEL_FETCH, extractText, sleep } from './utils.js';
import { BJK_REGEX, CUTOFF_48H } from './processor.js';

// ─── RSS FEEDS ────────────────────────────────────────────────
// trust values: official, broadcast, press, journalist, international, aggregator
// titleOnly: only check title for keyword match (international sources)
// ntvFallback: HTML fallback URL if RSS returns 0 items
export const RSS_FEEDS = [
  { url: 'https://www.ntvspor.net/rss/kategori/futbol',   name: 'NTV Spor',          trust: 'broadcast',     sport: 'football', ntvFallback: 'https://www.ntvspor.net/futbol/takim/besiktas' },
  { url: 'https://www.fotomac.com.tr/rss/Besiktas.xml',   name: 'Fotomaç',           trust: 'press',         sport: 'football' },
  { url: 'https://www.fotomac.com.tr/rss/Basketbol.xml',  name: 'Fotomaç Basketbol', trust: 'press',         sport: 'basketball' },
  { url: 'https://www.ahaber.com.tr/rss/besiktas.xml',    name: 'A Haber',           trust: 'press',         sport: 'football' },
  { url: 'https://www.trthaber.com/spor_articles.rss',    name: 'TRT Haber',         trust: 'broadcast',     sport: 'football' },
  { url: 'https://www.aspor.com.tr/rss/anasayfa.xml',     name: 'A Spor',            trust: 'broadcast',     sport: 'football' },
  { url: 'https://www.hurriyet.com.tr/rss/spor',          name: 'Hürriyet',          trust: 'press',         sport: 'football' },
  { url: 'https://www.transfermarkt.com/rss/news',        name: 'Transfermarkt',     trust: 'international', sport: 'football', titleOnly: true },
  { url: 'https://www.skysports.com/rss/12040',           name: 'Sky Sports',        trust: 'international', sport: 'football', titleOnly: true },
];

// ─── RSS FETCH ────────────────────────────────────────────────
export async function fetchRSSArticles(site) {
  const results = await Promise.allSettled(RSS_FEEDS.map(feed => fetchOneFeed(feed, site)));
  const articles = [];
  for (const r of results) {
    if (r.status === 'fulfilled') articles.push(...r.value);
    else console.error(`RSS feed failed: ${r.reason?.message}`);
  }
  // Cap total combined articles at 40 before scoring
  return articles.slice(0, 40);
}

async function fetchOneFeed(feed, site) {
  const sourceName = feed.name || feed.source;
  const trustTier  = feed.trust || feed.trust_tier || 'unknown';
  const feedSport  = feed.sport || 'football';
  const titleOnly  = feed.titleOnly || false;

  let res;
  try {
    res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PitchOS/1.0)' }, cf: { cacheTtl: 300 } });
  } catch (e) {
    console.error(`RSS [${sourceName}]: fetch error ${e.message}`);
    return feed.ntvFallback ? fetchNTVSporFromHTML(feed.ntvFallback, sourceName) : [];
  }
  if (!res.ok) {
    console.error(`RSS [${sourceName}]: HTTP ${res.status}`);
    return feed.ntvFallback ? fetchNTVSporFromHTML(feed.ntvFallback, sourceName) : [];
  }

  const xml = await res.text();
  const cutoff = Date.now() - CUTOFF_48H;
  const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
  console.log(`RSS [${sourceName}]: ${items.length} total items in feed`);

  if (items.length === 0 && feed.ntvFallback) {
    return fetchNTVSporFromHTML(feed.ntvFallback, sourceName);
  }

  let recentCount = 0;
  const articles = [];

  for (const item of items) {
    const title      = stripCDATA(getTag(item, 'title'));
    const rawDesc    = stripCDATA(getTag(item, 'description'));
    const rawContent = stripCDATA(getTagNS(item, 'content:encoded') || getTagNS(item, 'content'));
    const url_       = getRSSLink(item) || getTag(item, 'guid') || '';
    const pubDate    = getTag(item, 'pubDate') || getTag(item, 'dc:date') || getTag(item, 'updated');
    let published_at = null, pubMs = 0;
    if (pubDate) {
      const d = new Date(pubDate);
      if (!isNaN(d.getTime())) { published_at = d.toISOString(); pubMs = d.getTime(); }
    }
    const image_url = getEnclosureUrl(item);

    if (pubMs && pubMs < cutoff) continue;
    recentCount++;

    const haystack = titleOnly
      ? title.toLowerCase()
      : (title + ' ' + rawDesc + ' ' + rawContent).toLowerCase();
    if (!BJK_REGEX.test(haystack)) continue;

    const summary   = stripHTML(rawDesc).slice(0, 500) || title;
    const full_text = rawContent
      ? rawContent.split(/<br\s*\/?>|<\/p>/i)
          .map(p => stripHTML(p).trim())
          .filter(p => p.length > 20)
          .join('\n\n')
          .slice(0, 3000)
      : summary;

    let original_source = null;
    if (trustTier === 'aggregator') {
      const srcMatch = rawContent.match(/(?:Haber kaynağı|Kaynak)\s*[:\-]\s*([^\n<]{2,60})/i);
      if (srcMatch) original_source = srcMatch[1].trim();
    }

    let sport = feedSport;
    if (feedSport === 'football') {
      if (/basketbol|basket\b/i.test(haystack)) sport = 'basketball';
      else if (/voleybol/i.test(haystack))       sport = 'volleyball';
    }

    articles.push({
      title,
      summary,
      full_text,
      source:          sourceName,
      original_source,
      url:             url_,
      image_url,
      category:        'Club',
      time_ago:        pubMs ? relativeTime(pubMs) : 'Güncel',
      published_at,
      is_fresh:        true,
      trust_tier:      trustTier,
      sport,
    });
  }

  console.log(`RSS [${sourceName}]: ${recentCount} within 48h, ${articles.length} passed keyword filter`);
  return articles;
}

async function fetchNTVSporFromHTML(fallbackUrl, sourceName) {
  try {
    const res = await fetch(fallbackUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PitchOS/1.0)' },
      cf: { cacheTtl: 300 },
    });
    if (!res.ok) return [];
    const html = await res.text();
    const articles = [];
    const seen = new Set();
    const re = /href="(https?:\/\/www\.ntvspor\.net\/[^"]{10,120})"[^>]*>([^<]{20,150})/gi;
    let m;
    while ((m = re.exec(html)) !== null && articles.length < 8) {
      const url = m[1];
      const title = stripHTML(m[2]).trim();
      if (title.length < 20 || seen.has(url)) continue;
      seen.add(url);
      if (!BJK_REGEX.test(title)) continue;
      articles.push({ title, summary: title, url, source: sourceName, trust_tier: 'broadcast', sport: 'football', is_fresh: true, time_ago: 'Güncel', published_at: null });
    }
    console.log(`RSS [${sourceName}] HTML fallback: ${articles.length} articles`);
    return articles;
  } catch (e) {
    console.error(`NTV Spor HTML fallback failed: ${e.message}`);
    return [];
  }
}

// ─── WEB SEARCH (Claude) — disabled ──────────────────────────
export async function fetchArticles(site, env) {
  return { articles: [], usage: { input_tokens: 0, output_tokens: 0 } };
}

/* original fetchArticles (disabled):
export async function _fetchArticles(site, env) {
  const searchPrompt = `Search the web for the latest ${site.team_name} football news from the last 24 hours. Find transfers, match results, injuries, squad updates, press conferences.`;
  const searchResponse = await callClaude(env, MODEL_FETCH, searchPrompt, true);

  const allText = searchResponse.content
    .map(b => {
      if (b.type === 'text') return b.text;
      if (b.type === 'tool_result') return JSON.stringify(b.content);
      return '';
    })
    .join('\n');

  const formatPrompt = `Based on this football news content, return ONLY a valid JSON array. No markdown, just raw JSON starting with [ and ending with ].

RULES:
- Only include news where something specific happened recently (match result, goal, injury, signing, statement, press conference)
- Do NOT include general stats, old fixture lists, or league tables unless a result changed today
- If you find fewer than 3 good articles, return only those - never invent or pad
- Every field must be filled

Each object must have:
- title (string, specific headline)
- summary (string, 2-3 sentences describing what specifically happened)
- source (string, publication name, use "Spor Haberleri" if unknown)
- url (string, use "#" if unknown)
- category (one of: Transfer|Match|Injury|Squad|Club|European)
- time_ago (string, e.g. "1 saat once", "Bugun", "Dun")
- is_fresh (boolean, true if event happened in last 48 hours)

News content to analyze:
${allText.slice(0, 1500)}`;

  let formatResponse;
  try {
    formatResponse = await callClaude(env, MODEL_FETCH, formatPrompt, false, 600);
  } catch (e) {
    console.error('Format call failed:', e.message);
    return { articles: [], usage: searchResponse.usage };
  }

  let articles = [];
  try {
    const text = extractText(formatResponse.content);
    const match = text.match(/\[[\s\S]*\]/);
    if (match) articles = JSON.parse(match[0]);
    if (!Array.isArray(articles)) articles = [];
    articles = articles.filter(a => a.is_fresh !== false);
  } catch (e) {
    console.error('Parse error:', e.message);
  }

  const usage = {
    input_tokens:  (searchResponse.usage?.input_tokens  || 0) + (formatResponse.usage?.input_tokens  || 0),
    output_tokens: (searchResponse.usage?.output_tokens || 0) + (formatResponse.usage?.output_tokens || 0),
  };
  return { articles, usage };
}
*/

// ─── beIN SPORTS (Claude web search) ─────────────────────────
export async function fetchBeIN(site, env) {
  // Only run between 8am and 11pm Istanbul time (UTC+3)
  const hour = new Date().getUTCHours() + 3;
  if (hour < 8 || hour > 23) return { articles: [], usage: { input_tokens: 0, output_tokens: 0 } };
  const prompt = `Search "site:beinsports.com.tr beşiktaş" for the latest Beşiktaş news from beIN Sports Turkey. Return ONLY a JSON array (no other text):
[{"title":"...","url":"...","summary":"...","published_at":"ISO date or null"}]
Maximum 5 results. Only include items directly about Beşiktaş.`;

  let searchResponse;
  try {
    searchResponse = await callClaude(env, MODEL_FETCH, prompt, true, 600);
  } catch (e) {
    console.error('fetchBeIN search failed:', e.message);
    return { articles: [], usage: null };
  }

  const allText = searchResponse.content.map(b => b.type === 'text' ? b.text : '').join(' ');
  const match = allText.match(/\[[\s\S]*?\]/);
  if (!match) return { articles: [], usage: searchResponse.usage };

  try {
    const raw = JSON.parse(match[0]);
    const articles = (Array.isArray(raw) ? raw : []).filter(a => a.title).map(a => ({
      title:        a.title,
      summary:      a.summary || a.title,
      url:          a.url || '',
      source:       'beIN Sports',
      trust_tier:   'broadcast',
      sport:        'football',
      published_at: a.published_at || null,
      time_ago:     a.published_at ? relativeTime(new Date(a.published_at).getTime()) : 'Güncel',
      is_fresh:     true,
    }));
    console.log(`beIN Sports: ${articles.length} articles`);
    return { articles, usage: searchResponse.usage };
  } catch (e) {
    console.error('fetchBeIN parse failed:', e.message);
    return { articles: [], usage: searchResponse.usage };
  }
}

// ─── TWITTER SOURCES (Claude web search) ─────────────────────
export async function fetchTwitterSources(site, env) {
  const prompt = `Search Twitter/X for recent posts: "from:Besiktas OR from:firatgunayer besiktas"
Find the latest tweets about Beşiktaş from these accounts. Return ONLY a JSON array (no other text):
[{"title":"tweet text","url":"tweet url","summary":"tweet text","published_at":"ISO date or null","account":"Besiktas or firatgunayer"}]
Maximum 5 results. Only include posts directly about Beşiktaş.`;

  let response;
  try {
    response = await callClaude(env, MODEL_FETCH, prompt, true, 600);
  } catch (e) {
    console.error('fetchTwitterSources failed:', e.message);
    return { articles: [], usage: null };
  }

  const allText = response.content.map(b => b.type === 'text' ? b.text : '').join(' ');
  const match = allText.match(/\[[\s\S]*?\]/);
  if (!match) return { articles: [], usage: response.usage };

  try {
    const raw = JSON.parse(match[0]);
    const articles = (Array.isArray(raw) ? raw : []).filter(a => a.title).map(a => ({
      title:        a.title,
      summary:      a.summary || a.title,
      url:          a.url || '',
      source:       a.account === 'Besiktas' ? 'Beşiktaş JK Resmi' : 'Fırat Günayer',
      trust_tier:   a.account === 'Besiktas' ? 'official' : 'journalist',
      sport:        'football',
      published_at: a.published_at || null,
      time_ago:     a.published_at ? relativeTime(new Date(a.published_at).getTime()) : 'Güncel',
      is_fresh:     true,
    }));
    console.log(`Twitter sources: ${articles.length} tweets`);
    return { articles, usage: response.usage };
  } catch (e) {
    console.error('fetchTwitterSources parse failed:', e.message);
    return { articles: [], usage: response.usage };
  }
}

// ─── FETCH FULL ARTICLE TEXT ──────────────────────────────────
export async function fetchFullArticle(url) {
  if (!url || url === '#' || url === '') return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PitchOS/1.0)' },
      cf: { cacheTtl: 3600 },
    });
    if (!res.ok) return null;
    const html = await res.text();
    const articleBlock = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
    const source = articleBlock ? articleBlock[1] : html;
    const paragraphs = [...source.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)]
      .map(m => stripHTML(m[1]).trim())
      .filter(p => p.length > 40);
    return paragraphs.join('\n\n').slice(0, 3000) || null;
  } catch (e) {
    console.error(`fetchFullArticle failed for ${url}:`, e.message);
    return null;
  }
}

// ─── RELATIVE TIME ────────────────────────────────────────────
export function relativeTime(ms) {
  const diff = Date.now() - ms;
  const h = Math.floor(diff / 3600000);
  if (h < 1) return `${Math.floor(diff / 60000)} dakika önce`;
  if (h < 24) return `${h} saat önce`;
  return 'Dün';
}

// ─── RSS PARSE HELPERS (private) ─────────────────────────────
function getTag(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return m ? m[1].trim() : '';
}

function getTagNS(xml, tag) {
  const escaped = tag.replace(':', '\\:');
  const m = xml.match(new RegExp(`<${escaped}[^>]*>([\\s\\S]*?)<\\/${escaped}>`, 'i'));
  return m ? m[1].trim() : '';
}

function getEnclosureUrl(item) {
  const m = item.match(/<enclosure[^>]+url="([^"]+)"/i);
  return m ? m[1].trim() : null;
}

function getRSSLink(item) {
  const standard = item.match(/<link[^>]*>([^<]+)<\/link>/i);
  if (standard) return standard[1].trim();
  const atom = item.match(/<link[^>]+href="([^"]+)"/i);
  if (atom) return atom[1].trim();
  const naked = item.match(/<link\s*\/?>[\s\r\n]*(https?:\/\/[^\s<]+)/i);
  if (naked) return naked[1].trim();
  return '';
}

function stripCDATA(str) {
  return (str || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
}

function stripHTML(str) {
  return (str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}
