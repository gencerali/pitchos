import { bjkMatch } from './utils.js';
import { isRivalSubject } from './processor.js';

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

  // Broadcast — match highlights and press conf embeds; interview_qualify enables
  // multi-topic transcript synthesis when video title signals a notable-person interview
  { id: 'UCNopxUNUMinlK3ybMGlpbGQ', name: 'beIN SPORTS TR',     tier: 'broadcast',  all_qualify: false, embed_qualify: true,  transcript_qualify: false, interview_qualify: true },
  { id: 'UCJElRTCNEmLemgirqvsW63Q', name: 'A Spor',             tier: 'broadcast',  all_qualify: false, embed_qualify: true,  transcript_qualify: false, interview_qualify: true },
  { id: 'UCebdo7-2NdjcktKzco64iNw', name: 'TRT Spor',           tier: 'broadcast',  all_qualify: false, embed_qualify: true,  transcript_qualify: false, interview_qualify: true },
  { id: 'UCK3mI2lsk3LSo8PBUc8JTSw', name: 'HT Spor',           tier: 'broadcast',  all_qualify: false, embed_qualify: true,  transcript_qualify: false, interview_qualify: true },

  // Digital / analysis — Fırat Günayer videos on Rabona; transcript synthesis only, no embed
  { id: 'UCpj3LeIWetKktdIJQcBx-uw', name: 'Rabona Digital',     tier: 'digital',    all_qualify: true,  embed_qualify: false, transcript_qualify: true  },

  // Digital talk shows — multi-topic transcript synthesis; notable-person interviews generate
  // multiple focused articles. Channel IDs: youtube.com/@handle → About → Share → Copy channel ID
  //
  // Kafa Sports (@KafaTV) — Find ID: open any Kafa Sports video, View Page Source, search "channelId"
  // Confirmed ID from console.log output, or: youtube.com/@KafaTV → About → Share channel URL
  { id: 'UCuRJ7zpj8K51YTnUio20rTg', name: 'Kafa Sports',        tier: 'digital',    all_qualify: false, embed_qualify: true,  transcript_qualify: true  },

  // Additional channels — add channel IDs below
  // { id: 'UC___NTVSpor___',    name: 'NTV Spor',           tier: 'broadcast',  all_qualify: false, embed_qualify: true,  transcript_qualify: true  },
  // { id: 'UC___Fanatik___',    name: 'Fanatik',            tier: 'press',      all_qualify: false, embed_qualify: false, transcript_qualify: true  },
  // { id: 'UC___TurkiyeMilli___', name: 'Türkiye Millî',    tier: 'official',   all_qualify: false, embed_qualify: true,  transcript_qualify: true  },
];

const EXCLUDE_TERMS = ['#shorts', ' shorts '];
// Any "YYYY/YYYY" season tag. We drop tags OLDER than the current season — derived from the
// clock, so there is NO hardcoded year to maintain (see currentSeasonStartYear).
const SEASON_TAG_RE = /\b(20\d{2})\/20\d{2}\b/;
const HIGHLIGHT_RE  = /özet|highlights/i;
const HIGHLIGHT_MAX_AGE_DAYS = 14;            // a match highlight older than this is archive / re-surfaced
// Süper Lig (and most European) seasons start ~August; before July we are still in the prior season.
function currentSeasonStartYear(now = new Date()) {
  return now.getUTCMonth() >= 6 ? now.getUTCFullYear() : now.getUTCFullYear() - 1;
}
// Live streams (e.g. "… | Canlı Yayın") — embedding them produces a dead "live stream
// offline" player once the broadcast ends, so they must not become embed articles. (2026-06-06)
const LIVE_STREAM_RE = /canlı yayın|canli yayin|live\s?stream|livestream|🔴/i;

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

const SUPADATA_BASE = 'https://api.supadata.ai/v1/youtube';

// ─── TRANSCRIPT FETCHER ───────────────────────────────────────
// Calls Supadata API directly (free tier: 100 req/month, no cold-start).
// Returns plain text, or null if captions unavailable.
export async function fetchYouTubeTranscript(videoId, env) {
  const apiKey = env?.SUPADATA_API_KEY;
  try {
    const res = await fetch(
      `${SUPADATA_BASE}/transcript?videoId=${encodeURIComponent(videoId)}&text=true`,
      {
        headers: apiKey ? { 'x-api-key': apiKey } : {},
        signal: AbortSignal.timeout(20000),
      }
    );
    if (!res.ok) {
      console.error(`Supadata transcript HTTP ${res.status} [${videoId}]`);
      return null;
    }
    const data = await res.json();
    // text=true → { content: "plain text...", lang: "tr" }
    if (typeof data.content === 'string') {
      return data.content.length > 50 ? data.content : null;
    }
    // fallback: segments array → join
    if (Array.isArray(data.content)) {
      const text = data.content.map(c => c.text).join(' ').trim();
      return text.length > 50 ? text : null;
    }
    return null;
  } catch (e) {
    console.error(`Transcript fetch failed [${videoId}]:`, e.message);
    return null;
  }
}

// Title patterns that signal a notable-person interview / press conference / studio appearance.
// Used by shouldFetchTranscript() to enable transcript synthesis on interview_qualify channels
// (e.g. HT Spor, beIN SPORTS) even when full transcript_qualify is not set.
const INTERVIEW_VIDEO_RE = /röportaj|basın toplantısı|press\s?conf|açıkladı|konuştu|sözleri|özel görüşme|stüdyoda|canlı bağlantı|konuk|masada|gündemin|yorumladı|değerlendirdi|itiraf|bomba açıkl/i;

// True when a transcript should be fetched for this video.
// transcript_qualify: all videos on this channel get transcript synthesis.
// interview_qualify: only when the title matches an interview/press-conf pattern.
export function shouldFetchTranscript(video) {
  if (video.transcript_qualify) return true;
  if (video.interview_qualify && INTERVIEW_VIDEO_RE.test(video.title)) return true;
  return false;
}

// Hard pre-filter — drops shorts, archive re-uploads, and off-topic content.
// For broadcast/digital channels (all_qualify=false), title must mention Beşiktaş.
export function qualifyYouTubeVideo(video, now = new Date()) {
  const t = video.title.toLowerCase();
  if (EXCLUDE_TERMS.some(k => t.includes(k))) return false;
  // Older-season catalog upload (self-updating: title's season tag vs the current season).
  const seasonTag = video.title.match(SEASON_TAG_RE);
  if (seasonTag && Number(seasonTag[1]) < currentSeasonStartYear(now)) return false;
  // Stale match highlight: relevant ~2 weeks; an older upload is an archive / re-surfaced clip.
  if (HIGHLIGHT_RE.test(t) && video.published_at &&
      (now - new Date(video.published_at)) / 86400000 > HIGHLIGHT_MAX_AGE_DAYS) return false;
  if (LIVE_STREAM_RE.test(video.title)) return false; // live broadcasts → dead embed when they end
  if (video.url && /youtube\.com\/live\//i.test(video.url)) return false; // /live/ URL form
  // Rival guard — applies even to all_qualify channels (which skip the bjkMatch check below),
  // e.g. a digital analysis channel covering a rival. Parity with preFilter Stage 1.6. (2026-06-06)
  if (isRivalSubject(video.title)) return false;
  if (!video.all_qualify && !bjkMatch(video.title)) return false;
  return true;
}

function decode(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
