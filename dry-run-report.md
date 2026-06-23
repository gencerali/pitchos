# Pipeline Dry-Run Report
_In-session report — 50 content_items fetched live from Supabase, 2026-06-23 UTC_
_JS pre-filter stages only; no LLM calls (all raw_body null in DB)._

## Summary

| Metric | Count |
|--------|-------|
| Fetched from DB (last 72h) | 50 |
| **Passed all JS filters** | **29 (58%)** |
| Rejected | 17 (34%) |
| &nbsp;&nbsp;↳ title_dedup | 16 (32%) |
| &nbsp;&nbsp;↳ rival_subject | 1 (2%) |
| _Live fact extraction_ | _0 — ANTHROPIC_API_KEY not in session; run dry-run-pipeline.mjs at laptop_ |

## Pass Rate by Trust Tier

| Tier | DB trust_score | Total | Passed | Pass Rate |
|------|----------------|-------|--------|-----------|
| T2 | 70 | 17 | 13 | 76% |
| T3 | 50 | 29 | 12 | 41% |
| T4 | 25 | 4 | 4 | 100% |

## Pass Rate by Source

| Source | Total | Passed | Pass Rate |
|--------|-------|--------|-----------|
| A Spor | 18 | 4 | 22% |
| Kafa Sports | 1 | 0 | 0% |
| Kartalix | 31 | 25 | 81% |

## Per-Article Firewall Decisions

