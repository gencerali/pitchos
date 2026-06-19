import { callClaude, MODEL_FETCH, extractText, sleep, BJK_KEYWORDS, bjkMatch, supabase } from './utils.js';
const DEFAULT_LOOKBACK_MS = 3 * 60 * 60 * 1000; // 3h fallback when no cron context

// Strip common source domain suffixes appended by aggregator RSS feeds (Google News, etc.)
// e.g. "Recep Uçar: Maç Çok Önemli - BJK.com.tr" → "Recep Uçar: Maç Çok Önemli"
function decodeEntities(str) {
  return (str || '')
    .replace(/&apos;/g, "'").replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function cleanTitle(title) {
  return decodeEntities(title)
    .replace(/\s*[\|\-–—]\s*(bjk\.com\.tr|bjkspor\.net|bjk\.com|besiktas\.com\.tr)[\s.]*$/i, '')
    .replace(/\s*[\|\-–—]\s*[a-z0-9\-]+\.(com\.tr|net\.tr|org\.tr|com|net|org)\s*$/i, '')
    .trim();
}

function stripHTML(str) {
  return decodeEntities((str || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

// Reads an RSS/XML response body respecting the encoding declared in the XML prolog.
// res.text() defaults to UTF-8 (or Content-Type charset), ignoring the XML encoding
// declaration — which breaks Turkish sources that serve windows-1254 content.
async function decodeRSSBody(res) {
  const buf = await res.arrayBuffer();
  // Probe the prolog as Latin-1 — all XML declaration bytes are ASCII-safe.
  const probe = new TextDecoder('latin1').decode(new Uint8Array(buf, 0, Math.min(512, buf.byteLength)));
  const declared = probe.match(/<\?xml[^?]*encoding=["']([^"']+)["']/i)?.[1]
                     ?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (declared && declared !== 'utf8') {
    try { return new TextDecoder(declared).decode(buf); } catch {}
  }
  // Fall back to Content-Type charset if present and non-UTF-8.
  const ct = res.headers.get('content-type') || '';
  const ctCharset = ct.match(/charset=([^\s;]+)/i)?.[1]?.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (ctCharset && ctCharset !== 'utf8') {
    try { return new TextDecoder(ctCharset).decode(buf); } catch {}
  }
  return new TextDecoder('utf-8').decode(buf);
}

// ─── RSS FEEDS ────────────────────────────────────────────────
// trust values: official, broadcast, press, journalist, international, aggregator
// journalist/international: filtered by BJK_KEYWORDS (title + description)
// press/broadcast/official: team-specific feeds, no feed-level keyword filter
// ntvFallback: HTML fallback URL if RSS returns 0 items
export const RSS_FEEDS = [
  // Team-specific feeds — no keyword filter needed
  { url: 'https://www.ntvspor.net/rss/kategori/futbol',    name: 'NTV Spor',     trust: 'broadcast', sport: 'football', is_p4: true,  keywordFilter: true, ntvFallback: 'https://www.ntvspor.net/futbol/takim/besiktas' },
  { url: 'https://www.ahaber.com.tr/rss/besiktas.xml',     name: 'A Haber',      trust: 'press',     sport: 'football', is_p4: true  },
  { url: 'https://www.trthaber.com/spor_articles.rss',     name: 'TRT Haber',    trust: 'broadcast', sport: 'football', is_p4: false, keywordFilter: true },

  // General sports feeds — BJK_KEYWORDS filter applied, all commercial press = P4
  { url: 'https://www.hurriyet.com.tr/rss/spor',           name: 'Hürriyet',     trust: 'press',     sport: 'football', is_p4: true,  keywordFilter: true },
  { url: 'https://www.sabah.com.tr/rss/spor.xml',          name: 'Sabah Spor',   trust: 'press',     sport: 'football', is_p4: true,  keywordFilter: true },
  { url: 'https://www.haberturk.com/rss/spor.xml',         name: 'Habertürk Spor', trust: 'press',   sport: 'football', is_p4: true,  keywordFilter: true },
  // Fanatik — RSS URL 404, correct URL unknown. Re-add when confirmed.
  // { url: 'https://www.fanatik.com.tr/rss/besiktas', name: 'Fanatik', ... }
  // Milliyet, Sporx, Ajansspor — no working direct RSS found. Covered by Google News below.
  { url: 'https://www.duhuliye.com/rss',                   name: 'Duhuliye',     trust: 'aggregator', sport: 'football', is_p4: true,  keywordFilter: true },
  { url: 'https://www.fotospor.com/feed/rss_sondakika.xml', name: 'Fotospor',    trust: 'press',      sport: 'football', is_p4: true,  keywordFilter: true },

  // Google News — aggregates Turkish press (Fanatik, Milliyet, Sporx, Ajansspor etc.)
  // Free, no auth. keywordFilter not needed — query is already BJK-specific.
  { url: 'https://news.google.com/rss/search?q=Besiktas+BJK&hl=tr&gl=TR&ceid=TR:tr', name: 'Google News', trust: 'press', sport: 'football', is_p4: true, proxy: true },
  { url: 'https://news.google.com/rss/search?q=Besiktas+transfer&hl=tr&gl=TR&ceid=TR:tr', name: 'Google News Transfer', trust: 'press', sport: 'football', is_p4: true, proxy: true, keywordFilter: true },

  // Proxy feeds (403-blocked direct, routed via pitchos-proxy) — all P4
  { url: 'https://www.fotomac.com.tr/rss/Besiktas.xml',    name: 'Fotomaç',      trust: 'press',     sport: 'football', is_p4: true,  proxy: true },
  { url: 'https://www.aspor.com.tr/rss/besiktas.xml',      name: 'A Spor',       trust: 'broadcast', sport: 'football', is_p4: true,  proxy: true },

  // Transfermarkt TR — transfer rumours and confirmed moves, general Turkish football feed
  // 403 direct, routed via proxy. keywordFilter required (covers all Turkish clubs).
  { url: 'https://www.transfermarkt.com.tr/rss/news', name: 'Transfermarkt', trust: 'journalist', sport: 'football', is_p4: false, proxy: true, keywordFilter: true },

  // Reddit r/besiktas — English-language fan community, international transfer news + sentiment
  { url: 'https://www.reddit.com/r/besiktas/.rss', name: 'Reddit BJK', trust: 'journalist', sport: 'football', is_p4: false, proxy: true, keywordFilter: true },
];

// ─── DYNAMIC SOURCE CONFIG ────────────────────────────────────
// Reads source_configs from Supabase. Returns [] on failure so callers
// fall back to hardcoded RSS_FEEDS / YOUTUBE_CHANNELS arrays.
export async function fetchSourceConfigs(siteId, env) {
  try {
    const rows = await supabase(env, 'GET',
      `/rest/v1/source_configs?site_id=eq.${siteId}&is_active=eq.true&order=name`
    );
    return rows || [];
  } catch(e) {
    console.error('fetchSourceConfigs failed:', e.message);
    return [];
  }
}

// Convert source_configs rows → RSS_FEEDS shape
export function configsToRSSFeeds(configs) {
  return configs
    .filter(c => c.source_type === 'rss' && c.url)
    .map(c => ({
      url:           c.url,
      name:          c.name,
      trust:         c.trust_tier,
      sport:         c.sport || 'football',
      is_p4:         c.is_p4 ?? true,
      keywordFilter: c.bjk_filter ?? false,
      proxy:         c.proxy ?? false,
    }));
}

// Convert source_configs rows → YOUTUBE_CHANNELS shape
export function configsToYTChannels(configs) {
  return configs
    .filter(c => c.source_type === 'youtube' && c.channel_id)
    .map(c => ({
      id:                 c.channel_id,
      name:               c.name,
      tier:               c.trust_tier,
      all_qualify:        c.all_qualify ?? false,
      embed_qualify:      c.treatment === 'embed' || c.treatment === 'embed_and_synthesize',
      transcript_qualify: c.treatment === 'synthesize' || c.treatment === 'embed_and_synthesize',
    }));
}

// ─── RENDER PROXY ─────────────────────────────────────────────
export async function fetchViaRss2Json(feed) {
  const proxyUrl = `https://pitchos-proxy.onrender.com/rss?url=${encodeURIComponent(feed.url)}`;
  try {
    const res = await fetch(proxyUrl, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`Proxy HTTP ${res.status}`);
    const text = await decodeRSSBody(res);
    console.log(`PROXY [${feed.name}]: ${text.length} chars`);

    // Support both RSS <item> and Atom <entry> (Reddit uses Atom)
    const items = text.match(/<item[\s\S]*?<\/item>/g)
               || text.match(/<entry[\s\S]*?<\/entry>/g)
               || [];
    console.log(`PROXY [${feed.name}]: ${items.length} items parsed`);

    return items.slice(0, 30).map(item => {
      const title = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1]
                 || item.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1] || '';
      const url = item.match(/<link[^>]+href="([^"]+)"/i)?.[1]
               || item.match(/<link>([^<]+)<\/link>/i)?.[1]
               || item.match(/<guid>([^<]+)<\/guid>/i)?.[1] || '';
      const desc = item.match(/<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>/i)?.[1]
                || item.match(/<description[^>]*>([^<]+)<\/description>/i)?.[1]
                || item.match(/<content[^>]*>([\s\S]*?)<\/content>/i)?.[1] || '';
      const pubRaw = item.match(/<pubDate>([^<]+)<\/pubDate>/i)?.[1]
                  || item.match(/<published>([^<]+)<\/published>/i)?.[1]
                  || item.match(/<updated>([^<]+)<\/updated>/i)?.[1] || '';
      const pubDate = pubRaw ? new Date(pubRaw) : null;
      const published_at = pubDate && !isNaN(pubDate.getTime()) ? pubDate.toISOString() : null;

      // Sport detection — filter basketball/volleyball leaking through football feeds.
      // Also check URL path (e.g. duhuliye.com/basketbol/...) for feeds that don't
      // mention sport in title/description.
      const haystack = (title + ' ' + desc + ' ' + url).toLowerCase();
      const sport = /basketbol|basket\b|\/basketbol\//i.test(haystack) ? 'basketball'
                  : /voleybol|\/voleybol\//i.test(haystack)            ? 'volleyball'
                  : feed.sport;
      if (sport !== 'football') return null;

      // For tweet feeds: extract embedded bjk.com.tr (or other official site) links
      // from description HTML — tweets with 🔗 embed the actual article URL
      const embeddedOfficialUrl = desc.match(/href="(https:\/\/(?:www\.)?bjk\.com\.tr\/[^"]+)"/i)?.[1] || null;

      return {
        title:        title.trim(),
        url:          url.trim(),
        original_url: embeddedOfficialUrl || url.trim(),
        summary:      desc.replace(/<[^>]+>/g, '').slice(0, 300),
        image_url:    null,
        published_at,
        source_name:  feed.name,
        source:       feed.name,
        trust_tier:   feed.trust,
        sport:        'football',
        is_fresh:     true,
        time_ago:     'Güncel',
        is_p4:        feed.is_p4 ?? true,
      };
    }).filter(a => a !== null && a.title.length > 5);
  } catch(e) {
    console.error(`PROXY FAILED [${feed.name}]:`, e.message);
    return [];
  }
}

