// ─── YOUTUBE ATOM FEED FETCHER ────────────────────────────────
// Public Atom feeds, no auth, no quota.
// Feed URL: https://www.youtube.com/feeds/videos.xml?channel_id={id}
// Returns last ~15 videos per channel.
//
// Channel flags:
//   embed_qualify    — generate iframe embed article (T-VID-*)
//   transcript_qualify — fetch caption text → feed into generateOriginalNews as source

export const YOUTUBE_CHANNELS = [
  // Official Beşiktaş — all videos qualify; embed + transcript both enabled
  { id: 'UCLJVUlpsxZcIMECVDcZaM2g', name: 'Beşiktaş JK',       tier: 'official',   all_qualify: true,  embed_qualify: true,  transcript_qualify: false },

  // Broadcast — match highlights and press conf embeds; no transcript synthesis
  { id: 'UCNopxUNUMinlK3ybMGlpbGQ', name: 'beIN SPORTS TR',     tier: 'broadcast',  all_qualify: false, embed_qualify: true,  transcript_qualify: false },
  { id: 'UCJElRTCNEmLemgirqvsW63Q', name: 'A Spor',             tier: 'broadcast',  all_qualify: false, embed_qualify: true,  transcript_qualify: false },
  { id: 'UCebdo7-2NdjcktKzco64iNw', name: 'TRT Spor',           tier: 'broadcast',  all_qualify: false, embed_qualify: true,  transcript_qualify: false },

  // Digital / analysis — Fırat Günayer videos on Rabona; transcript synthesis only, no embed
  { id: 'UCpj3LeIWetKktdIJQcBx-uw', name: 'Rabona Digital',     tier: 'digital',    all_qualify: false, embed_qualify: false, transcript_qualify: true  },

  // Additional channels — add channel IDs below (find via youtube.com/@handle → About → Share → Copy channel ID)
  // { id: 'UC___NTVSpor___',    name: 'NTV Spor',           tier: 'broadcast',  all_qualify: false, embed_qualify: true,  transcript_qualify: true  },
  // { id: 'UC___Fanatik___',    name: 'Fanatik',            tier: 'press',      all_qualify: false, embed_qualify: false, transcript_qualify: true  },
  // { id: 'UC___Haberturk___',  name: 'Habertürk Spor',     tier: 'broadcast',  all_qualify: false, embed_qualify: false, transcript_qualify: true  },
  // { id: 'UC___TurkiyeMilli___', name: 'Türkiye Millî',    tier: 'official',   all_qualify: false, embed_qualify: true,  transcript_qualify: true  },
];

const EXCLUDE_TERMS = ['#shorts', ' shorts '];
// Matches "YYYY/YYYY" season notation for pre-2024 seasons (e.g. "2016/2017", "2022/2023")
const ARCHIVE_SEASON_RE = /\b20(0[0-9]|1[0-9]|2[0-3])\/20\d{2}\b/;
const BJK_TITLE_RE = /beşiktaş|besiktas|bjk|kartal|siyah.beyaz/i;

// ─── MATCH VIDEO CLASSIFICATION ───────────────────────────────
// Returns a match video type when the video is clearly linked to a Süper Lig
// BJK match, or null to fall back to generic T-VID.
export function classifyMatchVideo(video, nextMatch, recentMatch = null) {
  let match = null;
  if (nextMatch?.league?.includes('Süper Lig')) {
    match = nextMatch;
  } else if (recentMatch?.league?.includes('Süper Lig')) {
    const kickoff   = new Date(recentMatch.kickoff_iso || `${recentMatch.date}T${recentMatch.time}:00+03:00`);
    const hoursAfter = (new Date(video.published_at) - kickoff) / (1000 * 60 * 60);
    if (hoursAfter >= 0 && hoursAfter < 24) match = recentMatch;
  }
  if (!match) return null;

  const t   = video.title.toLowerCase();
  const opp = (match.opponent || '').toLowerCase().replace(/\s+fk$/i, '').trim();

  const isMatchLinked = (opp && t.includes(opp))
    || video.channel_tier === 'official'
    || t.includes('süper lig')
    || t.includes('trendyol');

  if (!isMatchLinked) return null;

  if (/özet|highlights/.test(t)) return 'highlights';
  if (/basın toplantısı|press conference/.test(t)) return 'press_conf';
  if (/röportaj|flash interview|maç sonu röportaj|maç öncesi röportaj|sözleri|konuştu|açıkladı/.test(t)) return 'interview';
  if (/\bhakem\b|mhk|var karar/.test(t)) return 'referee';
  if (/\bgol\b/.test(t) && !/özet/.test(t)) {
    if (video.channel_tier === 'official') return 'goal_bjk';
    if (isBjkScoringGoal(video.title)) return 'goal_bjk';
    return null;
  }

  return null;
}

