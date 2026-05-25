import { callClaude, supabase, extractText, simpleHash, MODEL_FETCH, MODEL_GENERATE, generateSlug, getEditorialNotes } from './utils.js';
import { normalizeTitle, titleSimilarity, extractKeyTokens, sharedStoryTokens } from './processor.js';
import { extractFacts, writeTransfer, extractFactsForStory, SKIP_STORY_TYPES } from './firewall.js';
import { getLastFixtures, getBJKStanding, getLeagueContext } from './api-football.js';
// Note: getBJKLastLineupData + getOpponentLastLineup imported by caller (worker) to avoid circular deps

// ─── FACTUAL GROUNDING ────────────────────────────────────────
// Fetches verified API-Football stats and returns a Turkish-language
// "DOĞRULANMIŞ VERİLER" block that is prepended to every synthesis prompt.
// Prevents Claude from making false situational claims (wrong league position,
// fabricated results, "kritik viraj" framing without supporting data).
// Returns '' gracefully if API is unavailable so generation continues.
const MONTHS_TR = ['','Oca','Şub','Mar','Nis','May','Haz','Tem','Ağu','Eyl','Eki','Kas','Ara'];
function monthName(m) { return MONTHS_TR[m] || ''; }

async function buildGroundingContext(env, site = null, opponentId = null) {
  try {
    // Use site config for multi-tenant support; fall back to BJK defaults
    const teamId   = site?.team_id   || 549;
    const leagueId = site?.league_id || 203;
    const season   = site?.season    || 2025;

    const ctx = await getLeagueContext(teamId, leagueId, season, env, opponentId);

    // Fallback to legacy path if league context unavailable
    if (!ctx) {
      const [fixtures, standing] = await Promise.all([
        getLastFixtures(env, 5),
        getBJKStanding(env),
      ]);
      if (!standing && !fixtures?.length) return '';
      const lines = [];
      if (standing) {
        const all = standing.all || {};
        lines.push(`${standing.rank}. sıra | ${standing.points} puan | ${all.played ?? '?'} maç`);
      }
      const finished = (fixtures || []).filter(f => f.is_finished);
      if (finished.length) {
        lines.push(`Son maçlar: ${finished.map(f => {
          const o = f.score_bjk > f.score_opp ? 'G' : f.score_bjk === f.score_opp ? 'B' : 'M';
          return `${f.opponent} ${f.score_bjk}-${f.score_opp}(${o})`;
        }).join(', ')}`);
      }
      return `\n\nDOĞRULANMIŞ VERİLER (API-Football, ${new Date().toISOString().slice(0, 10)}):\n` +
        lines.join('\n') + `\nSadece bu verilere dayanan durum değerlendirmesi yap.`;
    }

    const lines = [];
    const today = new Date().toISOString().slice(0, 10);

    // Position and standing — with practical European implication
    const posMeaning = ctx.position_meaning ? ` (${ctx.position_meaning})` : '';
    const ownSpotStr = ctx.own_spot
      ? ` → ${ctx.own_spot.comp_short} ${ctx.own_spot.entry_round}${ctx.own_spot.start_month ? `, ${monthName(ctx.own_spot.start_month)} başı` : ''}${ctx.own_spot.extra_games && ctx.own_spot.extra_games !== '0' ? `, ${ctx.own_spot.extra_games} eleme maçı` : ''}`
      : '';
    lines.push(`${ctx.team}: ${ctx.position}. sıra${posMeaning}${ownSpotStr} | ${ctx.points} puan | ${ctx.games_remaining} maç kaldı`);

    // Season targets with practical spot implications
    const targetLines = [];
    for (const [label, g] of Object.entries(ctx.gaps || {})) {
      if (label === 'relegation') continue;
      const spotStr = g.spot ? ` [${g.spot.comp_short} ${g.spot.entry_round}${g.spot.start_month ? ` ${monthName(g.spot.start_month)}` : ''}${g.spot.extra_games && g.spot.extra_games !== '0' ? ` +${g.spot.extra_games} maç` : ''}]` : '';
      if (g.points_gap <= 0)      targetLines.push(`${label.toUpperCase()} (${g.position}. sıra): zaten burada${spotStr}`);
      else if (g.possible)        targetLines.push(`${label.toUpperCase()} (${g.position}. sıra): ${g.points_gap} puan geride, mümkün${spotStr}`);
      else                        targetLines.push(`${label.toUpperCase()} (${g.position}. sıra): imkansız`);
    }
    if (ctx.gaps?.relegation) {
      const rg = ctx.gaps.relegation;
      targetLines.push(`Küme düşme (${rg.position}. sıra): ${rg.points_gap <= 0 ? `${Math.abs(rg.points_gap)} puan güvende` : `TEHLIKE — ${rg.points_gap} puan geride`}`);
    }
    if (targetLines.length) lines.push(`Hedefler: ${targetLines.join(' | ')}`);

    // Recent form
    if (ctx.form?.length) {
      lines.push(`Son form: ${ctx.form.join('-')}`);
    }

    // Rivals and their next matches
    if (ctx.rivals?.length) {
      const rivalLines = ctx.rivals.map(r => {
        const next = ctx.rival_fixtures?.[r.name];
        const nextStr = next ? ` (${next.home ? 'E' : 'D'}: ${next.opponent}, ${next.date})` : '';
        return `${r.name} ${r.position}. sıra ${r.points}p${nextStr}`;
      });
      lines.push(`Puan yarışındaki rakipler: ${rivalLines.join(' | ')}`);
    }

    // Opponent context
    if (ctx.opponent) {
      const opp = ctx.opponent;
      lines.push(`Rakip: ${opp.name} — ${opp.position}. sıra | ${opp.points} puan | Motivasyon: ${opp.motivation}${opp.description ? ` (${opp.description})` : ''}`);
    }

    // Manual season notes
    if (ctx.season_notes) lines.push(`Sezon notu: ${ctx.season_notes}`);

    return (
      `\n\nDOĞRULANMIŞ VERİLER (API-Football, ${today}):\n` +
      lines.join('\n') +
      `\nBu verilerle çelişen durum yorumu yapma. "kritik viraj", "büyük kriz" gibi ifadeler yalnızca sayılar bunu destekliyorsa kullanılabilir.`
    );
  } catch (e) {
    console.error('buildGroundingContext failed:', e.message);
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
  const trust = (article.trust_tier || article.trust || '').toLowerCase();
  const nvs   = article.nvs || 0;

  // Hot News hold: P4 articles younger than 15 minutes are not published
  if (isHotNewsHeld(article)) return 'hot_news_hold';

  const today   = new Date().toISOString().slice(0, 10);
  const pubDate = (article.published_at || '').slice(0, 10);
  const isToday = pubDate === today;

  if (trust === 'official')                return 'template_official';
  // template_matchday / template_postmatch removed: match watcher generates T05 independently.
  // category:'match' RSS articles were incorrectly routed here, producing MAÇ GÜNÜ stubs
  // with the original article title but empty match data.
  if (cat === 'injury')                   return 'template_injury';
  if (cat === 'transfer' && nvs >= 70)    return 'template_transfer';
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

async function extractKeyEntities(title, sourceText, env) {
  const prompt = `Aşağıdaki spor haberinin en kritik bilgilerini çıkar. Sadece metinde geçen gerçek bilgileri yaz — tahmin etme.

Başlık: ${title}
Metin: ${sourceText.slice(0, 1200)}

Şu formatta yanıt ver:
KİŞİLER: [haberde geçen oyuncu/teknik direktör/yönetici isimleri, virgülle ayır — yoksa boş bırak]
OLAY: [ne oldu — kısa, fiil içeren tek cümle]
DETAYLAR: [önemli rakamlar, tarihler, maç/kulüp/turnuva adları — yoksa boş bırak]`;
  try {
    const res = await callClaude(env, MODEL_FETCH, prompt, false, 150);
    return extractText(res.content).trim();
  } catch {
    return '';
  }
}

const PROXY_BASE = 'https://pitchos-proxy.onrender.com';

// Gate: does the available content actually deliver on what the title promises?
// Cheap check (~200 input tokens, 1-2 output). Returns true if content is sufficient,
// false if the title makes claims the source doesn't support.
export async function checkContentCoversTitlePromise(title, content, env) {
  const prompt = `Kaynak başlık: "${title}"

Kaynak içerik:
${content.slice(0, 2500)}

Bu kaynak içerik, başlığın vaat ettiği konuyu ve bilgileri yeterince kapsıyor mu?
Başlıkta geçen önemli kişi, iddia, rakam veya detaylar içerikte gerçekten mevcut mu?

Sadece EVET ya da HAYIR yaz.`;

  try {
    const res = await callClaude(env, MODEL_FETCH, prompt, false, 5);
    const answer = extractText(res.content).trim().toUpperCase();
    return answer.startsWith('EVET');
  } catch {
    return true; // on error, don't block synthesis
  }
}

async function generateKartalixTitle(body, rssTitle, env) {
  const prompt = `Sen Beşiktaş haber siteleri için başlık yazan bir editörsün.

KAYNAK BAŞLIK (sadece referans — kopyalama, clickbait olabilir):
${rssTitle}

HABER METNİ:
${body.slice(0, 1500)}

Bu haber için Türkçe bir başlık yaz:
- 50-75 karakter
- Haberin ana iddiasını yansıt (yan detayı değil)
- Öznenin adını (oyuncu / teknik direktör / kulüp) erken kullan
- Abartma yok: "flaş", "bomba", "şok", "sürpriz" kullanma (metinde açıkça yoksa)
- Emoji yok, tamamı büyük harf yok, ünlem işareti yok
- Gerçek bir Türk futbol haberi başlığı gibi oku

Sadece başlığı yaz. Başka hiçbir şey yazma.`;

  try {
    const clean = t => t.trim().replace(/^["'«»]+|["'«»]+$/g, '').replace(/\.+$/, '').trim();
    const res = await callClaude(env, MODEL_FETCH, prompt, false, 50);
    const title = clean(extractText(res.content));
    if (title.length >= 30 && title.length <= 100) return title;

    const res2 = await callClaude(env, MODEL_FETCH, prompt, false, 50);
    const title2 = clean(extractText(res2.content));
    if (title2.length >= 30 && title2.length <= 100) return title2;

    // Fallback: first sentence of body capped at 80 chars
    return (body.split(/[.!?]/)[0].trim().slice(0, 80)) || rssTitle;
  } catch {
    return rssTitle;
  }
}

async function extractFactsFromSource(title, sourceText, env) {
  const prompt = `Aşağıdaki Beşiktaş haberinden yalnızca açıkça belirtilen gerçekleri çıkar. Tahmin etme, ekstra bağlam ekleme.

Başlık: ${title}
Metin: ${sourceText.slice(0, 3000)}

Haberde geçen her doğrulanmış gerçeği MADDE şeklinde listele:
- [gerçek 1]
- [gerçek 2]
...

Sadece kaynak metinde birebir bulunan bilgileri yaz — oyuncu adı, kulüp, rakam, tarih, alıntı. Kaynak desteklemiyorsa madde ekleme.
Madde yoksa "Doğrulanmış bilgi yok." yaz.`;

  try {
    const res = await callClaude(env, MODEL_FETCH, prompt, false, 200);
    const text = extractText(res.content).trim();
    if (text === 'Doğrulanmış bilgi yok.' || !text) return { bullets: '', count: 0 };
    const lines = text.split('\n').filter(l => l.trim().startsWith('-'));
    return { bullets: text, count: lines.length };
  } catch {
    return { bullets: '', count: 0 };
  }
}

export async function synthesizeArticle(article, env, site = null, opts = {}) {
  const srcUrl = article.url || article.original_url || '';
  let sourceText = null; // null = source not fetched; synthesis requires real source text

  if (srcUrl && srcUrl !== '#') {
    try {
      if (!opts.proxyWarmed) {
        // Wake up Render free tier — cold start takes 10-30s; /health responds as soon as it's up
        const warmStart = Date.now();
        await fetch(PROXY_BASE + '/health', { signal: AbortSignal.timeout(35000) }).catch(() => {});
        // Grace period: health endpoint responds early in Render startup; article handler needs a
        // few more seconds. Only wait if health took >5s (i.e. this was a cold start, not warm).
        if (Date.now() - warmStart > 5000) {
          await new Promise(r => setTimeout(r, 3000));
        }
      }
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          if (attempt > 0) await new Promise(r => setTimeout(r, 4000));
          const res = await fetch(PROXY_BASE + '/article?url=' + encodeURIComponent(srcUrl),
            { signal: AbortSignal.timeout(15000) });
          if (res.ok) {
            const data = await res.json();
            if (data.content && data.content.length > 400) {
              sourceText = data.content.slice(0, 10000);
              break;
            }
          }
        } catch(e) {
          console.log(`synthesizeArticle: proxy attempt ${attempt + 1} failed:`, e.message);
        }
      }
    } catch(e) {
      console.log('synthesizeArticle: proxy fetch failed:', e.message, '|', srcUrl);
    }

    // Direct-fetch fallback: proxy yielded nothing — try Cloudflare egress directly.
    // Works for any source that blocks the Render proxy but allows Cloudflare IPs.
    if (!sourceText) {
      try {
        const dr = await fetch(srcUrl, {
          headers: { 'User-Agent': 'Mozilla/5.0 (compatible; Kartalix/1.0)', 'Accept': 'text/html' },
          signal: AbortSignal.timeout(12000),
        });
        if (dr.ok) {
          const html = await dr.text();
          const stripped = html
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();
          if (stripped.length > 400) {
            sourceText = stripped.slice(0, 10000);
            console.log(`DIRECT FETCH OK [${article.nvs}]: "${article.title?.slice(0, 50)}" — ${stripped.length}ch`);
          }
        }
      } catch(e) {
        console.log(`DIRECT FETCH ERROR [${article.nvs}]: ${e.message} | ${srcUrl}`);
      }
    }
  }

  // No RSS fallback — RSS summaries are often a single generic line that misrepresents
  // the actual story direction (e.g. "Player joins club" when the story is about them leaving).
  // Without real source text we cannot rewrite accurately, so we skip.
  if (!sourceText) {
    console.log('synthesizeArticle: skipping — could not fetch source content for', srcUrl);
    return { body: null };
  }

  // Gate: only synthesize if the source content actually delivers on the title's promise.
  const covers = await checkContentCoversTitlePromise(article.title, sourceText, env);
  if (!covers) {
    console.log(`SYNTHESIS GATE FAIL [${article.nvs}]: "${article.title?.slice(0, 60)}" — source does not cover title's promise`);
    return { body: null };
  }

  const [editorialCtx, groundingCtx, keyEntities, sourceFacts] = await Promise.all([
    getEditorialNotes(env, ['general', 'style']),
    buildGroundingContext(env, site),
    extractKeyEntities(article.title, sourceText, env),
    extractFactsFromSource(article.title, sourceText, env),
  ]);
  console.log(`FACTS EXTRACTED [${article.nvs}]: ${sourceFacts.count} bullets — "${article.title?.slice(0, 50)}"`);

  const entityBlock = keyEntities
    ? `\n\nZORUNLU BİLGİLER — bunlar haberde mutlaka yer almalı:\n${keyEntities}`
    : '';

  const targetWords = sourceFacts.count >= 7 ? '300-400'
                    : sourceFacts.count >= 4 ? '200-300'
                    : '150-200';

  const factsBlock = sourceFacts.bullets
    ? `\n\nKAYNAKTAN DOĞRULANAN BİLGİLER — haberde yalnızca bunlar kullanılabilir:\n${sourceFacts.bullets}`
    : '';

  const isOfficial = article.trust_tier === 'official';
  const sourceLabel = isOfficial
    ? `Kaynak: Beşiktaş JK resmi açıklaması — bu bilgi kesindir, "iddia" veya "kaynağına göre" çerçevesi yasak.`
    : `Kaynak metin: ${sourceText}`;

  const prompt = `Sen Kartalix'in Beşiktaş spor editörüsün. Aşağıdaki kaynak metinden özgün bir Kartalix haberi yaz.

Kaynak başlık: ${article.title}
${isOfficial ? `Kaynak metin: ${sourceText}\n${sourceLabel}` : sourceLabel}${factsBlock}${entityBlock}${editorialCtx}${groundingCtx}

Kurallar:
- ${targetWords} kelime — fazlası yasak. Kaynak kaç bilgi veriyorsa o kadar yaz.
- Türkçe, doğrudan haber üslubu
- İLK CÜMLE: KİŞİLER ve OLAY — kim, ne yaptı/oldu
- Yalnızca KAYNAK METNİNDE bulunan bilgileri yaz. Şunları YAZMA:
  * Genel meta-gözlemler ("X meselesi her dönem önemlidir", "Bu tür kararlar kritik viraj niteliği taşır")
  * Taraftar adına konuşma ("Taraftar ne beklediğini biliyor", "Tribünler bu kararı iyi karşılayacak")
  * Kaynak desteklemeyen yoğunlaştırıcılar: flaş, bomba, şok, sürpriz, tarihi, kritik — kaynak metinde bu kelime yoksa kullanma
  * Dolgu cümlesi — kelime hedefine ulaşmak için ek cümle ekleme
- Kaynak metinde tırnak içinde alıntı varsa kelimesi kelimesine koru
- DOĞRULANMIŞ VERİLER arka plan bilgisidir: sezon bağlamını habere işle ama birebir aktarma
- Paragraflar arası boş satır bırak
- Başlık ekleme`;

  const res = await callClaude(env, MODEL_GENERATE, prompt, false, 1000);
  let body = extractText(res.content).trim();

  // Detect Claude refusal/rejection responses — these must never be published.
  // Claude occasionally decides source content isn't publishable and returns an
  // explanation instead of article text. The phrases below are known refusal signals.
  const REFUSAL_SIGNALS = [
    'yayınlanabilir bir haber üretmek için yeterli içerik',
    'bu kaynak materyal',
    'haber yazamam',
    'yeterli bilgi bulunmamaktadır',
    'bu konuda haber yazamıyorum',
    'özür dilerim, bu',
    'üzgünüm, bu',
    'içerik yetersiz',
    'yayınlayamam',
    'yayımlayamam',
    'yayınlanamaz',
    'talimatları incelediğimde',
    'haberi yazabilirim',
    'yazmak mümkün değil',
    'talimat ihlal',
    'i cannot write',
    "i'm unable to",
    'i cannot create',
  ];
  const bodyLower = body.toLowerCase();
  if (REFUSAL_SIGNALS.some(sig => bodyLower.includes(sig))) {
    console.log(`SYNTHESIS REFUSED [${article.nvs}]: "${article.title?.slice(0, 50)}" — Claude returned refusal, treating as no-body`);
    return { body: null };
  }

  const [kartalixTitle, verification] = await Promise.all([
    generateKartalixTitle(body, article.title, env),
    verifyArticle(body, groundingCtx, env),
  ]);
  console.log(`TITLE GEN: "${kartalixTitle?.slice(0, 60)}" (was: "${article.title?.slice(0, 60)}")`);

  if (!verification.passed && verification.issues.length > 0) {
    console.log(`VERIFY FAIL: ${verification.issues.join('; ')}`);
    try {
      const fixPrompt = prompt + `\n\nDİKKAT — aşağıdaki olgusal hatalar tespit edildi, düzelt:\n${verification.issues.join('\n')}`;
      const res2 = await callClaude(env, MODEL_GENERATE, fixPrompt, false, 700);
      const body2 = extractText(res2.content).trim();
      if (body2.length > 200) {
        console.log(`VERIFY REGENERATED OK`);
        return { body: body2, title: kartalixTitle, needs_review: false, verification_result: { passed: true, issues: [], regenerated: true } };
      }
    } catch {}
    console.log(`VERIFY FAIL — needs_review flagged`);
    return { body, title: kartalixTitle, needs_review: true, verification_result: verification };
  }

  return { body, title: kartalixTitle, needs_review: false, verification_result: verification };
}

export async function writeArticles(articles, site, env) {
  const results = [];
  let factsExtracted = 0;

  // Warm proxy once before the loop if any article is likely to need synthesis.
  // Prevents the first synthesis call from paying both the cold-start cost AND
  // the article fetch timeout simultaneously.
  let proxyWarmed = false;
  if (articles.some(a => (a.nvs || 0) >= 30 && a.treatment !== 'embed')) {
    const warmStart = Date.now();
    await fetch(PROXY_BASE + '/health', { signal: AbortSignal.timeout(35000) }).catch(() => {});
    if (Date.now() - warmStart > 5000) await new Promise(r => setTimeout(r, 3000));
    proxyWarmed = true;
    console.log(`PROXY WARM-UP: ready in ${Date.now() - warmStart}ms`);
  }

  for (let i = 0; i < articles.length; i++) {
    const article = articles[i];
    const mode = decidePublishMode(article);
    let published = { ...article, publish_mode: mode };

    if (mode === 'template_official') {
      // Official source tweet — publish verbatim, no synthesis, no template extraction.
      published.summary      = cleanRSS(article.summary || article.description || '');
      published.full_body    = published.summary;
      // keep publish_mode = 'template_official'

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

      // Auto-synthesis: for high-NVS articles, fetch source and write a full Kartalix article.
      // Cap 6 rewrites per run; overflow is queued to rewrite:queue:<siteCode> KV for the next hourly run.
      if ((article.nvs || 0) >= 30) {
        const rewritesSoFar = results.filter(r => r.publish_mode === 'rewrite').length;
        if (rewritesSoFar < 6) {
          // Cap counts rewrite SUCCESSES only — publish_mode is set to 'rewrite' only when
          // body.length > 600 (line ~613). Failed attempts leave publish_mode as 'rss_summary'
          // and do not increment rewritesSoFar. Verified 2026-05-22, no code change needed.
          let result = null;
          try {
            result = await synthesizeArticle(article, env, site, { proxyWarmed });
          } catch(e) {
            console.error('Synthesis failed:', e.message, '|', article.title?.slice(0, 50));
          }

          // Primary failed — try up to 2 dedup siblings (same story, different source URL).
          // Capped at 2 to bound Claude cost on busy days with large story clusters.
          if ((!result?.body || result.body.length <= 600) && article._siblings?.length > 0) {
            console.log(`SYNTHESIS RETRY: trying ${Math.min(article._siblings.length, 2)} sibling(s) for "${article.title?.slice(0, 50)}"`);
            for (const sibling of article._siblings.slice(0, 2)) {
              try {
                const retry = await synthesizeArticle(
                  { ...sibling, nvs: article.nvs, category: article.category },
                  env, site, { proxyWarmed }
                );
                if (retry?.body && retry.body.length > 600) {
                  result = retry;
                  // Attribution must point to the source whose content was actually synthesized.
                  published.source_name  = sibling.source_name || sibling.source || published.source_name;
                  published.source       = sibling.source_name || sibling.source || published.source;
                  published.url          = sibling.url          || sibling.original_url || published.url;
                  published.original_url = sibling.original_url || sibling.url          || published.original_url;
                  published._used_sibling_source = sibling.source_name || sibling.source;
                  console.log(`SYNTHESIS RECOVERED via sibling: ${sibling.source_name} | "${article.title?.slice(0, 50)}"`);
                  break;
                }
              } catch(e) {
                console.error('Sibling synthesis failed:', e.message, '|', sibling.source_name, sibling.url?.slice(0, 60));
              }
            }
          }

          const body = result?.body;
          if (body && body.length > 600) {
            published.full_body           = body;
            published.publish_mode        = 'rewrite';
            published.needs_review        = result.needs_review || false;
            published.verification_result = result.verification_result || null;
            if (result.title && result.title !== article.title) {
              published.original_rss_title = article.title;
              published.title              = result.title;
            }
            console.log(`SYNTHESIS OK [${article.nvs}]: "${(result.title || article.title)?.slice(0, 50)}" — ${body.length}ch${result.needs_review ? ' ⚠️ needs_review' : ''}`);
          } else if (!body) {
            console.log(`SYNTHESIS SKIPPED [${article.nvs}]: "${article.title?.slice(0, 50)}" — no source, stays rss_summary`);
          }
          await new Promise(r => setTimeout(r, 300));
        } else {
          // Cap reached — queue for next hourly drain
          await enqueueForRewrite(article, site?.short_code || 'BJK', env);
        }
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
export async function saveArticles(env, siteId, articles, status = 'published') {
  if (!articles || articles.length === 0) return { saved: [], failed: [] };

  // rss_summary = raw feed text, never synthesized — do not save to DB.
  // Also block refusal text and thin bodies.
  const BODY_REFUSAL_SIGNALS = [
    'yayınlanabilir bir haber üretmek için yeterli içerik',
    'bu kaynak materyal',
    'haber yazamam',
    'yeterli bilgi bulunmamaktadır',
    'yayınlayamam',
    'yayımlayamam',
    'yayınlanamaz',
    'talimatları incelediğimde',
    'haberi yazabilirim',
    'yazmak mümkün değil',
    'talimat ihlal',
  ];
  const MIN_BODY_CHARS = 600; // ~80 words minimum — below this the article is too thin to publish
  const thinDropped = [];
  let publishable = articles.filter(a => {
    if (a.publish_mode === 'rss_summary') return false;
    const body = (a.full_body || '').toLowerCase();
    if (BODY_REFUSAL_SIGNALS.some(sig => body.includes(sig))) {
      console.warn(`SAVE BLOCKED — refusal text in body: "${(a.title || '').slice(0, 60)}"`);
      return false;
    }
    // Template cards (event flashes, lineups) are legitimately short — only enforce for synthesis
    const isSynth = ['rewrite', 'original_synthesis', 'template_transfer'].includes(a.publish_mode);
    if (isSynth && (a.full_body || '').length < MIN_BODY_CHARS) {
      console.warn(JSON.stringify({
        event: 'thin_body_blocked',
        url: a.original_url || a.url,
        source_name: a.source_name,
        publish_mode: a.publish_mode,
        nvs: a.nvs || a.nvs_score,
        body_length: (a.full_body || '').length,
        title: (a.title || '').slice(0, 80),
      }));
      thinDropped.push(a);
      return false;
    }
    return true;
  });
  if (publishable.length === 0) return { saved: [], failed: [], thinDropped };

  // Cross-run story dedup — check recently published articles from DB.
  // Catches the same story published by multiple sources across different cron runs.
  try {
    const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
    const recent = await supabase(env, 'GET',
      `/rest/v1/content_items?site_id=eq.${siteId}&status=eq.published&published_at=gte.${since}&select=title&limit=100&order=published_at.desc`
    );
    const recentTitles = (recent || []).map(r => r.title).filter(Boolean);
    if (recentTitles.length > 0) {
      publishable = publishable.filter(a => {
        const aNorm = normalizeTitle(a.title);
        const aKeys = extractKeyTokens(a.title);
        const isDupe = recentTitles.some(rt => {
          if (titleSimilarity(aNorm, normalizeTitle(rt)) >= 0.5) return true;
          return sharedStoryTokens(aKeys, extractKeyTokens(rt)) >= 3;
        });
        if (isDupe) {
          console.log(`CROSS-RUN DEDUP: "${(a.title || '').slice(0, 60)}" — similar article already published in last 24h`);
          return false;
        }
        return true;
      });
    }
  } catch (e) {
    console.warn('Cross-run dedup query failed (non-blocking):', e.message);
  }

  const isSynthesized = m => m === 'rewrite' || m === 'original_synthesis' || (m && m.startsWith('template') && m !== 'template_official') || m === 'video_embed' || m === 'youtube_embed' || (m && m.startsWith('youtube_'));

  const rows = publishable.map(a => ({
    site_id:      siteId,
    source_type:  isSynthesized(a.publish_mode) ? 'kartalix' : 'rss',
    source_name:  isSynthesized(a.publish_mode) ? 'Kartalix'  : (a.source_name || a.source || 'Unknown'),
    original_url: a.url || a.original_url || '',
    title:        a.title || '',
    summary:      a.summary || '',
    full_body:    a.full_body || '',
    category:     a.category || 'Club',
    content_type: a.content_type || 'fact',
    sport:        a.sport || 'football',
    nvs_score:       a.nvs || a.nvs_score || 0,
    first_nvs_score: a.nvs || a.nvs_score || 0,
    trust_score:     tierToTrustScore(a.trust_tier || a.trust),
    nvs_notes:    a.nvs_notes || '',
    golden_score: a.golden_score != null ? String(a.golden_score) : null,
    image_url:    a.image_url || '',
    publish_mode:        a.publish_mode || 'rss_summary',
    needs_review:        a.needs_review || false,
    verification_result: a.verification_result || null,
    status,
    reviewed_by:         'auto',
    fetched_at:   a.published_at || a.fetched_at || new Date().toISOString(),
    reviewed_at:  new Date().toISOString(),
    slug:               a.slug || generateSlug(a.title, a.published_at || a.fetched_at),
    original_rss_title: a.original_rss_title || null,
  }));

  console.log('SUPABASE INSERT: attempting', rows.length, 'rows (status=' + status + ')');

  try {
    const result = await supabase(env, 'POST', '/rest/v1/content_items', rows,
      { 'Prefer': 'return=representation,resolution=ignore-duplicates' });

    if (result && result.error) {
      const errMsg = JSON.stringify(result.error);
      console.error('SUPABASE INSERT ERROR:', errMsg);
      return { saved: [], failed: publishable, error: errMsg, thinDropped };
    }

    // Map DB-returned IDs back to original article objects by slug
    const savedRows = Array.isArray(result) ? result : [];
    const idBySlug = Object.fromEntries(savedRows.map(r => [r.slug, r.id]).filter(([s, id]) => s && id));
    const savedWithIds = publishable.map(a => {
      const slug = a.slug || '';
      return idBySlug[slug] ? { ...a, id: idBySlug[slug] } : a;
    });

    console.log(`SUPABASE INSERT OK: ${publishable.length} articles, ${savedRows.length} returned with IDs`);
    return { saved: savedWithIds, failed: [], thinDropped };
  } catch (e) {
    console.error('SUPABASE INSERT EXCEPTION:', e.message);
    return { saved: [], failed: publishable, error: e.message, thinDropped };
  }
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
    model_used:         `${MODEL_FETCH}`.slice(0, 50),
    error_message:      funnelStats
      ? JSON.stringify({ ...funnelStats, _error: errorMsg || null })
      : errorMsg || null,
    duration_ms:        stats.durationMs          || null,
  };
  const result = await supabase(env, 'POST', '/rest/v1/fetch_logs', row);
  if (!result) console.error('logFetch: insert returned null — check fetch_logs schema/constraints');
}

// ─── KV CACHE ─────────────────────────────────────────────────

// Half-lives in hours. Templates with kickoff-pin logic use null.
const HALF_LIFE_BY_TEMPLATE = {
  'T10': 0.5, 'T-HT': 0.5, 'T-RED': 0.5, 'T-VAR': 0.5, 'T-OG': 0.5, 'T-PEN': 0.5,
  'T11': 4,
  'T12': 24, 'T13': 24,
  'T01': 18, 'T02': 18, 'T03': 18,
  'T07': 36, 'T08c': 8, 'T-REF': 18, 'T-XG': 12,
  'T05': null, // pinned until kickoff+2h, then 4h decay
};
const HALF_LIFE_BY_MODE = {
  'rewrite': 24, 'synthesis': 24,
  'original_synthesis': 24, 'synthesis_generated': 24,
  'copy_source': 3, 'rss_summary': 0.5,
  'manual': 96,
  'video_embed': 24, 'youtube_embed': 48,
};
// Hard TTL caps (hours). Evict unconditionally after this age.
const HARD_TTL_BY_TEMPLATE = {
  // In-match / post-match events — evict fast
  'T10': 3, 'T-HT': 3, 'T-RED': 3, 'T-VAR': 3, 'T-OG': 3, 'T-PEN': 3,
  'T11': 12, 'T12': 72, 'T13': 72,
  // Pre-match previews — evict well after the final whistle
  'T01': 36, 'T03': 36, 'T07': 24, 'T-REF': 36,
  'T02': 72, // H2H history — low urgency, keep a bit longer
  'T09': 12, // Lineup — only useful on match day
};
const HARD_TTL_BY_MODE = {
  'copy_source': 12, 'rss_summary': 2, 'manual': 168,
};

function getArticleAge(article) {
  const ts = article.fetched_at || article.published_at || article.created_at;
  if (!ts) return 0;
  return (Date.now() - new Date(ts).getTime()) / 3600000; // hours
}

// Returns { halfLife (hours | null for pin), hardTtl (hours | null) }
function getDecayParams(article) {
  const tid = article.template_id;
  const mode = article.publish_mode;
  const halfLife = tid
    ? (HALF_LIFE_BY_TEMPLATE[tid] !== undefined ? HALF_LIFE_BY_TEMPLATE[tid] : 18)
    : (HALF_LIFE_BY_MODE[mode] || 8);
  const hardTtl = tid
    ? (HARD_TTL_BY_TEMPLATE[tid] || null)
    : (HARD_TTL_BY_MODE[mode] || null);
  return { halfLife, hardTtl };
}

// ─── PERSISTENT REWRITE QUEUE (H1) ───────────────────────────
// When the per-run synthesis cap (6) is hit, overflow articles are saved to KV
// and drained by the hourly cron. Each entry: { url, title, nvs, source_name, summary, fetched_at }
const REWRITE_QUEUE_MAX = 200;
const REWRITE_QUEUE_TTL = 48 * 3600; // 48h

export async function enqueueForRewrite(article, siteCode, env) {
  const key = `rewrite:queue:${siteCode}`;
  let queue = [];
  try { const raw = await env.PITCHOS_CACHE.get(key); if (raw) queue = JSON.parse(raw); } catch {}
  const url = article.url || article.original_url || '';
  if (!url || queue.some(e => e.url === url)) return; // already queued
  queue.push({
    url,
    title:     article.title || '',
    nvs:       article.nvs || 0,
    source_name: article.source_name || article.source || '',
    summary:   (article.summary || article.description || '').slice(0, 2000),
    fetched_at: article.fetched_at || new Date().toISOString(),
  });
  // keep top REWRITE_QUEUE_MAX by NVS
  queue.sort((a, b) => b.nvs - a.nvs);
  if (queue.length > REWRITE_QUEUE_MAX) queue = queue.slice(0, REWRITE_QUEUE_MAX);
  await env.PITCHOS_CACHE.put(key, JSON.stringify(queue), { expirationTtl: REWRITE_QUEUE_TTL });
  console.log(`REWRITE QUEUE [${siteCode}]: queued "${article.title?.slice(0, 40)}" NVS=${article.nvs} (queue=${queue.length})`);
}

// Called by the hourly cron. Drains up to 8 articles from the rewrite queue.
export async function drainRewriteQueue(site, env) {
  const siteCode = site.short_code || 'BJK';
  const key = `rewrite:queue:${siteCode}`;
  let queue = [];
  try { const raw = await env.PITCHOS_CACHE.get(key); if (raw) queue = JSON.parse(raw); } catch { return 0; }
  if (!queue.length) return 0;

  // Prune stale entries (> 48h)
  const cutoff = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  queue = queue.filter(e => !e.fetched_at || e.fetched_at >= cutoff);

  const batch = queue.slice(0, 8);
  const succeeded = [];
  const results = [];

  // Warm proxy once before draining the batch
  let proxyWarmed = false;
  if (batch.length > 0) {
    const warmStart = Date.now();
    await fetch(PROXY_BASE + '/health', { signal: AbortSignal.timeout(35000) }).catch(() => {});
    if (Date.now() - warmStart > 5000) await new Promise(r => setTimeout(r, 3000));
    proxyWarmed = true;
    console.log(`PROXY WARM-UP (drain): ready in ${Date.now() - warmStart}ms`);
  }

  for (const entry of batch) {
    try {
      const article = { title: entry.title, url: entry.url, original_url: entry.url,
        source_name: entry.source_name, summary: entry.summary, nvs: entry.nvs,
        fetched_at: entry.fetched_at, category: 'Haber', content_type: 'fact', sport: 'football' };
      const result = await synthesizeArticle(article, env, site, { proxyWarmed });
      const body = result?.body;
      if (body && body.length > 600) {
        results.push({ ...article, full_body: body, publish_mode: 'rewrite',
          needs_review: result.needs_review || false, verification_result: result.verification_result || null });
        succeeded.push(entry.url);
        console.log(`REWRITE DRAIN OK [${siteCode}]: "${entry.title?.slice(0, 50)}" NVS=${entry.nvs}`);
      } else {
        succeeded.push(entry.url); // skip silently — no source content available
        console.log(`REWRITE DRAIN SKIP [${siteCode}]: "${entry.title?.slice(0, 50)}" — no source`);
      }
    } catch(e) {
      console.error(`REWRITE DRAIN FAIL [${siteCode}]: "${entry.title?.slice(0, 50)}" —`, e.message);
      // Leave in queue for retry
    }
    await new Promise(r => setTimeout(r, 300));
  }

  // Remove processed (success or skip) from queue; failures stay for retry
  queue = queue.filter(e => !succeeded.includes(e.url));
  await env.PITCHOS_CACHE.put(key, JSON.stringify(queue), { expirationTtl: REWRITE_QUEUE_TTL });
  console.log(`REWRITE DRAIN [${siteCode}]: processed ${succeeded.length}, remaining ${queue.length}`);
  return results;
}

// Maps trust_tier (old string labels or new T1–T4) to a numeric trust_score.
// trust_multiplier = trust_score / 50  →  T1 = 1.8×, T2 = 1.4×, T3 = 1.0×, T4 = 0.5×
const TIER_SCORES = {
  T1: 90, official: 90,
  T2: 70, broadcast: 70,
  T3: 50, press: 50, journalist: 50,
  T4: 25, digital: 25, aggregator: 25,
};
export function tierToTrustScore(tier) { return TIER_SCORES[tier] || 50; }

export function rankAndEvict(articles, limit = 200, opts = {}) {
  const { kickoffIso = null, floor = 5, minPool = 0 } = opts;
  const kickoffMs = kickoffIso ? new Date(kickoffIso).getTime() : null;
  const nowMs = Date.now();

  // Dedupe by title hash (keep first occurrence)
  const seen = new Set();
  const unique = articles.filter(a => {
    const hash = simpleHash(a.title);
    if (seen.has(hash)) return false;
    seen.add(hash);
    return true;
  });

  const scored = unique.map(a => {
    const ageHours = getArticleAge(a);
    const { halfLife, hardTtl } = getDecayParams(a);
    const nvs = a.nvs || a.nvs_score || 0;
    const storyBoost = Math.min(1.4, 1.0 + ((a.contributions_last_6h || 0) * 0.05));
    const trustMultiplier = Math.max(0.2, Math.min(2.0, (a.trust_score || 50) / 50));

    // Hard TTL: evict unconditionally
    if (hardTtl && ageHours >= hardTtl) return { ...a, _rank: -1 };

    let rankScore;
    if (a.template_id === 'T05' && kickoffMs) {
      // T05 lineup: pinned until kickoff + 2h, then fast decay
      const postKickoffHours = (nowMs - kickoffMs) / 3600000;
      if (postKickoffHours < 2) {
        rankScore = 1000; // pinned
      } else {
        rankScore = nvs * Math.exp(-postKickoffHours / 4) * storyBoost;
      }
    } else if (halfLife === null) {
      rankScore = nvs * storyBoost; // no decay (unknown pin template)
    } else {
      rankScore = nvs * Math.exp(-ageHours / halfLife) * storyBoost;
    }

    if (rankScore > 0) rankScore *= trustMultiplier;

    // Templates with valid rank still float above rewrites at same score
    // by adding a small bias (preserves existing behavior for fresh templates)
    if (a.template_id && rankScore > 0) rankScore += 0.1;

    return { ...a, _rank: rankScore };
  });

  // Classify evictions and build slug → reason map for churn tracking
  const evictedReasonMap = new Map();
  const survived = [];
  for (const a of scored) {
    const slug = a.slug || null;
    if (a._rank === -1) {
      if (slug) evictedReasonMap.set(slug, 'ttl');
      continue;
    }
    if (a._rank < floor) {
      if (slug) evictedReasonMap.set(slug, 'aged_out');
      continue;
    }
    survived.push(a);
  }
  survived.sort((a, b) => b._rank - a._rank);

  // Minimum pool guarantee: if floor-filtering drops pool below minPool, keep the
  // highest-ranked sub-floor articles (hard-TTL evictions are still permanent).
  if (minPool > 0 && survived.length < minPool) {
    const subFloor = scored
      .filter(a => a._rank > 0 && a._rank < floor)
      .sort((a, b) => b._rank - a._rank);
    const needed = Math.min(minPool - survived.length, subFloor.length);
    if (needed > 0) {
      survived.push(...subFloor.slice(0, needed));
      survived.sort((a, b) => b._rank - a._rank);
    }
  }

  const overflowItems = survived.slice(limit);
  for (const a of overflowItems) {
    const slug = a.slug || null;
    if (slug) evictedReasonMap.set(slug, 'overflow');
  }

  return {
    articles: survived.slice(0, limit).map(({ _rank, ...rest }) => rest),
    evictedReasonMap,
  };
}

export async function cacheToKV(env, siteCode, articles, opts = {}) {
  try {
    const { articles: ranked, evictedReasonMap } = rankAndEvict(articles, 200, { minPool: 20, ...opts });
    const key = `articles:${siteCode}`;
    const timelineKey = `kv:timeline:${siteCode}`;
    const now = new Date().toISOString();

    const [oldRaw, timelineRaw] = await Promise.all([
      env.PITCHOS_CACHE.get(key),
      env.PITCHOS_CACHE.get(timelineKey),
    ]);
    const oldSlugs = new Set((oldRaw ? JSON.parse(oldRaw) : []).map(a => a.slug).filter(Boolean));
    const newSlugs = new Set(ranked.map(a => a.slug).filter(Boolean));
    const timeline = timelineRaw ? JSON.parse(timelineRaw) : {};

    for (const slug of newSlugs) {
      if (!timeline[slug]) timeline[slug] = {};
      if (!timeline[slug].published_at) timeline[slug].published_at = now;
      timeline[slug].last_seen = now;
      delete timeline[slug].removed_at;
      delete timeline[slug].removed_reason;
    }
    for (const slug of oldSlugs) {
      if (!newSlugs.has(slug) && timeline[slug] && !timeline[slug].removed_at) {
        timeline[slug].removed_at = now;
        timeline[slug].removed_reason = evictedReasonMap.get(slug) || 'aged_out';
      }
    }

    // Accumulate daily pool churn for KPI strip
    const addedSlugs = [...newSlugs].filter(s => !oldSlugs.has(s));
    const removedSlugs = [...oldSlugs].filter(s => !newSlugs.has(s));
    if (addedSlugs.length > 0 || removedSlugs.length > 0) {
      const today = now.slice(0, 10);
      const churnKey = `churn:${siteCode}:${today}`;
      const churnRaw = await env.PITCHOS_CACHE.get(churnKey).catch(() => null);
      const churn = churnRaw ? JSON.parse(churnRaw) : { added: 0, removed_total: 0, removed_aged_out: 0, removed_ttl: 0, removed_overflow: 0 };
      churn.added += addedSlugs.length;
      churn.removed_total += removedSlugs.length;
      for (const slug of removedSlugs) {
        const reason = evictedReasonMap.get(slug) || 'aged_out';
        if (reason === 'ttl') churn.removed_ttl++;
        else if (reason === 'overflow') churn.removed_overflow++;
        else churn.removed_aged_out++;
      }
      env.PITCHOS_CACHE.put(churnKey, JSON.stringify(churn), { expirationTtl: 86400 * 16 }).catch(() => {});
    }

    const value = JSON.stringify(ranked);
    console.log(`KV WRITE: key=${key} in=${articles.length} out=${ranked.length} size=${value.length} chars`);
    await Promise.all([
      env.PITCHOS_CACHE.put(key, value, { expirationTtl: 43200 }), // 12h — covers 00:00–06:30 IST quiet period
      env.PITCHOS_CACHE.put(timelineKey, JSON.stringify(timeline), { expirationTtl: 86400 * 90 }),
    ]);
    // Pool composition time-series — awaited so quiet crons (no new articles) also write snapshots.
    // Fire-and-forget was silently dropped when the scheduled handler returned before the GET→PUT chain completed.
    try {
      const yzModes = new Set(['rewrite','synthesis','original_synthesis','synthesis_generated']);
      const vidModes = new Set(['youtube_embed','video_embed','rabona_digest']);
      const snap = { t: Date.now() };
      snap.yz       = ranked.filter(a => yzModes.has(a.publish_mode)).length;
      snap.video    = ranked.filter(a => vidModes.has(a.publish_mode)).length;
      snap.template = ranked.filter(a => a.publish_mode && a.publish_mode.startsWith('template')).length;
      snap.rss      = ranked.filter(a => !a.publish_mode || a.publish_mode === 'rss_summary').length;
      snap.other    = Math.max(0, ranked.length - snap.yz - snap.video - snap.template - snap.rss);
      // total derived from categories so badge and chart stacks always agree
      snap.total    = snap.yz + snap.video + snap.template + snap.rss + snap.other;
      const tsKey = `pool_ts:${siteCode}`;
      const tsRaw = await env.PITCHOS_CACHE.get(tsKey).catch(() => null);
      const arr = tsRaw ? JSON.parse(tsRaw) : [];
      // One snapshot per 5-min window — skip if last entry was < 4 minutes ago (multiple cacheToKV calls per cron)
      const lastSnap = arr[arr.length - 1];
      if (!lastSnap || snap.t - lastSnap.t >= 4 * 60 * 1000) {
        arr.push(snap);
        if (arr.length > 576) arr.splice(0, arr.length - 576); // keep 48h at 5-min intervals
        await env.PITCHOS_CACHE.put(tsKey, JSON.stringify(arr), { expirationTtl: 86400 * 3 });
      }
    } catch(_) {}
    console.log(`KV WRITE SUCCESS: ${key}`);
    return ranked.length;
  } catch(e) {
    console.error(`KV WRITE FAILED:`, e.message);
    return 0;
  }
}

export async function getCachedArticles(env, siteCode) {
  const cached = await env.PITCHOS_CACHE.get(`articles:${siteCode}`);
  return cached ? JSON.parse(cached) : [];
}

// mergeAndDedupe: lightweight in-memory dedup+sort used for building the input
// pool before cacheToKV. Does NOT apply decay — use rankAndEvict / cacheToKV for that.
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

  // Turkish vowel harmony helpers for T09 intro
  const timeSuffix = (() => {
    const [h, m] = (match.time || '19:00').split(':').map(Number);
    if (m === 30) return 'da';
    if (m === 15 || m === 45) return 'te';
    // locative suffix based on last vowel of spoken hour name
    const s = [null,'de','de','te','te','te','da','de','de','da','da','de','de','te','te','te','da','de','de','da','de','de','de'];
    return s[h] || 'da';
  })();
  const venueLocative = (() => {
    if (!match.venue) return '';
    const lv = match.venue.toLowerCase().replace(/[^aeıioöuü]/g, '').slice(-1);
    return `${match.venue}'${['e','i','ö','ü'].includes(lv) ? 'de' : 'da'}`;
  })();
  const formation = lineup.formation || '';
  const coach     = lineup.coach || '';

  // Group players by position using API-provided pos field — avoids Claude guessing positions
  const gk   = lineup.startXI.filter(p => p.pos === 'G').map(p => p.name);
  const defs = lineup.startXI.filter(p => p.pos === 'D').map(p => p.name);
  const mids = lineup.startXI.filter(p => p.pos === 'M').map(p => p.name);
  const fwds = lineup.startXI.filter(p => p.pos === 'F').map(p => p.name);
  // Fallback: any unpositioned players go into a flat list
  const positioned = [...gk, ...defs, ...mids, ...fwds];
  const unpositioned = lineup.startXI.filter(p => !['G','D','M','F'].includes(p.pos)).map(p => p.name);
  const allStarting = [...positioned, ...unpositioned];

  // Build the structured lineup block deterministically — Claude only writes prose intro
  const lineupBlock = [
    gk.length   ? `Kaleci: ${gk.join(', ')}` : null,
    defs.length ? `Savunma: ${defs.join(', ')}` : null,
    mids.length ? `Orta Saha: ${mids.join(', ')}` : null,
    fwds.length ? `Forvet: ${fwds.join(', ')}` : null,
    unpositioned.length ? `Diğer: ${unpositioned.join(', ')}` : null,
  ].filter(Boolean).join('\n');

  console.log(`TEMPLATE 09: API lineup — ${formation} — ${allStarting.join(', ')}`);

  // Fully deterministic — no Claude. Any prose generation risks hallucinating squad knowledge.
  const bench = lineup.substitutes?.map(p => p.name) || [];
  const kickoffPart = match.time ? `bugün saat ${match.time}'${timeSuffix}` : 'bugün';
  const intro = (venueLocative
    ? `Beşiktaş'ımızın ${kickoffPart} ${venueLocative} oynayacağı ${match.opponent} maçının ilk 11'i açıklandı.`
    : `Beşiktaş'ımızın ${kickoffPart} oynayacağı ${match.opponent} maçının ilk 11'i açıklandı.`)
    + (coach ? ` ${coach}, ${formation ? formation + ' dizilişini' : 'kadroyu'} tercih etti.` : '');
  const benchLine = bench.length ? `\nYedekler: ${bench.join(', ')}` : '';
  const full_body = `${intro}\n\nBeşiktaş'ın İlk 11'i (${formation}):\n${lineupBlock}${benchLine}`;

  const title   = `Beşiktaş'ın ${match.opponent} Maçı İlk 11'i Belli Oldu | ${matchDate}`;
  const summary = `${match.opponent} maçının ilk 11'i açıklandı. ${coach ? coach + ', ' : ''}${formation ? formation + ' dizilişini' : 'kadroyu'} tercih etti. ${allStarting.slice(0,5).join(', ')} ve diğerleri sahada.`.slice(0, 300);

  return {
    title,
    summary,
    full_body,
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

function youtubeThumbnailUrl(videoId) {
  if (!videoId) return '';
  return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;
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
    image_url:    youtubeThumbnailUrl(video.video_id),
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

  if (!saved?.[0]) console.error(`T-VID: Supabase write failed [${video.video_id}] — using fallback shape`);
  console.log(`T-VID: "${title.slice(0, 60)}" [${video.channel_name}]`);
  return saved?.[0] || { title, summary: intro, full_body, template_id: 'T-VID', slug,
    publish_mode: 'youtube_embed', published_at: video.published_at, source_name: video.channel_name, nvs_score: nvs,
    image_url: youtubeThumbnailUrl(video.video_id) };
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
    image_url:    youtubeThumbnailUrl(video.video_id),
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

  if (!saved?.[0]) console.error(`${cfg.template}: Supabase write failed [${video.video_id}] — using fallback shape`);
  console.log(`${cfg.template}: "${title.slice(0, 60)}" [${video.channel_name}]`);
  return saved?.[0] || { title, summary: intro, full_body, template_id: cfg.template, slug,
    publish_mode: 'youtube_embed', published_at: video.published_at, source_name: video.channel_name, nvs_score: cfg.nvs,
    image_url: youtubeThumbnailUrl(video.video_id) };
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
  const tid = site?.team_id || match?.team_id || 549;
  const bjkGoals = (allEvents || []).filter(e => e.type === 'Goal' && e.team?.id === tid && e.detail !== 'Missed Penalty');
  const oppGoals = (allEvents || []).filter(e => e.type === 'Goal' && e.team?.id !== tid && e.detail !== 'Missed Penalty');
  const bjkCards = (allEvents || []).filter(e => e.type === 'Card' && e.team?.id === tid);
  const oppCards = (allEvents || []).filter(e => e.type === 'Card' && e.team?.id !== tid);

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
  const isOurs   = cardEvent.team?.id === (site?.team_id || match?.team_id || 549);
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
  const isOurs = penEvent.team?.id === (site?.team_id || match?.team_id || 549);

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

  // Gate: combined sources must give a complete picture for the primary title's promise.
  const combinedContent = sources.map(a => `${a.title}\n${a.summary || ''}`).join('\n\n');
  const covers = await checkContentCoversTitlePromise(sources[0].title, combinedContent, env);
  if (!covers) {
    console.log(`ORIGINAL NEWS GATE FAIL: "${sources[0].title?.slice(0, 60)}" — combined sources do not cover title's promise`);
    return null;
  }

  const [editorialCtx, groundingCtx] = await Promise.all([
    getEditorialNotes(env, ['general', 'style']),
    buildGroundingContext(env, site),
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
- Ateşli bir BJK taraftarı gibi yaz — tutku, gerilim ve sezon bağlamını hissettir
- DOĞRULANMIŞ VERİLER arka plan bilgisidir: rakamları birebir aktarma, sezon bağlamını (hedefler, yarış, tehlike) haberin dokusuna işle
- Paragraflar arası boş satır bırak
- Sadece haber metnini yaz, başlık ekleme`;

  const res = await callClaude(env, MODEL_GENERATE, prompt, false, 800);
  let body = extractText(res.content).trim();
  if (!body || body.length < 600) return null;

  let needsReview = false;
  let verificationResult = null;
  const verification = await verifyArticle(body, groundingCtx, env);
  if (!verification.passed && verification.issues.length > 0) {
    console.log(`ORIGINAL NEWS VERIFY FAIL: ${verification.issues.join('; ')}`);
    try {
      const fixPrompt = prompt + `\n\nDİKKAT — aşağıdaki olgusal hatalar tespit edildi, düzelt:\n${verification.issues.join('\n')}`;
      const res2 = await callClaude(env, MODEL_GENERATE, fixPrompt, false, 800);
      const body2 = extractText(res2.content).trim();
      if (body2.length > 600) { body = body2; verificationResult = { passed: true, regenerated: true, issues: [] }; }
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
    category: 'Analiz', slug,
    url: videos.length === 1 ? `https://www.youtube.com/watch?v=${videos[0].video_id}` : 'https://www.youtube.com/c/RabonaDigital',
    source_url: '',
    image_url: '', is_p4: false, is_fresh: true, sport: 'football',
    template_id: null, fixture_id: null,
    ...(saved?.[0] ? { id: saved[0].id } : {}),
  };
}

// ─── TEMPLATE 08c — BROADCAST PITCH CARD (3D perspective) ────
// Perspective trapezoid pitch, jersey icons, SofaScore-style rating badges.
// Sidebar: BJK XI + subs + prose. Opponent shown smaller in far half.
// Fires 48–72h before kickoff. KV stores prediction for accuracy loop.


function svgE(s) {
  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function lastName(full) {
  if (!full) return '?';
  const p = full.trim().split(/\s+/);
  const last = p[p.length-1];
  return last.length > 11 ? last.slice(0,10)+'.' : last;
}
function rCol(r) {
  if (!r||r<=0) return null;
  if (r>=9)  return {bg:'#3b82f6',text:'#fff'};
  if (r>=8)  return {bg:'#16a34a',text:'#fff'};
  if (r>=7)  return {bg:'#eab308',text:'#111'};
  if (r>=6)  return {bg:'#f97316',text:'#fff'};
  return             {bg:'#dc2626',text:'#fff'};
}
const TEAM_COLS = {
  'Galatasaray':['#c8102e','#f0b519'],'Fenerbahçe':['#1a3c6e','#f5d800'],
  'Trabzonspor':['#6b1a9c','#e8282b'],'Başakşehir FK':['#002f6c','#f78f1e'],
  'Başakşehir':['#002f6c','#f78f1e'],'Rizespor':['#1e3a8a','#93c5fd'],
  'Kayserispor':['#cc0000','#f5d800'],'Sivasspor':['#cc3300','#f5d800'],
  'Konyaspor':['#006633','#ffffff'],'Antalyaspor':['#cc0000','#ffffff'],
  'Alanyaspor':['#ff6600','#ffffff'],'Adana Demirspor':['#003399','#cc0000'],
  'Kasımpaşa':['#cc0000','#ffffff'],'Samsunspor':['#cc0000','#ffffff'],
  'Ankaragücü':['#002f6c','#f5d800'],'Eyüpspor':['#cc0000','#ffffff'],
  'Göztepe':['#ff6600','#cc0000'],'Bodrum FK':['#003399','#ffffff'],
  'Hatayspor':['#cc0000','#ffffff'],
};

function buildPitchCard(bjkXI, bjkFm, oppXI, oppFm, teamName, oppName, subs, matchInfo, prose) {
  const W=500, H=440;
  const px=16, py=16;
  const fw=W-2*px, fh=H-2*py;  // 468 × 408
  const midY=H/2;               // 220

  // ── flat 2D pitch ────────────────────────────────────────────
  let pitch=`<rect width="${W}" height="${H}" fill="#0a1628"/>`;
  for(let i=0;i<10;i++)
    pitch+=`<rect x="${px}" y="${+(py+i*fh/10).toFixed(1)}" width="${fw}" height="${+(fh/10).toFixed(1)}" fill="${i%2===0?'#15803d':'#166634'}"/>`;
  pitch+=`<rect x="${px}" y="${py}" width="${fw}" height="${fh}" fill="none" stroke="rgba(255,255,255,0.65)" stroke-width="1.5" rx="2"/>`;
  pitch+=`<line x1="${px}" y1="${midY}" x2="${W-px}" y2="${midY}" stroke="rgba(255,255,255,0.55)" stroke-width="1.5"/>`;
  pitch+=`<circle cx="${W/2}" cy="${midY}" r="44" fill="none" stroke="rgba(255,255,255,0.45)" stroke-width="1.5"/>`;
  pitch+=`<circle cx="${W/2}" cy="${midY}" r="3" fill="rgba(255,255,255,0.4)"/>`;
  const bW=160, bH=50;
  pitch+=`<rect x="${(W-bW)/2}" y="${py}" width="${bW}" height="${bH}" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1"/>`;
  pitch+=`<rect x="${(W-bW)/2}" y="${H-py-bH}" width="${bW}" height="${bH}" fill="none" stroke="rgba(255,255,255,0.4)" stroke-width="1"/>`;
  pitch+=`<circle cx="${W/2}" cy="${py+66}" r="2.5" fill="rgba(255,255,255,0.35)"/>`;
  pitch+=`<circle cx="${W/2}" cy="${H-py-66}" r="2.5" fill="rgba(255,255,255,0.35)"/>`;

  // ── team logo watermarks (semi-transparent) ──────────────────
  const bjkTeamId = (site?.team_id || matchInfo?.team_id || 549);
  const bjkLogo=`https://media.api-sports.io/football/teams/${bjkTeamId}.png`;
  const oppLogo=matchInfo&&matchInfo.opponent_logo?matchInfo.opponent_logo:'';
  const lSz=80;
  pitch+=`<image href="${bjkLogo}" x="${(W-lSz)/2}" y="${Math.round((midY+(H-py))/2-lSz/2)}" width="${lSz}" height="${lSz}" opacity="0.18" preserveAspectRatio="xMidYMid meet"/>`;
  if(oppLogo) pitch+=`<image href="${svgE(oppLogo)}" x="${(W-lSz)/2}" y="${Math.round((py+midY)/2-lSz/2)}" width="${lSz}" height="${lSz}" opacity="0.18" preserveAspectRatio="xMidYMid meet"/>`;

  // ── Kartalix K icon watermark at center ──────────────────────
  const kSz=34;
  pitch+=`<g opacity="0.28" transform="translate(${W/2-kSz/2},${midY-kSz/2}) scale(${(kSz/64).toFixed(4)})"><rect x="8" y="4" width="12" height="56" fill="#fff"/><polygon points="20,32 56,4 46,4 20,22" fill="#fff"/><polygon points="20,32 58,60 68,60 20,36" fill="#E30A17"/><rect x="8" y="29" width="12" height="7" fill="#E30A17"/></g>`;

  // ── formation-aware row grouper ──────────────────────────────
  function byRow(players){
    const rows={};
    for(const p of(players||[])){
      const parts=(p.grid||'').split(':').map(Number);
      const validRow=parts.length>=2&&!isNaN(parts[0])&&parts[0]>0;
      const validCol=parts.length>=2&&!isNaN(parts[1])&&parts[1]>0;
      let row,col;
      if(validRow){
        row=parts[0];col=validCol?parts[1]:((rows[row]?rows[row].length:0)+1);
      } else {
        const posMap={G:1,D:2,M:3,F:4};
        row=posMap[(p.pos||'M').charAt(0).toUpperCase()]||3;
        col=(rows[row]?rows[row].length:0)+1;
      }
      if(!rows[row]) rows[row]=[];
      rows[row].push(Object.assign({},p,{_r:row,_c:col}));
    }
    return rows;
  }

  // ── player node: circle, name overlaid (overflows edges = "on circle"), rating pill below ─
  const R=11;
  function pNode(x,y,fill,stroke,name,rating){
    const nm=lastName(name);
    const shortNm=nm.length>7?nm.slice(0,6):nm;
    let o=`<circle cx="${x}" cy="${y}" r="${R}" fill="${fill}" stroke="${stroke}" stroke-width="1.5"/>`;
    o+=`<text x="${x}" y="${y+3}" text-anchor="middle" fill="#fff" font-size="8" font-weight="700" font-family="system-ui,sans-serif" paint-order="stroke" stroke="${fill}" stroke-width="1.5" stroke-linejoin="round">${svgE(shortNm)}</text>`;
    if(rating&&Number(rating)>0){
      const c=rCol(Number(rating));
      if(c){
        const ry=y+R+8;
        o+=`<rect x="${x-10}" y="${ry-6}" width="20" height="11" rx="5.5" fill="${c.bg}"/>`;
        o+=`<text x="${x}" y="${ry+2}" text-anchor="middle" fill="${c.text}" font-size="7" font-weight="700" font-family="system-ui,sans-serif">${Number(rating).toFixed(1)}</text>`;
      }
    }
    return o;
  }

  const oc=TEAM_COLS[oppName]||['#7f1d1d','#fca5a5'];

  function renderBJK(players){
    const rows=byRow(players),nums=Object.keys(rows).map(Number).sort(function(a,b){return a-b;}),n=nums.length;
    const gap=n>1?Math.round((fh/2-40)/Math.max(n-1,1)):0;
    let out='';
    nums.forEach(function(rn,i){
      const rp=rows[rn].sort(function(a,b){return a._c-b._c;});
      const y=H-py-18-i*gap;
      rp.forEach(function(pl,j){
        const x=Math.round(px+20+(j+1)*(fw-40)/(rp.length+1));
        out+=pNode(x,y,'#1e3a5f','#93c5fd',pl.name,pl.rating);
      });
    });
    return out;
  }

  function renderOpp(players){
    if(!players||!players.length) return '';
    const rows=byRow(players),nums=Object.keys(rows).map(Number).sort(function(a,b){return a-b;}),n=nums.length;
    const gap=n>1?Math.round((fh/2-40)/Math.max(n-1,1)):0;
    let out='';
    nums.forEach(function(rn,i){
      const rp=rows[rn].sort(function(a,b){return a._c-b._c;});
      const y=py+18+i*gap;
      rp.forEach(function(pl,j){
        const x=Math.round(px+20+(j+1)*(fw-40)/(rp.length+1));
        out+=pNode(x,y,oc[0],oc[1],pl.name,null);
      });
    });
    return out;
  }

  const m11Lbl=`<text x="${W/2}" y="${H-py-4}" text-anchor="middle" fill="rgba(255,255,255,0.5)" font-size="10" font-weight="700" letter-spacing="0.1em" font-family="system-ui,sans-serif">MUHTEMEL 11 — ${svgE(bjkFm||'')}</text>`;
  const oppFmLbl=oppFm?`<text x="${W/2}" y="${py+10}" text-anchor="middle" fill="rgba(255,255,255,0.38)" font-size="9">${svgE(oppName)} ${svgE(oppFm)}</text>`:'';
  const bjkSvg=renderBJK(bjkXI);
  const oppSvg=renderOpp(oppXI||[]);
  const svgEl=`<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;display:block;border-radius:8px 8px 0 0" preserveAspectRatio="xMidYMid meet">
${pitch}${bjkSvg}${oppSvg}${m11Lbl}${oppFmLbl}</svg>`;

  function sidRow(p,dim){
    const r=p.rating?Number(p.rating):null,c=r!==null?rCol(r):null;
    const rep=p.isReplacement?'<span style="color:#f59e0b;font-size:9px;margin-left:2px">⇅</span>':'';
    const bdg=c?`<span style="background:${c.bg};color:${c.text};border-radius:8px;padding:1px 5px;font-size:10px;font-weight:700;min-width:30px;text-align:center;display:inline-block;flex-shrink:0">${r.toFixed(1)}</span>`:'<span style="min-width:30px;display:inline-block;flex-shrink:0"></span>';
    return `<div style="display:flex;align-items:center;gap:5px;padding:3px 0;border-bottom:1px solid rgba(255,255,255,0.05)">${bdg}<span style="color:${dim?'#9ca3af':'#f1f5f9'};font-size:${dim?'0.72':'0.8'}rem;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${svgE(p.name)}${rep}</span></div>`;
  }
  const proseHtml=(prose||'').split(/\n+/).filter(function(l){return l.trim().length>5;})
    .map(function(l){return`<p style="margin:0 0 0.8rem;line-height:1.7;font-size:0.92rem">${svgE(l.trim())}</p>`;}).join('');
  const mdStr=matchInfo&&matchInfo.date?new Date(matchInfo.date).toLocaleDateString('tr-TR',{day:'numeric',month:'long'}):'';

  const header=`<div style="background:linear-gradient(135deg,#1a1a2e,#16213e);padding:0.9rem 1.25rem;border-bottom:2px solid #E30A17;display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:0.5rem"><div style="display:flex;align-items:center;gap:0.6rem"><svg width="26" height="26" viewBox="0 0 26 26" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0"><path d="M13 1 L24 6 L24 15 Q24 22 13 25 Q2 22 2 15 L2 6 Z" fill="#E30A17"/><text x="13" y="18" text-anchor="middle" fill="#fff" font-size="12" font-weight="900" font-family="system-ui,sans-serif">K</text></svg><div><div style="color:#f1f5f9;font-weight:700;font-size:1rem">${svgE(teamName)} <span style="color:#9ca3af;font-weight:400">—</span> ${svgE(oppName)}</div><div style="color:#6b7280;font-size:0.72rem;margin-top:2px">${mdStr}${matchInfo&&matchInfo.time?' · '+matchInfo.time:''} · ${svgE(bjkFm||'')} · Kartalix Muhtemel 11</div></div></div><span style="background:rgba(227,10,23,0.15);border:1px solid rgba(227,10,23,0.35);color:#f87171;font-size:0.6rem;font-weight:700;padding:2px 7px;border-radius:4px;letter-spacing:0.03em;white-space:nowrap">Muhtemel 11</span></div>`;

  const playerStrip=`<div style="background:#111827;padding:0.75rem 1rem 0.6rem;border-top:1px solid rgba(255,255,255,0.06)"><div style="display:flex;gap:1.5rem;flex-wrap:wrap;align-items:flex-start"><div style="flex:1;min-width:200px"><div style="color:#E30A17;font-weight:700;font-size:0.65rem;letter-spacing:0.08em;margin-bottom:0.4rem;text-transform:uppercase">İlk 11 — ${svgE(bjkFm||'')}</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:0 0.75rem">${bjkXI.map(function(p){return sidRow(p,false);}).join('')}</div><div style="margin-top:0.4rem;font-size:0.62rem;color:#4b5563">Futbolcu performans skorları son maçtan alınmıştır.</div></div><div style="min-width:140px"><div style="color:#4b5563;font-size:0.62rem;font-weight:700;letter-spacing:0.08em;margin-bottom:0.4rem;text-transform:uppercase">Yedekler</div>${(subs||[]).slice(0,7).map(function(p){return sidRow(p,true);}).join('')}</div></div></div>`;

  return `<div style="max-width:900px;margin:1.5rem auto;background:#0f1117;border-radius:12px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.6);font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif">${header}<div style="overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:520px;margin:0 auto">${svgEl}</div>${playerStrip}</div>${proseHtml?`<div style="max-width:900px;margin:0 auto 1.5rem;padding:0.8rem 0.25rem 0;font-family:system-ui,-apple-system,BlinkMacSystemFont,sans-serif">${proseHtml}</div>`:''}`;
}

export async function generateLineupCard(match, bjkLastLineup, oppLastLineup, injuries, predictionHistory, site, env) {
  if (!bjkLastLineup || bjkLastLineup.startXI.length < 8) {
    console.log('T08c: no BJK last lineup data, skipping'); return null;
  }
  const injuredSet = new Set((injuries||[]).map(function(i){return i.name.toLowerCase();}));
  const kept     = bjkLastLineup.startXI.filter(function(p){return !injuredSet.has(p.name.toLowerCase());});
  const excluded = bjkLastLineup.startXI.filter(function(p){return  injuredSet.has(p.name.toLowerCase());});
  const subPool  = (bjkLastLineup.substitutes||[])
    .filter(function(p){return !injuredSet.has(p.name.toLowerCase());})
    .sort(function(a,b){return (b.rating||0)-(a.rating||0);});
  const usedSubs = new Set();
  const replacements = excluded.map(function(out){
    const pg=(out.pos||'M').charAt(0).toUpperCase();
    const sub=subPool.find(function(s){return !usedSubs.has(s.name)&&(s.pos||'M').charAt(0).toUpperCase()===pg;})
            ||subPool.find(function(s){return !usedSubs.has(s.name);});
    if(!sub) return null;
    usedSubs.add(sub.name);
    return Object.assign({},sub,{isReplacement:true,grid:out.grid});
  }).filter(Boolean);
  const predictedXI=[...kept,...replacements];
  // Pad to 11 if position-matched subs couldn't fill all injured slots
  while(predictedXI.length<11){
    const next=subPool.find(function(s){return !usedSubs.has(s.name);});
    if(!next)break;
    usedSubs.add(next.name);
    predictedXI.push(Object.assign({},next,{isReplacement:true}));
  }
  if(predictedXI.length<8){console.log('T08c: not enough players, skipping');return null;}
  const displaySubs=subPool.filter(function(s){return !usedSubs.has(s.name);}).slice(0,7);

  const histLine=predictionHistory&&predictionHistory.length
    ?`Son ${predictionHistory.length} tahminimizde ortalama ${(predictionHistory.reduce(function(s,h){return s+(h.correct_count||0);},0)/predictionHistory.length).toFixed(1)}/11 dogruluk.`:'';
  const excludedLine=excluded.length?`Eksik: ${excluded.map(function(p){return p.name;}).join(', ')}`:'';
  const replLine=replacements.length?`Degisiklik: ${replacements.map(function(r){return r.name;}).join(', ')}`:'';

  const t08cNotes=await getEditorialNotes(env,['match','T08c']);
  const prosePrompt=`${t08cNotes}Sen Kartalix editörüsün. Beşiktaş'ın ${match.opponent} maçı için tahmini 11 haberi yaz.
MAÇ: Beşiktaş ${match.home?'(Ev)':'(Deplasman)'} - ${match.opponent} | ${match.date} ${match.time} | ${match.league}
DİZİLİŞ: ${bjkLastLineup.formation||'?'} | KADRO: ${predictedXI.map(function(p){return p.name;}).join(', ')}
${excludedLine} ${replLine} ${histLine}
2 paragraf ~100 kelime. Sadece ${match.opponent} maçı için tahmin ve hangi pozisyonlar soru işareti. Geçen maçın skorunu veya istatistiklerini ekleme. "Resmi kadro açıklaması maçtan yaklaşık 1 saat önce yapılacaktır." ile bitir. Emoji/başlık yok.`;

  let prose='';
  try{
    const res=await callClaude(env,'claude-haiku-4-5-20251001',prosePrompt,false,500);
    prose=extractText(res.content).trim();
  }catch(e){console.error('T08c prose failed:',e.message);}
  if(!prose) prose=`Beşiktaş'ın ${match.opponent} maçı için geçen haftanın kadrosu baz alınarak tahmini 11 oluşturuldu.${excludedLine?' '+excludedLine+'.':''}\n\nResmi kadro açıklaması maçtan yaklaşık 1 saat önce yapılacaktır.`;

  const full_body=buildPitchCard(predictedXI,bjkLastLineup.formation,
    oppLastLineup?oppLastLineup.startXI:[],oppLastLineup?oppLastLineup.formation:null,
    'Beşiktaş',match.opponent,displaySubs,match,prose);

  const matchDate=new Date(match.date).toLocaleDateString('tr-TR',{day:'numeric',month:'long',year:'numeric'});
  const title=`Beşiktaş - ${match.opponent} Muhtemel 11 | ${matchDate}`;
  const summary=`Geçen haftanın kadrosuna dayalı Beşiktaş tahmini: ${predictedXI.slice(0,5).map(function(p){return p.name;}).join(', ')} ve diğerleri.`.slice(0,300);
  const slug=generateSlug(title,match.kickoff_iso||(match.date+'T10:00:00Z'));

  const saved=await supabase(env,'POST','/rest/v1/content_items',{
    site_id:site?.id,source_type:'kartalix',source_name:'Kartalix',original_url:'',
    title,summary,full_body,category:'Match',content_type:'kartalix_generated',sport:'football',
    nvs_score:75,publish_mode:'template_lineup',status:'published',
    template_id:'T08c',slug,
    published_at:new Date().toISOString(),reviewed_at:new Date().toISOString(),reviewed_by:'auto',
  },{'Prefer':'resolution=merge-duplicates,return=representation'});

  console.log(`T08c: "${title.slice(0,60)}" — ${predictedXI.length} players, ${excluded.length} excluded`);
  const base=saved?saved[0]||null:null;
  const ret=base?Object.assign({},base):Object.assign({},{title,summary,full_body,template_id:'T08c',slug,publish_mode:'template_lineup',published_at:new Date().toISOString()});
  return Object.assign({},ret,{predicted_players:predictedXI.map(function(p){return p.name;}),formation:bjkLastLineup.formation});
}
