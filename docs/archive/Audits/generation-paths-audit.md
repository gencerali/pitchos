# Generation Paths and Fact Handling Audit

**Date**: 2026-05-17  
**Source files read**: `src/publisher.js`, `src/story-matcher.js`, `src/firewall.js`, `src/utils.js`  
**Purpose**: Inventory of all generation paths and fact handling. No changes proposed.

---

## Model constants (from `src/utils.js` lines 2–5)

| Constant | Value |
|---|---|
| `MODEL_FETCH` | `claude-haiku-4-5-20251001` |
| `MODEL_GENERATE` | `claude-sonnet-4-6` |

---

## Section 1 — Generation Paths Inventory

---

### Path 1 — Rewrite (single-source, NVS≥50)

**Function**: `synthesizeArticle` (`src/publisher.js` lines 372–494)  
**Triggered from**: `writeArticles` else-block (lines 540–567) when `(article.nvs || 0) >= 50` and `publish_mode` is not `template_official`, `template_transfer`, or `embed`  
**Publish mode**: `rewrite`  
**Model**: `MODEL_GENERATE` = `claude-sonnet-4-6`  
**Max tokens**: 1000 (line 447)

**System prompt**: None. All instructions in the user message.

**User prompt verbatim** (lines 432–445):
```
Sen Kartalix'in Beşiktaş spor editörüsün. Aşağıdaki kaynak metinden özgün bir Kartalix haberi yaz.

Kaynak başlık: ${article.title}
${isOfficial ? `Kaynak metin: ${sourceText}\n${sourceLabel}` : sourceLabel}${entityBlock}${editorialCtx}${groundingCtx}

Kurallar:
- 250-400 kelime, Türkçe
- Ateşli bir BJK taraftarı gibi yaz — duygusal bağ kur, heyecan ve gerilimi yansıt
- İLK CÜMLE: KİŞİLER ve OLAY bilgisini içermeli — kim, ne yaptı/oldu net şekilde belirt
- "...kaynağına göre" veya "...iddia ediyor" gibi ifadeler kullanma — bilgiyi doğrudan sun
- DOĞRULANMIŞ VERİLER arka plan bilgisidir: rakamları aynen aktarma, sezon bağlamını habere doğal şekilde dokut
- Kaynak metinde tırnak içinde doğrudan alıntı varsa, o alıntıları kelimesi kelimesine koru — asla parafraz yapma
- Paragraflar arası boş satır bırak
- Sadece haber metnini yaz, başlık ekleme
```

Where `sourceLabel` = full `sourceText` string (up to 10,000 chars); `entityBlock` = `extractKeyEntities` output (see Q12 below); `editorialCtx` = `getEditorialNotes(env, ['general', 'style'])`; `groundingCtx` = `buildGroundingContext(env, site)`.

For official sources: `sourceLabel` becomes `Kaynak: Beşiktaş JK resmi açıklaması — bu bilgi kesindir, "iddia" veya "kaynağına göre" çerçevesi yasak.`

**Voice / style instructions**: `Ateşli bir BJK taraftarı gibi yaz — duygusal bağ kur, heyecan ve gerilimi yansıt` + editorial notes from KV.

**Output format constraints**: No title, paragraphs with blank lines between them, Turkish, 250–400 words.

**Post-processing applied** (in order):
1. Proxy source fetch (lines 376–408): `pitchos-proxy.onrender.com` with /health wake-up + 2 retry attempts; if no text returned, path aborts and article stays `rss_summary`.
2. `checkContentCoversTitlePromise` gate (line 411–415): Haiku EVET/HAYIR call. Aborts if source doesn't deliver on title's promise.
3. Refusal detection — `REFUSAL_SIGNALS` list of 11 phrases (lines 453–470). Returns `{ body: null }` if matched.
4. Parallel: `generateKartalixTitle(body, article.title, env)` (line 472–473) + `verifyArticle(body, groundingCtx, env)` (line 474).
5. `verifyArticle` (lines 167–190): Haiku call comparing factual claims against DOĞRULANMIŞ VERİLER. Fails open (returns `passed:true`) if no grounding data present.
6. On verify failure: one Sonnet retry with issues appended to prompt; if retry body < 200 chars, flags `needs_review: true`.
7. In `saveArticles`: body length < 600 chars blocks save (line 616). Cross-run dedup via Supabase query (lines 626–648).
8. **Cap**: 6 rewrites per cron run (line 541). Overflow queued to `rewrite:queue:BJK` KV.

