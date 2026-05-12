# SOURCES.md — RSS Feed Registry

**How to use**: When adding or verifying a feed, update the status and last-verified date. Until Slice 4 ships the source admin UI, feeds are managed in `src/fetcher.js`.

**Statuses**: `active` · `dead` · `unverified` · `proxy`

---

## Beşiktaş (BJK)

| Source | RSS URL | Trust | P4 | Status | Notes |
|---|---|---|---|---|---|
| BJK Resmi | https://www.bjk.com.tr/tr/haber/ | official | No | blocked | Blocks all datacenter IPs (direct, pitchos-proxy, allorigins). Parked — will come via @Besiktas Twitter in Slice 4 |
| NTV Spor | https://www.ntvspor.net/rss/kategori/futbol | broadcast | Yes | active | Has HTML fallback. Last verified 2026-04-29 |
| A Haber | https://www.ahaber.com.tr/rss/besiktas.xml | press | Yes | active | BJK-specific feed. Last verified 2026-04-29 |
| TRT Haber | https://www.trthaber.com/spor_articles.rss | broadcast | No | active | General sports, keyword filter. Last verified 2026-04-29 |
| Hürriyet | https://www.hurriyet.com.tr/rss/spor | press | Yes | active | General sports, keyword filter. Last verified 2026-04-29 |
| Sabah Spor | https://www.sabah.com.tr/rss/spor.xml | press | Yes | active | General sports, keyword filter. Last verified 2026-04-29 |
| Habertürk Spor | https://www.haberturk.com/rss/spor.xml | press | Yes | active | General sports, keyword filter. Last verified 2026-04-29 |
| Fanatik | https://www.fanatik.com.tr/rss/besiktas | press | Yes | dead | 404 — URL wrong. Correct URL unknown, re-add when confirmed |
| Duhuliye | https://www.duhuliye.com/rss | press | Yes | active | Aggregates/republishes P4 press content. Treated as P4. 88 articles/run. Last verified 2026-04-29 |
| Google News | https://news.google.com/rss/search?q=Besiktas+BJK&hl=tr&gl=TR&ceid=TR:tr | press | Yes | proxy | 503 direct (bot detection), routed via pitchos-proxy. 30 articles/run. Last verified 2026-04-29 |
| Fotomaç | https://www.fotomac.com.tr/rss/Besiktas.xml | press | Yes | proxy | 403-blocked direct, routed via pitchos-proxy. Last verified 2026-04-29 |
| A Spor | https://www.aspor.com.tr/rss/besiktas.xml | broadcast | Yes | proxy | 403-blocked direct, routed via pitchos-proxy. Last verified 2026-04-29 |

### Removed / Dead
| Source | URL tried | Reason |
|---|---|---|
| Milliyet Spor | https://www.milliyet.com.tr/rss/rssnews/spor | Returning 0 — URL unverified |
| Sporx | https://www.sporx.com/rss/besiktas.xml | Returning 0 — URL unverified |
| Ajansspor | https://www.ajansspor.com/rss/besiktas | Returning 0 — URL unverified |
| Sky Sports | https://www.skysports.com/rss/12040 | 0 BJK articles after keyword filter — removed |
| Transfermarkt | https://www.transfermarkt.com/rss/news | Feed broken, returning 0 — removed |

---

## How to add a new source

1. Find the RSS URL (check site's page source for `<link rel="alternate" type="application/rss+xml">`)
2. Add to `src/fetcher.js` RSS_FEEDS with correct trust/is_p4/keywordFilter flags
3. Add to this file with status `unverified`
4. Deploy + `/force-cache` + check `/status` bySource for the new feed
5. Update status to `active` once confirmed returning articles

---

*Last updated: 2026-04-29*