// ─── RSS FETCH ────────────────────────────────────────────────
// Returns { articles, bySource: { feedName: { raw, after_date, after_keyword } } }
// lookbackMs: derived from 3× cron interval by the caller
export async function fetchRSSArticles(site, overrideFeeds = null, lookbackMs = DEFAULT_LOOKBACK_MS) {
  const allArticles = [];
  const bySource = {};

  const feeds    = overrideFeeds || site.feed_config?.feeds || RSS_FEEDS;
  const keywords = site.keyword_config?.keywords || BJK_KEYWORDS;

  for (const feed of feeds) {
    if (feed.proxy) {
      const proxyItems = await fetchViaRss2Json(feed);
      const raw = proxyItems.length;
      const cutoff = Date.now() - lookbackMs;
      // Apply same date cutoff as fetchOneFeed: articles with no parseable date = treat as now
      const afterDate = proxyItems.filter(a => {
        const pubMs = a.published_at ? new Date(a.published_at).getTime() : Date.now();
        return pubMs >= cutoff;
      });
      const filtered = feed.keywordFilter
        ? afterDate.filter(a => keywords.some(k => (a.title + ' ' + (a.summary || '')).toLowerCase().includes(k.toLowerCase())))
        : afterDate;
      allArticles.push(...filtered);
      bySource[feed.name] = { raw, after_date: afterDate.length, after_keyword: filtered.length };
      continue;
    }

    try {
      const result = await fetchOneFeed(feed, site, keywords, lookbackMs);
      allArticles.push(...result.articles);
      const fs = result.feedStats;
      bySource[fs.name] = { raw: fs.raw, after_date: fs.after_date, after_keyword: fs.after_keyword };
    } catch (e) {
      console.error(`RSS feed failed [${feed.name}]:`, e.message);
    }
  }

  return { articles: allArticles, bySource };
}