**Estimated articles/day**: Unknown — requires inspection of fetch_logs. Cap is 6 per cron run × N cron runs; current cron is hourly. Drain queue adds up to 8 more. Practical ceiling ~14/day but depends on NVS distribution of fetched articles.

---

### Path 2 — SYNTH-D2: Multi-Source Story Synthesis (H5, ≥3 independent sources)

**Function**: `synthesizeStory` (`src/story-matcher.js` lines 362–526)  
**Triggered from**: `matchOrCreateStory` (line 583) when story state is `confirmed` or `active` and `contribution_count >= 3`. Called async (non-blocking).  
**Publish mode**: `synthesis`  
**Model**: `MODEL_GENERATE` = `claude-sonnet-4-6`  
**Max tokens**: 1800 (line 476)

**System prompt**: None.

**User prompt verbatim** (lines 450–471):
```
${editorialNotes}Sen Kartalix'in kıdemli spor editörüsün. Aşağıda aynı hikayeyi ele alan ${validSources.length} BAĞIMSIZ kaynak var. Her biri farklı bir bakış açısından yazılmış.

GÖREV: Bu kaynakların HİÇBİRİNİN YAZDIGI GİBİ YAZMAYAN, tamamen bağımsız bir Kartalix haberi yaz. Kaynaklar sana bağlam sağlar ama sen kendi Kartalix açından yaz.

BAĞLAM:
${storyContext}

KAYNAKLAR:
${sourceBlocks}

YAZIM KURALLARI:
- Önce Türkçe bir manşet yaz, sonra haber gövdesini yaz
- Çıktı formatı — tam olarak bu şekilde:
BAŞLIK: [Türkçe manşet buraya]

[haber gövdesi buraya]
- 350–500 kelime, güçlü Kartalix sesi
- Lede: en önemli bilgiyi ilk cümlede ver, doğrudan ve çarpıcı
- Kaynakların çerçevesinden bağımsız kendi Kartalix açını bul
- Rakam ve tarih bilgilerini doğru kullan, yorumlarda özgün ol
- "Kaynağa göre", "habere göre" gibi referans ifadeleri KULLANMA
- Emoji yok
```

Where `editorialNotes` = `getEditorialNotes(env, ['news', story.story_type || ''])`; `storyContext` = `story.story_type` + `story.title` (2 lines); `sourceBlocks` = up to 5 source bodies each prefixed `=== KAYNAK N: title ===`, each body truncated to 3000 chars.

**Voice / style instructions**: `güçlü Kartalix sesi` + editorial notes from KV.

**Output format constraints**: Must begin with `BAŞLIK: [headline]`, blank line, then body. 350–500 words.

**Post-processing applied**:
1. Body length < 200 chars → returns null (line 492).
2. KV dedup key `synth:{story.id}:{date}` — one synthesis per story per calendar day (lines 365–368, 517).
3. Title parsed from `BAŞLIK:` prefix (lines 479–484); body is everything after that line.
4. No `generateKartalixTitle` call. Title is whatever Claude generates.
5. No `verifyArticle` call. No grounding context injected.

**Estimated articles/day**: Unknown — requires inspection. Fires only for stories with ≥3 distinct contributions from `story_contributions`. Async fire; may silently fail if sources can't be fetched.

---

### Path 3 — Story-System Single-Source Synthesis (story reaches 'confirmed')

**Function**: `generateStoryArticle` (`src/story-matcher.js` lines 253–355)  
**Triggered from**: `matchOrCreateStory` (lines 549–551, 578–580) when a story transitions to `confirmed` state for the first time.  
**Publish mode**: `synthesis_generated`  
**Model**: `MODEL_GENERATE` = `claude-sonnet-4-6`  
**Max tokens**: 1500 (line 302)

**System prompt**: None.

**User prompt verbatim** (lines 279–298):
```
${editorialNotes}Sen Kartalix'in kıdemli spor editörüsün. Beşiktaş ile ilgili aşağıdaki kaynak haberi oku ve özgün bir Kartalix haberi yaz.

DOĞRULANMIŞ BİLGİLER:
${factLines || '(bağlam aşağıdaki kaynaktan çıkarılacak)'}

KAYNAK HABER:
Başlık: ${article.title || story.title || ''}
${sourceText.slice(0, 4000)}

YAZIM KURALLARI:
- 300–500 kelime, profesyonel Türkçe haber üslubu
- İlk paragraf (lede): kim, ne, nerede, ne zaman — en önemli bilgiyi öne al
- 2–3 gelişme paragrafı: detaylar, rakamlar, bağlam, arka plan
- Son paragraf: bu haberden sonra ne bekleniyor, süreç nasıl ilerleyecek
- Tamamen özgün cümleler kur — kaynaktan kopyalama
- "Kaynaklara göre", "habere göre", "bir kaynaktan öğrenildiğine göre" gibi ifadeler KULLANMA
- Haberi Kartalix'in kendi haberi gibi yaz, referans verme
- Emoji kullanma, başlık yazma — sadece haber gövdesini yaz
```

