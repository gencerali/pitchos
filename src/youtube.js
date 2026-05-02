// ─── YOUTUBE ATOM FEED FETCHER ────────────────────────────────
// Public Atom feeds, no auth, no quota.
// Feed URL: https://www.youtube.com/feeds/videos.xml?channel_id={id}
// Returns last ~15 videos per channel.

export const YOUTUBE_CHANNELS = [
  { id: 'UCLJVUlpsxZcIMECVDcZaM2g', name: 'Beşiktaş JK',    tier: 'official',   all_qualify: true  },
  { id: 'UCNopxUNUMinlK3ybMGlpbGQ', name: 'beIN SPORTS TR',  tier: 'broadcast',  all_qualify: false },
  { id: 'UCJElRTCNEmLemgirqvsW63Q', name: 'A Spor',          tier: 'broadcast',  all_qualify: false },
  { id: 'UCpj3LeIWetKktdIJQcBx-uw', name: 'Rabona Digital',  tier: 'digital',    all_qualify: false },
  { id: 'UCebdo7-2NdjcktKzco64iNw', name: 'TRT Spor',        tier: 'broadcast',  all_qualify: false },
];

const BJK_TERMS  = ['beşiktaş', 'bjk', 'kartal', 'vodafone park'];
const TYPE_TERMS = [
  'özet', 'highlights', 'basın toplantısı', 'röportaj', 'röportajı',
  'interview', 'açıklama', 'maç sonu', 'goller', 'antrenman', 'press conference',
  'full maç', 'fullmatch', 'full match',
];
const EXCLUDE_TERMS = ['#shorts', ' shorts '];
// Matches "YYYY/YYYY" season notation for pre-2024 seasons (e.g. "2016/2017", "2022/2023")
const ARCHIVE_SEASON_RE = /\b20(0[0-9]|1[0-9]|2[0-3])\/20\d{2}\b/;

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
      video_id:      videoId,
      title:         decode(title),
      published_at:  pubDate.toISOString(),
      description:   decode(desc).slice(0, 400),
      thumbnail_url: thumb,
      channel_id:    channel.id,
      channel_name:  channel.name,
      channel_tier:  channel.tier,
    });
  }
  return videos;
}

export function qualifyYouTubeVideo(video) {
  const t = video.title.toLowerCase();
  if (EXCLUDE_TERMS.some(k => t.includes(k))) return false;
  // Skip archive season re-uploads (e.g. "2016/2017", "2022/2023") — not current news
  if (ARCHIVE_SEASON_RE.test(video.title)) return false;
  if (video.channel_tier === 'official') return true;
  return BJK_TERMS.some(k => t.includes(k)) && TYPE_TERMS.some(k => t.includes(k));
}

function decode(s) {
  return (s || '')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/g, "'");
}