function isBjkScoringGoal(title) {
  const home = /beşiktaş\s+(\d+)-\d+/i.exec(title);
  if (home && parseInt(home[1]) > 0) return true;
  const away = /-(\d+)\s+beşiktaş/i.exec(title);
  if (away && parseInt(away[1]) > 0) return true;
  return false;
}

export async function fetchYouTubeChannel(channel, since) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channel.id}`;
  try {
    const res = await fetch(feedUrl, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      console.error(`YouTube feed HTTP ${res.status} [${channel.name}]`);
      return [];
    }
    return parseAtomFeed(await res.text(), channel, since);
  } catch (e) {
    console.error(`YouTube feed failed [${channel.name}]:`, e.message);
    return [];
  }
}

function parseAtomFeed(xml, channel, since) {
  const videos = [];
  const entryRe = /<entry>([\s\S]*?)<\/entry>/g;
  let m;
  while ((m = entryRe.exec(xml)) !== null) {
    const b        = m[1];
    const videoId  = (b.match(/<yt:videoId>(.*?)<\/yt:videoId>/) || [])[1];
    const title    = (b.match(/<title>(.*?)<\/title>/) || [])[1];
    const pubStr   = (b.match(/<published>(.*?)<\/published>/) || [])[1];
    const desc     = (b.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1] || '';
    const thumb    = (b.match(/url="(https:\/\/i[0-9]\.ytimg\.com[^"]+)"/) || [])[1] || '';

    if (!videoId || !title || !pubStr) continue;
    const pubDate = new Date(pubStr);
    if (since && pubDate <= since) continue;

    videos.push({
      video_id:           videoId,
      title:              decode(title),
      published_at:       pubDate.toISOString(),
      description:        decode(desc).slice(0, 400),
      thumbnail_url:      thumb,
      channel_id:         channel.id,
      channel_name:       channel.name,
      channel_tier:       channel.tier,
      all_qualify:        channel.all_qualify ?? false,
      embed_qualify:      channel.embed_qualify ?? true,
      transcript_qualify: channel.transcript_qualify ?? false,
    });
  }
  return videos;
}

const PROXY_BASE = 'https://pitchos-proxy.onrender.com';

// ─── TRANSCRIPT FETCHER ───────────────────────────────────────
// Routes through pitchos-proxy to avoid Cloudflare datacenter IP bot-detection.
// Returns plain text capped at 3000 chars, or null if captions unavailable.
export async function fetchYouTubeTranscript(videoId) {
  try {
    const res = await fetch(`${PROXY_BASE}/transcript?video_id=${encodeURIComponent(videoId)}`, {
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.text && data.text.length > 50 ? data.text : null;
  } catch (e) {
    console.error(`Transcript fetch failed [${videoId}]:`, e.message);
    return null;
  }
}

// Hard pre-filter — drops shorts, archive re-uploads, and off-topic content.
// For broadcast/digital channels (all_qualify=false), title must mention Beşiktaş.
export function qualifyYouTubeVideo(video) {
  const t = video.title.toLowerCase();
  if (EXCLUDE_TERMS.some(k => t.includes(k))) return false;
  if (ARCHIVE_SEASON_RE.test(video.title)) return false;
  if (!video.all_qualify && !BJK_TITLE_RE.test(video.title)) return false;
  return true;
}

function decode(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