Where `editorialNotes` = `getEditorialNotes(env, ['news', story.story_type || ''])`; `factLines` = structured facts extracted earlier (see Q12); `sourceText` = Readability-fetched full text of triggering article (no explicit char limit in fetch, truncated to 4000 in prompt).

**Voice / style instructions**: `profesyonel Türkçe haber üslubu` + editorial notes.

**Output format constraints**: Body only, no title, 300–500 words.

**Post-processing applied**:
1. Empty body check → graceful fallback to `sourceText.slice(0, 600) || article.title`.
2. Fixed NVS score: 75. Fixed `nvs_score` on saved row.
3. Story advanced to `active` state after save.
4. No `generateKartalixTitle` call. Title comes from `story.title || article.title` (line 315) — original story title or RSS title, not generated.
5. No `verifyArticle` call.

**Estimated articles/day**: Unknown — requires inspection. Fires only when a story's confidence first crosses 60 with at least one quality source (`official` or `broadcast` trust tier).

---

### Path 4 — Transfer Firewall (template_transfer, NVS≥70)

**Function**: `extractFacts` → `writeTransfer` (`src/firewall.js` lines 131–348)  
**Triggered from**: `writeArticles` (line 511–522) when `decidePublishMode` returns `template_transfer` (category=transfer AND nvs≥70).  
**Publish mode**: `template_transfer`  
**Model**: `MODEL_FETCH` = `claude-haiku-4-5-20251001` for both extraction (line 137) and generation (line 339)  
**Max tokens**: 500 (extraction), 400 (generation)

**System prompt**: None.

**Extraction prompt** (`buildExtractionPrompt`, lines 77–103):  
Returns structured JSON only: `entities.{players, clubs, competitions}`, `numbers.{transfer_fee, contract_years, release_clause, other[]}`, `dates.{announcement, contract_end, transfer_window, other[]}`.

**Generation prompt verbatim** (lines 330–337):
```
Beşiktaş transfer haberini aşağıdaki gerçekleri kullanarak yaz. Sadece verilen bilgileri kullan — hiçbir şey ekleme, yorumlama veya tahmin etme.

Gerçekler:
${factLines}

2-3 cümle, tarafsız haber üslubu. Türkçe yaz.
İlk satır: haber başlığı (tire veya tırnak işareti kullanma).
Geri kalan satırlar: haber metni.
```

`factLines` = player, club1, club2, transfer_fee, contract_years, release_clause, announcement date, transfer_window, competitions — text lines only.

**Voice / style instructions**: `tarafsız haber üslubu`. No editorial notes, no grounding.

**Output format constraints**: 2–3 sentences. First line is the article title. Remaining lines are the body.

**Post-processing applied**: None beyond error catch (lines 512–521). On failure, falls back to `rss_summary`.

**KEY DESIGN NOTE**: This path intentionally never sees source text. The LLM receives only extracted structured facts. Source text is discarded after extraction. This is by design for copyright reasons (FSEK Article 36 — comment at line 72: "Entities are facts; expression is what FSEK Article 36 protects").

**Estimated articles/day**: Unknown — requires inspection. Fires on high-NVS transfer articles. Likely very low volume (0–3/day).

---

### Path 5 — Official Announcement Wrapper (template_official)

**Function**: Inline in `writeArticles` (`src/publisher.js` lines 505–509)  
**Triggered from**: `decidePublishMode` when `trust === 'official'` (line 134)  
**Publish mode**: `template_official`  
**Model**: None — no LLM call  

**Processing**: RSS summary cleaned via `cleanRSS()` (line 507–508). Strips HTML tags, BJK boilerplate, source domain suffixes, cuts at 300 chars. Full body = cleaned summary. Title unchanged from RSS.

**Post-processing**: None. No synthesis. No fact extraction. Content published as-is.

**Estimated articles/day**: Unknown — requires inspection. Fires on bjk.com.tr official announcements only.

---

### Path 6 — Original News Synthesis (multi-source RSS summaries)

