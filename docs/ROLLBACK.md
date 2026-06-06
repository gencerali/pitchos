# ROLLBACK & TROUBLESHOOTING

How to ship the big batch safely, find what broke, and undo it — fast. Two artifacts:
the **Worker** (`wrangler deploy`) and the **SPA** (Cloudflare Pages, deploys on push/merge).

---

## 0. The cheapest lever: kill-switches (no redeploy needed)
Most of this session's risk is behind flags — flip these in KV/admin instead of rolling back:

| Symptom | Switch | How |
|---|---|---|
| Method B misbehaving | `methodb:enabled = 0` | `wrangler kv key put --namespace-id=dedaea653ed542cca25e6cc2551dd1c3 methodb:enabled 0` |
| Homepage serving wrong pool | `pipeline:active:BJK = legacy` | `/admin/config` → "0. Pipeline (serving)" → **Legacy yap** (instant) |
| Card photos look wrong | clear `card:bg_pool` | `wrangler kv key delete --namespace-id=… card:bg_pool` → falls back to procedural |

So before any rollback, ask: *can a flag fix this?* Usually yes for the Method B / cutover / photo features. The **always-on** changes from this batch are only: article-body rendering, IT6 card fallback, the rival guard, and the sitemap tweak — those are the ones a real rollback targets.

## 1. Deploy in stages (so you can isolate)
Don't flip everything at once. Recommended order, verifying after each:
1. `./deploy.sh` → **worker only first** (Method B stays inert, pointer=legacy). Watch: article pages render, homepage cards, no rival articles, costs normal.
2. Merge to main → **SPA (Pages)** ships. Watch: article view (drop-cap, paragraphs, subheads), homepage feed.
3. Apply migration → `methodb:enabled=1` → **observe `/admin/pipeline`** for days.
4. Only then **flip serving** to Method B on `/admin/config`.
Each step is independently reversible; a problem points at the step you just did.

## 2. Confirm what's actually live
- **Worker:** `GET https://kartalix.com/version` → `{ "worker": "<git-sha>", ... }` (set by `deploy.sh --var BUILD_SHA`). If the SHA isn't what you expect, the deploy didn't take.
- **SPA:** Cloudflare → Pages → Deployments — each row shows the **commit SHA** that's live.
- **Git tags:** `deploy.sh` writes `deploy-YYYYMMDD-HHMM-<sha>` — `git tag --list 'deploy-*'` maps a live version back to exact code.

## 3. Troubleshoot
- **`wrangler tail`** — live worker logs (pipeline prints `SCORING`, `SYNTH`, `REWRITE DRAIN`, `PIPELINE FLIP`, errors). The #1 tool.
- **`/admin/pipeline`** — legacy vs Method B pools + last-run tally + cost.
- **`/admin/cost`** — monthly spend vs cap (catch a cost spike from a loop).
- **Cloudflare dashboard** — Workers error rate / exceptions; Pages build logs.

## 4. Roll back

**Worker (instant, version-pinned):**
```bash
npx wrangler deployments list          # see versions + timestamps + your BUILD_SHA message
npx wrangler rollback [<version-id>]    # revert to a previous worker version
```

**SPA / Pages (instant):**
Cloudflare → Pages → Deployments → pick the last-good deployment → **Rollback to this deployment**. (Or revert the `index.html` commit and push.)

**KV state:** the flags in §0 — instant, no deploy.

## 5. Undo a *specific* change (identify by commit)
Commits this session are **one feature each**, so you can surgically revert without losing the rest:
```bash
git log --oneline                 # find the offending commit
git revert <sha>                  # e.g. revert just the body-rendering change
./deploy.sh                       # redeploy worker (+ merge for SPA)
```
Scoped commits worth knowing:
- `5b147da` article-body rendering (markdown/subheads/drop-cap)
- `52d56b2`/`2204831`… IT6 cards
- `01e7765` rival-subject guard (preFilter)  ·  `833f49f` rival guard for video
- `79a11e4` shared presentation module

## 6. Pre-deploy safety tag (do this first)
Before the batch, mark the last-known-good so you can always return to it:
```bash
git tag pre-batch-$(date -u +%Y%m%d) <current-main-sha>
git push --tags
```

---

### TL;DR
Flag first (§0) → confirm version (`/version`, §2) → tail logs (§3) → platform rollback (§4, instant) → or surgical `git revert` of the one bad commit (§5). Deploy in stages (§1) so "what broke" is always "the last thing I did."