| # | Tier | Source | Title | Decision | Stage | Detail |
|---|------|--------|-------|----------|-------|--------|
| 1 | T3 | Kartalix | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti | ✅ PASS | - |  |
| 2 | T3 | Kartalix | Beşiktaş, Fatawu için Everton ve Leipzig ile yarışıyor | ✅ PASS | - |  |
| 3 | T3 | A Spor | TRANSFER \| Beşiktaş Abdul Fatawu İçin Leicester İle Gö | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 4 | T3 | A Spor | TRANSFER \| Beşiktaş Abdul Fatawu İçin Leicester İle Gö | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 5 | T3 | A Spor | TRANSFER \| Beşiktaş Amrabat İçin Fenerbahçe'den Bilgi  | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 6 | T3 | A Spor | TRANSFER \| Beşiktaş Amrabat İçin Fenerbahçe'den Bilgi  | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 7 | T3 | A Spor | Efecan Öztaş: "İngiltere, Arabistan Ve Hollanda'dan Wil | ✅ PASS | - |  |
| 8 | T2 | Kartalix | Sörloth'un transfer kararı Beşiktaş'ı bekletecek | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 9 | T2 | Kartalix | Beşiktaş, Emirhan Topçu'yu tutuyor: Suudi ve İtalyan te | ✅ PASS | - |  |
| 10 | T2 | Kartalix | Beşiktaş, El Bilal Toure'yi yeniden kiralamak istiyor | ✅ PASS | - |  |
| 11 | T3 | A Spor | Beşiktaş'ın İlk Transferi Hangi Mevkiye Olmalı? \| Beşi | ✅ PASS | - |  |
| 12 | T3 | A Spor | Sergen Yalçın'ın Çok Konuşulan Montella Sözleri! Murat  | ✅ PASS | - |  |
| 13 | T2 | Kartalix | Beşiktaş'ın Slovakya kampı 27 Haziran'da başlayacak, 6  | ✅ PASS | - |  |
| 14 | T3 | A Spor | Galatasaray'a Kimler Veda Edecek? \| Beşiktaş Hangi Fut | ❌ DROP | title_dedup | https://www.youtube.com/watch?v=QzNf8tzWBjg |
| 15 | T3 | A Spor | Galatasaray'a Kimler Veda Edecek? \| Beşiktaş Hangi Fut | ❌ DROP | title_dedup | https://www.youtube.com/watch?v=QzNf8tzWBjg |
| 16 | T4 | Kartalix | Beşiktaş'ın genç santrforu Karahisar, Aliağa FK'ye tran | ✅ PASS | - |  |
| 17 | T2 | Kartalix | Serkan Emrecan Terzi Iğdır FK'ya gidiyor, satış payı ga | ✅ PASS | - |  |
| 18 | T3 | Kartalix | Beşiktaş'ta kaleci transferinde sıcak saatler | ✅ PASS | - |  |
| 19 | T3 | Kartalix | Kartal'ın listesine Çek kaptan girdi | ✅ PASS | - |  |
| 20 | T3 | Kartalix | Beşiktaş'ın kaleci için B planı | ✅ PASS | - |  |
| 21 | T3 | Kartalix | Beşiktaş'a transferde kötü haber... | ✅ PASS | - |  |
| 22 | T3 | Kartalix | Beşiktaş, Skov Olsen'i sakatlık geçmişi nedeniyle geri  | ✅ PASS | - |  |
| 23 | T3 | A Spor | TRANSFER GELİŞMESİ \| Beşiktaş, Sofyan Amrabat İçin Fen | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 24 | T3 | A Spor | TRANSFER GELİŞMESİ \| Beşiktaş, Sofyan Amrabat İçin Fen | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 25 | T2 | Kartalix | Beşiktaş, Fenerbahçe'nin kadrosundan çıkardığı Amrabat' | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 26 | T3 | A Spor | Beşiktaş Transfer İçin Atağa Kalktı: Fenerbahçe'ye Sofy | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 27 | T3 | A Spor | Beşiktaş Transfer İçin Atağa Kalktı: Fenerbahçe'ye Sofy | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 28 | T2 | Kartalix | Beşiktaş'a 735 bin lira ceza, Alimpijevic'e 40 bin lira | ✅ PASS | - |  |
| 29 | T2 | Kartalix | Kevin Boma Beşiktaş'ı reddetti, RB Salzburg'a gidiyor | ✅ PASS | - |  |
| 30 | T2 | Kartalix | Beşiktaş, Wolfsburg'un Danimarkalı sağ bek Skov Olsen'i | ❌ DROP | title_dedup | Beşiktaş, Skov Olsen'i sakatlık geçmişi nedeniyle geri  |
| 31 | T2 | Kartalix | Beşiktaş, Bilal Bayazıt'ı transfer listesine aldı | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 32 | T2 | Kartalix | Vlahovic, Beşiktaş'ın teklifini olumlu karşıladı | ✅ PASS | - |  |
| 33 | T2 | Kartalix | Beşiktaş, Nübel için Bayern'in fiyatından anlaşamazsa B | ✅ PASS | - |  |
| 34 | T2 | Kartalix | Beşiktaş, Italiano'nun isteği üzerine Frendrup için Gen | ✅ PASS | - |  |
| 35 | T2 | Kartalix | Hermoso'ya Beşiktaş'tan çağrı: Bonservisini çöz, görüşe | ✅ PASS | - |  |
| 36 | T2 | Kartalix | Skov Olsen Beşiktaş'ın radarında: İtaliano için sağ kan | ✅ PASS | - |  |
| 37 | T2 | Kartalix | Beşiktaş'ın Hermoso'ya şartı net: Bonservis yok, sözleş | ✅ PASS | - |  |
| 38 | T2 | Kartalix | Sergen Yalçın, Ersin Destanoğlu'nun devre arasındaki çö | ✅ PASS | - |  |
| 39 | T4 | Kartalix | Beşiktaş, Anguissa için Napoli'ye resmi teklif hazırlığ | ✅ PASS | - |  |
| 40 | T4 | Kartalix | Italiano'ya 150 milyon Euro bütçe: İtalyan basını Beşik | ✅ PASS | - |  |
| 41 | T4 | Kartalix | Destanoğlu'nun Avrupa teklifi, Beşiktaş'tan ayrılığa ya | ✅ PASS | - |  |
| 42 | T3 | A Spor | Beşiktaş'ın Gündeminde Hangi Futbolcular Var? Kimlerle  | ✅ PASS | - |  |
| 43 | T3 | Kafa Sports | Sergen Yalçın'dan Montella Yorumu \| Candaş Tolga Işık | ❌ DROP | title_dedup | https://www.youtube.com/watch?v=1Ywkcb3vNP8 |
| 44 | T3 | Kartalix | Beşiktaş, Vlahovic'i Transfer Etmek İçin Görüşmelerde | ❌ DROP | title_dedup | Beşiktaş, Sofyan Amrabat Transfer İçin Harekete Geçti |
| 45 | T3 | Kartalix | Beşiktaş Kalede Yabancı İstiyor: Kepa ve Jörgensen Günd | ✅ PASS | - |  |
| 46 | T3 | Kartalix | Dirk Kuyt, Fenerbahçe'de İsmail Kartal'ın yardımcısı ol | ❌ DROP | rival_subject | rival-led title, no BJK keyword |

## Notes

- **raw_body is NULL for all 50 articles**: pipeline stores only processed `full_body`. Stage 2 keyword checks ran on title+summary only (<=600 chars). In production the full body would be checked — some `off_topic` drops here might pass with body text.
- **No T4 articles were dropped by the T4 title gate**: all 4 trust_score=25 articles have "Beşiktaş" in the title, confirming the Duhuliye/T4 aggregator sources feed focused BJK content.
- **Live fact extraction**: run `node scripts/dry-run-pipeline.mjs --limit 50 --live-extract 10` at laptop with env vars set.