**Function**: `generateOriginalNews` (`src/publisher.js` lines 2446–2558)  
**Triggered from**: background work loop (not via `writeArticles`). Receives 1–3 related P4 articles as sources.  
**Publish mode**: `original_synthesis`  
**Model**: `MODEL_GENERATE` = `claude-sonnet-4-6`  
**Max tokens**: 800 (line 2499)

**System prompt**: None.

**User prompt verbatim** (lines 2485–2497):
```
Sen Kartalix'in Beşiktaş spor editörüsün. Aşağıdaki kaynak bilgilerden yola çıkarak tamamen özgün bir Kartalix haberi yaz.${editorialCtx}${sportCtx}${groundingCtx}

${sourceBlocks}

KURALLAR:
- 300–400 kelime, Türkçe
- Hiçbir kaynağa atıf yapma — "kaynağına göre", "iddia ediyor", "bildirildi" gibi ifadeler yasak
- Bilgiyi Kartalix'in kendi sesi olarak doğrudan sun
- Haber cümlesiyle başla (kim, ne, ne zaman)
- Ateşli bir BJK taraftarı gibi yaz — tutku, gerilim ve sezon bağlamını hissettir
- DOĞRULANMIŞ VERİLER arka plan bilgisidir: rakamları birebir aktarma, sezon bağlamını (hedefler, yarış, tehlike) haberin dokusuna işle
- Paragraflar arası boş satır bırak
- Sadece haber metnini yaz, başlık ekleme
```

Where `sourceBlocks` = `[Kaynak N] Başlık: ${a.title}\n${(a.summary || '').slice(0, 600)}` for each source (line 2450–2452). **RSS summary only, truncated at 600 chars per source. No full-text fetch.**

**Voice / style instructions**: `Ateşli bir BJK taraftarı gibi yaz` + editorial notes + optional national-team or other-sport context injection.

**Output format constraints**: Body only, no title, 300–400 words.

**Post-processing applied**:
1. `checkContentCoversTitlePromise` gate on combined source titles + summaries (line 2456).
2. Body < 600 chars → returns null (line 2501).
3. `verifyArticle` + one Sonnet retry on failure (lines 2505–2514).
4. Title comes from `sources[0].title` (line 2519) — primary source RSS title verbatim. **No `generateKartalixTitle` call.** This path was not updated in the title-generation work (see DECISIONS.md 2026-05-18).

**Estimated articles/day**: Unknown — requires inspection. Fires in background work loop for top P4 articles (NVS≥55), cap 3 per run.

---

### Path 7 — Video Embed (T-VID, T-VID-HLT, T-VID-GOL, etc.)

**Function**: `generateVideoEmbed` (publisher.js lines 2081–2123) and `generateMatchVideoEmbed` (lines 2129–2193)  
**Triggered from**: `writeArticles` (line 524–531) when `article.treatment === 'embed'`  
**Publish mode**: `youtube_embed` / `youtube_highlights` etc.  
**Model**: Hardcoded `claude-haiku-4-5-20251001` (not `MODEL_FETCH` alias — lines 2089, 2158)  
**Max tokens**: 100 (generic T-VID, line 2089), 150 (match video types, line 2158)

**User prompt**: Single sentence. Inputs are video title and channel name only. No article body, no source text.

**Output format constraints**: One Turkish sentence intro. Full body = `<p>intro</p>` + YouTube iframe HTML.

**Post-processing**: None beyond empty check. Title taken directly from YouTube video title. No `generateKartalixTitle` call.

**Estimated articles/day**: Unknown — depends on YouTube fetch schedule.

---

### Path 8 — T01 Match Preview

**Function**: `generateMatchPreview` (publisher.js lines 1458–1531)  
**Publish mode**: `template_preview` | **Template ID**: `T01`  
**Model**: `MODEL_GENERATE` | **Max tokens**: 1500  
**Inputs**: fixture data, last-5 H2H array, weather (Open-Meteo), standings — all from APIs  
**Title**: Rule-based: `${home} - ${away} Maç Önü`  
**Estimated articles/day**: ~1 per match (fires 0–48h before kickoff)

---

### Path 9 — T02 H2H History

**Function**: `generateH2HHistory` (publisher.js lines 1697–1767)  
**Publish mode**: `template_h2h` | **Template ID**: `T02`  
**Model**: `MODEL_GENERATE` | **Max tokens**: 1200  
**Inputs**: fixture data, up to 10 past H2H results (API-Football)  
**Title**: Rule-based: `Beşiktaş - ${opponent} Rekabeti: Tarihsel Rakamlar`  
**Estimated articles/day**: ~1 per match (fires 24–72h pre-match)

---

### Path 10 — T03 Form Guide