async function fetchOneFeed(feed, site, keywords = BJK_KEYWORDS, lookbackMs = DEFAULT_LOOKBACK_MS) {
  const sourceName = feed.name || feed.source;
  const trustTier  = feed.trust || feed.trust_tier || 'unknown';
  const feedSport  = feed.sport || 'football';

  const emptyResult = (raw = 0) => ({ articles: [], feedStats: { name: sourceName, raw, after_date: 0, after_keyword: 0 } });

  let res;
  try {
    res = await fetch(feed.url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; PitchOS/1.0)' }, cf: { cacheTtl: 300 } });
  } catch (e) {
    console.error(`RSS [${sourceName}]: fetch error ${e.message}`);
    if (feed.ntvFallback) {
      const fallback = await fetchNTVSporFromHTML(feed.ntvFallback, sourceName);
      return { articles: fallback, feedStats: { name: sourceName, raw: 0, after_date: 0, after_keyword: fallback.length } };
    }
    return emptyResult();
  }
  if (!res.ok) {
    console.error(`RSS [${sourceName}]: HTTP ${res.status}`);
    if (feed.ntvFallback) {
      const fallback = await fetchNTVSporFromHTML(feed.ntvFallback, sourceName);
      return { articles: fallback, feedStats: { name: sourceName, raw: 0, after_date: 0, after_keyword: fallback.length } };
    }
    return emptyResult();
  }

  const xml = await decodeRSSBody(res);
  const cutoff = Date.now() - lookbackMs;
  // Support both RSS (<item>) and Atom (<entry>) formats
  const items = xml.match(/<item[\s\S]*?<\/item>/g)
             || xml.match(/<entry[\s\S]*?<\/entry>/g)
             || [];
  console.log(`RSS [${sourceName}]: ${items.length} total items in feed`);

  if (items.length === 0 && feed.ntvFallback) {
    const fallback = await fetchNTVSporFromHTML(feed.ntvFallback, sourceName);
    return { articles: fallback, feedStats: { name: sourceName, raw: 0, after_date: 0, after_keyword: fallback.length } };
  }

  let recentCount = 0;
  const articles = [];

  for (const item of items) {
    // Robust title extraction: 4-pattern approach (CDATA first, then plain text variants)
    const rawTitle   = item.match(/<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>/i)?.[1]
                    || item.match(/<title[^>]*><!\[CDATA\[([\s\S]*?)\]\]>/i)?.[1]
                    || item.match(/<title[^>]*>([^<]{3,})<\/title>/i)?.[1]
                    || item.match(/<title[^>]*>\s*([^\s<][^<]*)<\/title>/i)?.[1]
                    || '';
    if (!rawTitle) console.log(`EMPTY TITLE in ${sourceName}: ${item.slice(0, 200)}`);
    const title      = cleanTitle(stripCDATA(rawTitle).trim() || stripCDATA(getTag(item, 'title')));
    const rawDesc    = stripCDATA(getTag(item, 'description') || getTag(item, 'summary'));
    const rawContent = stripCDATA(getTagNS(item, 'content:encoded') || getTagNS(item, 'content'));
    const url_       = getRSSLink(item) || getTag(item, 'guid') || getTag(item, 'id') || '';
    const pubDate    = getTag(item, 'pubDate') || getTag(item, 'published') || getTag(item, 'dc:date') || getTag(item, 'updated');
    let published_at = null, pubMs = 0;
    if (pubDate) {
      const d = new Date(pubDate);
      if (!isNaN(d.getTime())) { published_at = d.toISOString(); pubMs = d.getTime(); }
    }
    // Fallback: extract date from URL path (e.g. /2026/04/15/ or /20260415)
    if (!pubMs && url_) {
      const m = url_.match(/\/(20\d{2})[\/\-](0[1-9]|1[0-2])[\/\-](0[1-9]|[12]\d|3[01])/);
      if (m) {
        const d = new Date(`${m[1]}-${m[2]}-${m[3]}T12:00:00Z`);
        if (!isNaN(d.getTime())) { published_at = d.toISOString(); pubMs = d.getTime(); }
      }
    }
    // Articles with no parseable date at all: treat as now (fresh) but cap per-source to avoid floods
    const pubMsForCutoff = pubMs || Date.now();
    const image_url = getImageUrl(item, rawDesc);

    if (pubMsForCutoff < cutoff) continue;
    recentCount++;

    const haystack = title + ' ' + (rawDesc || '');

    // journalist/international feeds: BJK_KEYWORDS filter
    // general press feeds with keywordFilter flag: same filter
    if (trustTier === 'journalist' || trustTier === 'international' || feed.keywordFilter) {
      if (!bjkMatch(haystack, keywords)) continue;
    }

    // Sky Sports and other mixed-sport international feeds: must mention football or BJK
    if (feed.footballOnly) {
      if (!haystack.toLowerCase().includes('football') && !bjkMatch(haystack, keywords)) continue;
    }

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
      const sportHaystack = (title + ' ' + (rawDesc || '') + ' ' + url_).toLowerCase();
      if (/basketbol|basket\b|\/basketbol\//i.test(sportHaystack)) sport = 'basketball';
      else if (/voleybol|\/voleybol\//i.test(sportHaystack))       sport = 'volleyball';
    }

    // IT3 block: images from P4 sources (commercial Turkish media) never reach the pipeline.
    // is_p4 flag is set per-feed in RSS_FEEDS — covers both proxy and directly-fetched P4 sources.
    const safeImageUrl = feed.is_p4 ? null : image_url;

    // Football-only filter: drop articles about basketball/volleyball that slipped through keyword match
    if (sport !== 'football') continue;

    articles.push({
      title,
      summary,
      full_text:       feed.is_p4 ? null : full_text,  // P4 source text not passed downstream
      source:          sourceName,
      original_source,
      url:             url_,
      image_url:       safeImageUrl,
      category:        'Club',
      time_ago:        pubMs ? relativeTime(pubMs) : 'Güncel',
      published_at,
      is_fresh:        true,
      trust_tier:      trustTier,
      is_p4:           !!feed.is_p4,
      sport,
    });
  }

  console.log(`FEED [${sourceName}]: ${items.length} raw → ${recentCount} after date → ${articles.length} after BJK filter`);
  return { articles, feedStats: { name: sourceName, raw: items.length, after_date: recentCount, after_keyword: articles.length } };
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
      if (!bjkMatch(title)) continue;
      articles.push({ title, summary: title, url, source: sourceName, trust_tier: 'broadcast', sport: 'football', is_fresh: true, time_ago: 'Güncel', published_at: null });
    }
    console.log(`RSS [${sourceName}] HTML fallback: ${articles.length} articles`);
    return articles;
  } catch (e) {
    console.error(`NTV Spor HTML fallback failed: ${e.message}`);
    return [];
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

function getImageUrl(item, rawDesc) {
  // 1. <enclosure url="...">
  const enc = item.match(/<enclosure[^>]+url="([^"]+)"/i);
  if (enc) return enc[1].trim();
  // 2. <media:content url="...">
  const media = item.match(/<media:content[^>]+url="([^"]+)"/i);
  if (media) return media[1].trim();
  // 3. First <img src="..."> in description HTML
  const img = (rawDesc || '').match(/<img[^>]+src="([^"]+)"/i);
  if (img) return img[1].trim();
  return null;
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

