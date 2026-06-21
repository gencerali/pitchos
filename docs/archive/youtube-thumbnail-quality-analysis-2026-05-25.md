# YouTube Thumbnail Quality Analysis — 2026-05-25

## Data scope

**Target**: All youtube_embed articles from the last 14 days across all YouTube sources.
**Site**: `2b5cfe49-b69a-4143-8323-ca29fff6502e`
**Total probed**: 133 videos across 8 channels

---

## Final recommendation

**Switch `hqdefault` → `maxresdefault`. No probe logic needed.**

- maxresdefault coverage: **133/133 (100%)** across all 8 channels and all 133 videos in the 14-day window
- Switching is a 1-line change in `youtubeThumbnailUrl()` (`src/publisher.js`)
- No per-video probe overhead, no fallback logic, no channel-specific rules
- 8.6× quality improvement over hqdefault (154 KB vs 18 KB avg for A Spor)

---

## Per-source results

| source_name | videos | maxres 200% | sd 200% | hq 200% | avg maxres KB | avg sd KB | avg hq KB | hq <10KB |
|-------------|--------|-------------|---------|---------|--------------|---------|---------|---------|
| A Spor | 100 | 100% | 100% | 100% | 154 | 63 | 18 | 8 |
| Vole | 17 | 100% | 100% | 100% | 126 | 53 | 15 | 0 |
| beIN SPORTS TR YT | 7 | 100% | 100% | 100% | 171 | 67 | 19 | 0 |
| Kartalix | 3 | 100% | 100% | 100% | 299 | 89 | 23 | 0 |
| Beşiktaş JK | 2 | 100% | 100% | 100% | 137 | 49 | 21 | 0 |
| Rabona Digital | 2 | 100% | 100% | 100% | 173 | 65 | 39 | 0 |
| TRT Spor | 1 | 100% | 100% | 100% | 186 | 68 | 17 | 0 |
| beIN SPORTS TR | 1 | 100% | 100% | 100% | 199 | 63 | 17 | 0 |
| **TOTAL** | **133** | **100%** | **100%** | **100%** | **~152** | **~62** | **~18** | **8** |

---

## A Spor hqdefault under 10KB — 8 cases

All 8 have healthy maxresdefault and sddefault. Low hq size is resolution-specific, not a missing thumbnail.

| video_id | date | hq bytes | maxres bytes | sd bytes |
|----------|------|---------|-------------|---------|
| PwQHAIEUuvU | 2026-05-20 | 6,563 | 45,155 | 22,285 |
| 9rPdZR9g7RQ | 2026-05-22 | 7,025 | 47,008 | 23,701 |
| Qqt2iPex048 | 2026-05-25 | 8,345 | 54,487 | 28,862 |
| xUswCJPn-1A | 2026-05-17 | 8,807 | 61,648 | 31,868 |
| WtnoWOpCbvk | 2026-05-20 | 8,857 | 59,727 | 30,568 |
| SysMxzDFXA0 | 2026-05-20 | 9,196 | 59,701 | 30,903 |
| z68e4PB_4hw | 2026-05-21 | 9,509 | 68,569 | 33,546 |
| Rgk-HR8Rd1k | 2026-05-18 | 9,590 | 58,685 | 31,258 |

---

## Code change required

**File**: `src/publisher.js`

```javascript
// Before
return `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

// After
return `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`;
```

---

## Options considered

| option | description | complexity | risk |
|--------|-------------|------------|------|
| A | keep hqdefault | none | 8% of A Spor thumbnails appear blurry/small |
| B | probe maxresdefault at save, fall back to hqdefault | medium | none — but complexity unnecessary given 100% coverage |
| **C** | **switch to sddefault universally** | **trivial** | **none** |
| **D** | **switch to maxresdefault universally** | **trivial** | **none — confirmed 100% across 133 videos** |

Option D selected. Coverage data makes per-video probing unnecessary.