**Function**: `generateFormGuide` (publisher.js lines 1536–1609)  
**Publish mode**: `template_form` | **Template ID**: `T03`  
**Model**: `MODEL_GENERATE` | **Max tokens**: 1200  
**Inputs**: fixture data, last 5 results (API), standings  
**Title**: Rule-based: `Beşiktaş'ın Formu: ${formString} — ${opponent} Maçı Öncesi`  
**Estimated articles/day**: ~1 per match (fires 48–72h pre-match)

---

### Path 11 — T05 Match Day Card

**Function**: `generateMatchDayCard` (publisher.js lines 1074–1162)  
**Publish mode**: `match_day_template` | **Template ID**: `T05` (stored as `'05'`)  
**Model**: Hardcoded `claude-haiku-4-5-20251001` (line 1124) | **Max tokens**: 600  
**Inputs**: fixture data, injuries (API-Football), weather (Open-Meteo)  
**Title**: Rule-based: `Beşiktaş - ${opponent} Maç Önizlemesi | ${matchDate}, ${week}. Hafta`  
**Note**: Match day card is not saved to Supabase via `saveArticles` — it returns an in-memory object that is pushed directly into KV. It has no `id`.  
**Estimated articles/day**: ~1 per match day

---

### Path 12 — T07 Injury & Suspension Report

**Function**: `generateInjuryReport` (publisher.js lines 1614–1692)  
**Publish mode**: `template_injury_report` | **Template ID**: `T07`  
**Model**: `MODEL_GENERATE` | **Max tokens**: 1000  
**Inputs**: fixture data, injuries/suspensions (API-Football), recent cached article titles filtered by injury keywords  
**Title**: Rule-based: `${opponent} Maçı Öncesi ${N} Eksik` or `...Sakatlık ve Ceza Durumu`  
**Estimated articles/day**: ~1 per match (fires 24–48h pre-match)

---

### Path 13 — T10 Goal Flash

**Function**: `generateGoalFlash` (publisher.js lines 1772–1828)  
**Publish mode**: `template_goal_flash` | **Template ID**: `T10`  
**Model**: `MODEL_FETCH` = `claude-haiku-4-5-20251001` | **Max tokens**: 400  
**Inputs**: match score, goal event (player, minute, type from API-Football live events)  
**Title**: Rule-based: `${minute}' GOL: ${scorer}! Beşiktaş ${score} ${opponent}`  
**Estimated articles/day**: 0–6 on match days (one per goal)

---

### Path 14 — T11 Result Flash

**Function**: `generateResultFlash` (publisher.js lines 1834–1907)  
**Publish mode**: `template_result` | **Template ID**: `T11`  
**Model**: `MODEL_GENERATE` | **Max tokens**: 1500  
**Inputs**: final fixture data, top-3 rated players (API-Football), match events array  
**Title**: Rule-based: `Beşiktaş ${score} ${opponent} | Maç Sonucu`  
**Estimated articles/day**: ~1 on match days

---

### Path 15 — T12 Match Report

**Function**: `generateMatchReport` (publisher.js lines 1988–2076)  
**Publish mode**: `template_match_report` | **Template ID**: `T12`  
**Model**: `MODEL_GENERATE` | **Max tokens**: 1800  
**Inputs**: final fixture, top-5 rated players, match stats (xG, possession, shots, passes, corners, cards), match events  
**Title**: Rule-based: `Maç Raporu: ${scoreline}`  
**Estimated articles/day**: ~1 on match days

---

### Path 16 — T13 Man of the Match

**Function**: `generateManOfTheMatch` (publisher.js lines 1913–1982)  
**Publish mode**: `template_motm` | **Template ID**: `T13`  
**Model**: `MODEL_GENERATE` | **Max tokens**: 1000  
**Inputs**: final fixture, top-3 rated players sorted by rating descending  
**Guard**: requires ≥3 rated players; top player rating must be ≥ 6.0  
**Title**: Rule-based: `${player} ${resultTag}: ${scoreline}`  
**Estimated articles/day**: ~1 on match days (may be null if data unavailable)

---

### Path 17 — T-REF Referee Profile

**Function**: `generateRefereeProfile` (publisher.js lines 1393–1453)  
**Publish mode**: `template_referee` | **Template ID**: `T-REF`  
**Model**: `MODEL_GENERATE` | **Max tokens**: 700  
**Inputs**: fixture data, referee name, BJK disciplinary stats under this referee (W/D/L, yellow cards, red cards — computed from recent fixtures)  
**Title**: Rule-based: `${opponent} Maçının Hakemi: ${referee}`  
**Estimated articles/day**: ~1 per match (fires 24–48h pre-match)

---

### Path 18 — T-XG Delta

**Function**: `generateXGDelta` (publisher.js lines 2198–2268)  
**Publish mode**: `template_xg_delta` | **Template ID**: `T-XG`  
**Model**: `MODEL_GENERATE` | **Max tokens**: 900  
**Guard**: only fires when `|BJK goals − xG| > 1.2` (line 2203)  
**Inputs**: final fixture, match stats (xG, shots, possession)  
**Title**: Rule-based: `xG Analizi: Beşiktaş Beklentinin ${Üstünde/Altında} — ${scoreline}`  
**Estimated articles/day**: 0–1 per match (conditional on xG delta)

---

### Path 19 — T-HT Halftime Report

**Function**: `generateHalftimeReport` (publisher.js lines 2270–2310 approx.)  
**Publish mode**: `template_halftime` | **Template ID**: `T-HT`  
**Model**: `MODEL_FETCH` = `claude-haiku-4-5-20251001` | **Max tokens**: 500  
**Inputs**: live fixture score, first-half events (goals, cards by team) from live API events  
**Title**: Rule-based based on HT score  
**Estimated articles/day**: ~1 on match days

---

### Path 20 — T-RED Red Card Flash, T-VAR VAR Flash, T-OG Own Goal Flash, T-PEN Missed Penalty Flash

**Functions**: `generateRedCardFlash`, `generateVARFlash`, `generateOwnGoalFlash`, `generateMissedPenaltyFlash`  
**Publish modes**: `template_red_card`, `template_var`, `template_own_goal`, `template_missed_pen`  
**Template IDs**: `T-RED`, `T-VAR`, `T-OG`, `T-PEN`  
**Model**: `MODEL_FETCH` = `claude-haiku-4-5-20251001` | **Max tokens**: 350–500  
**Inputs**: match event data from live API events (minute, player, team, score)  
**Estimated articles/day**: 0–2 each on match days (conditional on events occurring)

---

### Path 21 — Rabona Digest

**Function**: `generateRabonaDigest` (publisher.js lines 2563–end)  
**Publish mode**: not confirmed in the excerpt read  
**Model**: `MODEL_GENERATE` | **Max tokens**: 750  
**Inputs**: video transcripts from Rabona Digital YouTube channel (Fırat Günayer analysis videos), video titles  
**Title**: Claude-generated via `BAŞLIK:` prefix in output  
**Note**: This is the only non-template path that asks Claude to generate its own title inline (similar to SYNTH-D2). No `generateKartalixTitle` call.

---

### `template_injury` routing anomaly — FLAG

`decidePublishMode` (line 138) returns `template_injury` for RSS articles with `category === 'injury'`.

In `writeArticles`, there is no corresponding `} else if (mode === 'template_injury') {` branch. The article falls through to the `else` block (line 533), where it is first set to `rss_summary`, then potentially upgraded to `rewrite` via `synthesizeArticle` if NVS≥50.

**Effect**: `template_injury` as a distinct mode is a dead route. Articles classified as injury fall through to the same rewrite path as general news. The mode label `template_injury` is never actually saved to DB (it gets overwritten in the else block). T07 injury reports are generated separately by the match watcher, not via this routing.

---

## Section 2 — Fact Extraction and Synthesis Inputs

---

### Q10 — `extractFactsForStory` (`src/firewall.js` lines 247–302)

**Return shape** (verbatim from lines 264–276):
```js
{
  entities: {
    players:      string[],
    clubs:        string[],
    competitions: string[],
  },
  numbers:  { /* type-specific: transfer_fee, contract_years, etc. | other: [] */ },
  dates:    { /* type-specific: announcement, contract_end, etc. | other: [] */ },
  story_type:     string,   // one of 8 controlled values
  story_category: string,   // 'sporting' | 'financial' | 'institutional' | 'other'
  _id:      uuid | null,    // Supabase facts table row ID
}
```

**It is not just classification**: It produces a structured fact list (entities + numbers + dates) PLUS classification (`story_type`, `story_category`). Two-step process: classify first (Haiku call via `classifyStoryType`), then extract with the type-appropriate schema (second Haiku call).

**Input**: `${article.title}. ${article.summary || ''}`.slice(0, 800) — RSS title + summary only. Full source text is never used (line 248).

**Where facts are stored after extraction**:
- **Durably in Supabase `facts` table** (lines 277–287): `content_item_id`, `site_id`, `story_type`, `entities`, `numbers`, `dates`, `extraction_model`, token counts.
- **Durably in Supabase `fact_lineage` table** (lines 289–299): audit log of source, URL, source text length, token usage, `destruction_confirmed_at` timestamp.
- **In memory only for the current request**: returned from the function and passed into `matchOrCreateStory` and `addContribution`.
- **Not stored in `stories.summary`** — story rows have no `summary` column.
- **Linked in `story_contributions`** via `facts_id` FK (line 213 in story-matcher.js): `facts_id: facts._id || null`. The contribution record links to the facts row, but the facts themselves are in the `facts` table, not embedded in contributions.
- **Not stored anywhere in `content_items`** — the DB article row has no reference to its extracted facts.

---

### Q11 — `synthesizeStory` (SYNTH-D2) inputs (`src/story-matcher.js` lines 362–526)

- **Does it receive full text of all contributing articles?** YES — via `fetchViaReadability(item.original_url)` for each source (lines 424–431), truncated to 3000 chars per source, up to 5 sources.
- **Does it receive pre-extracted facts?** NO. The function receives only `story` and `siteId`. Pre-extracted facts from `extractFactsForStory` are not passed to `synthesizeStory`. Only `story.story_type` and `story.title` reach the prompt (as `storyContext`, lines 445–448).
- **Does it receive summaries or titles?** YES — as fallback when Readability fails (`item.summary || ''`, line 429). Titles are used as source block headers.
- **Cross-source comparison?** No. Sources are concatenated with `=== KAYNAK N: title ===` delimiters (lines 440–442). No cross-source contradiction detection or comparison logic. Claude receives all sources in parallel and is instructed to write independently of all of them.

---

### Q12 — Complete content the LLM sees for each path

**Path 1 — Rewrite (`synthesizeArticle`)**:
- Source title: full, verbatim
- Source body: up to 10,000 chars fetched via Render proxy (line 389: `sourceText = data.content.slice(0, 10000)`)
- Source URL: not in prompt
- Source name: only for official sources — `Kaynak: Beşiktaş JK resmi açıklaması`
- NVS score: not in prompt
- Story context: not in prompt
- Editorial context: YES — `getEditorialNotes(env, ['general', 'style'])` (KV-stored voice patterns)
- Grounding context: YES — `buildGroundingContext(env, site)` — standings, form, rivals, next match, opponent data from API-Football. Injected as `DOĞRULANMIŞ VERİLER` block.
- Key entities: YES — `extractKeyEntities(title, sourceText, env)` output (Haiku, ≤150 tokens, lines 293–308) formatted as `KİŞİLER: [...]\nOLAY: [...]\nDETAYLAR: [...]`, injected as `ZORUNLU BİLGİLER — bunlar haberde mutlaka yer almalı:` block.
- Trust tier: YES — controls `isOfficial` flag which changes how the source text is framed.

**Path 2 — SYNTH-D2 (`synthesizeStory`)**:
- Source bodies: up to 5, each Readability-fetched and truncated to 3000 chars. Filtered to those > 100 chars.
- Source titles: YES (header labels)
- NVS score: not in prompt
- Facts: NOT the structured extracted facts. Only `story.story_type` and `story.title` as storyContext.
- Editorial context: YES — `getEditorialNotes(env, ['news', story.story_type])`
- Grounding context: NO — `buildGroundingContext` is not called in `synthesizeStory`
- Squad/match context: NO (no API data)

**Path 3 — Story single-source (`generateStoryArticle`)**:
- Source body: Readability-fetched full text, truncated at 4000 in prompt (no pre-truncation in fetch; line 258)
- Source title: YES
- Facts: YES — `factLines` text block with players, clubs, competitions, transfer_fee, contract_years, dates (lines 266–275)
- Editorial context: YES — `getEditorialNotes(env, ['news', story.story_type])`
- Grounding context: NO — `buildGroundingContext` not called here
- NVS score: not in prompt

**Path 4 — Transfer Firewall (`writeTransfer`)**:
- Source text: NOT present at all. LLM sees only extracted fact lines (structured entities/numbers/dates). Source text was discarded before this function is called.
- Editorial context: NO
- Grounding context: NO

**Path 6 — Original News Synthesis (`generateOriginalNews`)**:
- Source content: RSS summary only, max 600 chars per source (NOT full-text fetched). Line 2451: `(a.summary || '').slice(0, 600)`
- Source titles: YES
- NVS score: not in prompt
- Story context: not in prompt
- Editorial context: YES — `getEditorialNotes(env, ['general', 'style'])`
- Grounding context: YES — `buildGroundingContext`
- National team / other sport context: injected if detected via regex on source titles/summaries (lines 2467–2483)

---

### Q13 — Fact extraction before rewrite?

**No.** `synthesizeArticle` does not call `extractFactsForStory` or `extractFacts` before generation.

There is one related call: `extractKeyEntities` (line 420, lines 293–308). However, this is NOT fact extraction in the structured sense:
- It is a lightweight Haiku call (≤150 output tokens)
- It returns free-text formatted output (`KİŞİLER: [...] / OLAY: [...] / DETAYLAR: [...]`), not structured JSON
- It is not stored anywhere (no Supabase write, no `facts` table row)
- It is injected into the synthesis prompt as a "must-include" reminder block, not as structured input

**The LLM generating the rewrite article sees: source title + raw source text (up to 10,000 chars) + editorial notes + grounding context + key-entities reminder.**

There is no structured fact extraction step before generation. The LLM reads the full source text and generates the rewrite directly from it.

Relevant code (lines 417–421):
```js
const [editorialCtx, groundingCtx, keyEntities] = await Promise.all([
  getEditorialNotes(env, ['general', 'style']),
  buildGroundingContext(env, site),
  extractKeyEntities(article.title, sourceText, env),
]);
```

---

### Q14 — Synthesis with 3+ sources: what does the LLM see?

In SYNTH-D2 (`synthesizeStory`), when 3+ sources contribute, the LLM sees all source bodies concatenated in a single prompt, each prefixed with a source header.

Format (lines 440–442):
```js
const sourceBlocks = validSources.map((s, i) =>
  `=== KAYNAK ${i + 1}: ${s.title} ===\n${s.text}`
).join('\n\n');
```

- Up to 5 sources (capped at line 429 fetch loop)
- Each source body: Readability-fetched full text, truncated to 3000 chars per source (line 429: `.slice(0, 3000)`)
- Source attribution: preserved as `=== KAYNAK N: source_title ===` header only
- No source URL in prompt
- No per-source NVS or trust tier info in prompt
- Sources are sorted by `nvs_score DESC` before the prompt is built (Supabase query line 382: `order=nvs_score.desc`)
- No cross-source comparison logic: Claude receives all sources simultaneously and is asked to write independently from all of them

---

### Q15 — Supabase fact tables

From code inspection, the following tables are referenced via Supabase POST calls:

| Table | Referenced in | Purpose |
|---|---|---|
| `facts` | `extractFacts` (firewall.js line 141), `extractFactsForStory` (firewall.js line 277) | Structured extracted facts (entities, numbers, dates) |
| `fact_lineage` | `extractFacts` (line 155), `extractFactsForStory` (line 289) | Audit log: source URL, text length, destruction timestamp |

**No code references** to: `article_facts`, `story_facts`, `claims`, or any other fact-related table names anywhere in `publisher.js`, `story-matcher.js`, or `firewall.js`.

**Unknown — requires direct Supabase inspection**: Whether `facts` and `fact_lineage` tables actually exist and are populated in production. The code makes these inserts but does not check return values before continuing (line 277: `const factsRows = await supabasePost(...)` — failure would only surface if `factsRows?.[0]?.id` returns null, which is handled gracefully). The audit cannot confirm from code alone that these tables exist in production.

---

## Summary of notable findings

1. **Rewrite has no structured fact extraction before generation** — LLM reads raw source text. `extractKeyEntities` is a lightweight entities reminder, not structured facts. Padding/filler patterns in output are consistent with LLM filling word-count target when source is thin.

2. **SYNTH-D2 receives no pre-extracted facts** — only raw source bodies. The facts extracted by `extractFactsForStory` are stored in Supabase and linked to story contributions but are not passed forward into synthesis.

3. **`original_synthesis` path uses RSS summaries only (≤600 chars/source)** — unlike rewrite and SYNTH-D2, no full-text fetch. Filler risk is higher here due to thin input.

4. **`template_injury` is a ghost routing mode** — declared in `decidePublishMode` but falls through to the rewrite/rss_summary else-block in `writeArticles`. No distinct handling.

5. **`generateKartalixTitle` is not applied to all paths** — only `synthesizeArticle` (rewrite). Not applied to: `generateStoryArticle`, `synthesizeStory`, `generateOriginalNews`, or `generateRabonaDigest`. These paths use the source RSS title or Claude's inline BAŞLIK: output.

6. **Grounding context is absent from SYNTH-D2 and story single-source** — `buildGroundingContext` is called in rewrite and original_synthesis but not in `synthesizeStory` or `generateStoryArticle`.
