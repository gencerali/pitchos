# Admin Consolidation + Method B Admin Gaps — Review Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `/subagent-driven-development` (recommended) or `/executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **STATUS: REVIEW ONLY — do not execute without human sign-off on each group.**

**Goal:** Remove dead admin scaffolding, fix one analytics bug that silences Method B data, and add the three admin capabilities Method B needs before the Week 1 observation window can yield useful signals.

**Architecture:** All changes are in `worker-fetch-agent.js` (admin routes + render functions) and `worker-story-agent.js` (new cursor-reset endpoint + delta ring buffer). No schema migrations required for Group A or B. Group C (topic browser, shadow preview) requires read-only Supabase queries against tables that already exist (`topics`, `phases`).

**Tech Stack:** Cloudflare Workers, KV, Supabase REST, vanilla JS/HTML in render functions.

## Global Constraints

- Never touch `articles:{site}` (live feed) or `pipeline:active` pointer from cleanup tasks
- All new UI goes inside existing `renderPipelineComparePage` or `renderAdminConfigPage` — no new top-level pages for Group B tasks
- Auth pattern: all new endpoints use `requireOps(request, env)` (same as existing ops-level routes)
- KV key conventions: `methodb:*` prefix for all Method B state
- No external dependencies — pure inline HTML/CSS/JS in render functions, same pattern as the rest of the worker

---

## GROUP A — Cleanup & Quick Fixes
*Effort: < 1h total. Zero risk — deleting flagged-TEMP code and fixing a silent analytics bug.*
*No prerequisites. Safe to execute before deployment.*

---

### Task A1: Delete the two TEMP routes

**Files:**
- Modify: `worker-fetch-agent.js:2860–2916`

**What to change:**

Delete lines 2860–2881 (the `// TEMP: rewrite-db-check` block) and lines 2883–2916 (the `// TEMP: proxy-probe` block). Both are already annotated for removal by the original author.

Before (lines 2860–2916):
```js
// TEMP: rewrite-db-check — remove after use
if (url.pathname === '/admin/rewrite-db-check' && request.method === 'GET') {
  // ... ~20 lines
}
// END TEMP

// TEMP: proxy-probe — test article URL through Render proxy
if (url.pathname === '/admin/proxy-probe' && request.method === 'GET') {
  // ... ~30 lines
}
// END TEMP proxy-probe
```

After: both blocks deleted entirely. The `if (url.pathname === '/admin/pool-timeseries'...` block at line 2918 becomes the natural successor.

**Acceptance criterion:** `grep -n 'rewrite-db-check\|proxy-probe' worker-fetch-agent.js` returns nothing.

- [ ] Delete lines 2860–2881
- [ ] Delete lines 2883–2916
- [ ] `git commit -m "chore: delete TEMP admin routes (rewrite-db-check, proxy-probe)"`

---

### Task A2: Fix `modeGroup()` — Method B articles invisible in analytics

**Files:**
- Modify: `worker-fetch-agent.js:3153–3160`

**What to change:**

Current `modeGroup` at line 3153 silently maps `methodb_synth` to `'other'`, making Method B articles invisible on the analytics breakdown chart.

Before:
```js
const modeGroup = m => {
  if (!m) return 'other';
  if (m === 'youtube_embed') return 'video';
  if (m === 'synthesis_generated' || m === 'original_synthesis') return 'yz_plus';
  if (m === 'rewrite' || m === 'copy_source') return 'yz';
  if (m && m.startsWith('template_')) return 'template';
  return 'other';
};
```

After:
```js
const modeGroup = m => {
  if (!m) return 'other';
  if (m === 'youtube_embed') return 'video';
  if (m === 'synthesis_generated' || m === 'original_synthesis') return 'yz_plus';
  if (m === 'rewrite' || m === 'copy_source') return 'yz';
  if (m && m.startsWith('template_')) return 'template';
  if (m === 'methodb_synth') return 'methodb';
  return 'other';
};
```

Also update the `pubByDayMap` initializer at line 3170 to include the new group key so the chart renders it:

Before:
```js
if (!pubByDayMap[day]) pubByDayMap[day] = { day, video: 0, yz: 0, yz_plus: 0, template: 0, other: 0 };
```

After:
```js
if (!pubByDayMap[day]) pubByDayMap[day] = { day, video: 0, yz: 0, yz_plus: 0, template: 0, methodb: 0, other: 0 };
```

**Acceptance criterion:** After Method B promotes articles to live pool, `/admin/analytics-data` response `pub_by_day` rows include a `methodb` key with correct count.

- [ ] Update `modeGroup` function (line 3153–3160)
- [ ] Update `pubByDayMap` initializer (line 3170)
- [ ] `git commit -m "fix: track methodb_synth in analytics modeGroup"`

---

### Task A3: Deprecate `/admin/golden-fixtures`

**Files:**
- Modify: `worker-fetch-agent.js:2262–2325`

**What to change:**

The route queries `story_contributions` and `story_state_transitions` — Slice 2 tables from the old pipeline that Method B does not use. The fixtures test nothing about the live system.

Replace the entire route body with a JSON tombstone explaining what replaced it:

```js
if (url.pathname === '/admin/golden-fixtures') {
  return Response.json({
    deprecated: true,
    reason: 'Slice 2 tables (story_contributions, story_state_transitions) superseded by Method B topics/phases. See /admin/pipeline for Method B health.',
    replacement: '/admin/pipeline?site=BJK',
  }, { headers: { 'Content-Type': 'application/json' } });
}
```

**Acceptance criterion:** `GET /admin/golden-fixtures` returns `{"deprecated":true,...}` with status 200.

- [ ] Replace route body with tombstone (lines 2262–2325)
- [ ] `git commit -m "chore: deprecate /admin/golden-fixtures (Slice 2 scaffolding)"`

---

### Task A4: Deprecate `/admin/releases` — link to GitHub instead

**Files:**
- Modify: `worker-fetch-agent.js:3342–3350`
- Modify: `renderAdminReleasesPage` at `worker-fetch-agent.js:13359`

**Context:** The `renderAdminReleasesPage` function is a ~700-line hardcoded HTML changelog. It can't be updated without a deploy. The canonical source of truth is `docs/ROADMAP.md` in the repo.

**What to change:**

Replace the route handler body so it redirects to the GitHub file:

```js
if (url.pathname === '/admin/releases') {
  return Response.redirect('https://github.com/gencerali/pitchos/blob/main/docs/ROADMAP.md', 302);
}
```

Then delete or comment out `renderAdminReleasesPage` (lines 13359–14053 approximately) to recover ~700 lines of dead weight. Confirm no other route references it first:
```bash
grep -n 'renderAdminReleasesPage' worker-fetch-agent.js
```

**Acceptance criterion:** `GET /admin/releases` redirects to the GitHub ROADMAP.md URL. `renderAdminReleasesPage` is deleted.

- [ ] Replace route with redirect (line 3342–3350)
- [ ] Confirm no other callers: `grep -n 'renderAdminReleasesPage' worker-fetch-agent.js`
- [ ] Delete `renderAdminReleasesPage` function (lines 13359–~14053)
- [ ] `git commit -m "chore: replace /admin/releases with GitHub redirect, delete ~700-line render fn"`

---

## GROUP B — Method B: Week 1 Observation Blockers
*Effort: ~2h total. These three tasks are needed BEFORE the 5-day observation window starts — without them you can't reset a stuck cursor, can't see why items are skipped, and can't arm just one site.*
*Prerequisite: deploy `worker-story-agent.js` first.*

---

### Task B1: Per-site Method B enable flag

**Files:**
- Modify: `worker-story-agent.js:74` (armed check)
- Modify: `worker-fetch-agent.js:3222–3260` (pipeline route + render)
- Modify: `renderPipelineComparePage` at `worker-fetch-agent.js:9289`

**Context:** `methodb:enabled` is a single global KV flag. There is no way to arm Method B for one site only, which means the first activation is all-or-nothing across all sites.

**What to change in `worker-story-agent.js`:**

Line 74, replace the single-flag check:
```js
// Before:
const armed = (await env.PITCHOS_CACHE.get(ENABLED_KEY)) === '1';
if (!armed && !opts.force) return { skipped: 'methodb:enabled != 1' };
```
```js
// After: check global flag OR per-site flag
const armedGlobal = (await env.PITCHOS_CACHE.get(ENABLED_KEY)) === '1';
// processSiteMethodB now receives site so per-site check is done there
if (!armedGlobal && !opts.force) {
  // Still run but let processSiteMethodB filter per-site
}
```

In `processSiteMethodB` (after the `checkCostCap` block, ~line 92), add per-site check:
```js
// Per-site override: methodb:enabled:BJK = '0' disables even if global = '1'
// methodb:enabled:BJK = '1' enables even if global = '0' (useful for single-site testing)
const perSiteKey = `methodb:enabled:${code}`;
const perSiteFlag = await env.PITCHOS_CACHE.get(perSiteKey);
const armedGlobal = (await env.PITCHOS_CACHE.get(ENABLED_KEY)) === '1';
const armed = perSiteFlag === '1' || (armedGlobal && perSiteFlag !== '0');
if (!armed && !opts.force) {
  return { skipped: `methodb disabled for ${code}` };
}
```

**What to change in `/admin/pipeline` render:**

In `renderPipelineComparePage`, add a per-site enable/disable toggle button in the `<header>` meta section, after the existing ENABLED/INERT badge:

```html
<button onclick="toggleSite()" id="btn-site-toggle" style="margin-left:10px;padding:3px 10px;border-radius:6px;font-size:12px;cursor:pointer;background:#2d3748;border:1px solid #4a5568;color:#e2e8f0">
  ${perSiteEnabled ? 'Disable for this site' : 'Enable for this site only'}
</button>
<script>
async function toggleSite() {
  const btn = document.getElementById('btn-site-toggle');
  btn.disabled = true;
  const r = await fetch('/admin/pipeline/site-toggle', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({site:'${esc(site.short_code)}'})});
  if (r.ok) location.reload(); else btn.disabled = false;
}
</script>
```

Add the new toggle endpoint to the pipeline route section (~line 3248):
```js
if (url.pathname === '/admin/pipeline/site-toggle' && request.method === 'POST') {
  const authErr = await requireOps(request, env); if (authErr) return authErr;
  const body = await request.json().catch(() => ({}));
  const code = body.site || site.short_code;
  const key = `methodb:enabled:${code}`;
  const cur = await env.PITCHOS_CACHE.get(key);
  await env.PITCHOS_CACHE.put(key, cur === '1' ? '0' : '1');
  return Response.json({ ok: true, site: code, enabled: cur !== '1' });
}
```

**Acceptance criterion:** `wrangler kv key get methodb:enabled:BJK` shows `'1'` after toggling on the pipeline page. Global flag off + per-site on = method B runs for that site only.

- [ ] Update `processSiteMethodB` armed check in `worker-story-agent.js`
- [ ] Add `/admin/pipeline/site-toggle` endpoint in `worker-fetch-agent.js`
- [ ] Update `renderPipelineComparePage` to show per-site toggle button (needs `perSiteEnabled` param passed in)
- [ ] Update the `/admin/pipeline` GET handler to read per-site flag and pass to render fn
- [ ] `git commit -m "feat: per-site methodb enable flag + pipeline toggle button"`

---

### Task B2: Cursor reset button in `/admin/pipeline`

**Files:**
- Modify: `worker-story-agent.js` — add `/reset-cursor` POST endpoint
- Modify: `worker-fetch-agent.js:9289` (`renderPipelineComparePage`)
- Modify: `worker-fetch-agent.js:3222` (pipeline GET handler, to proxy the reset)

**Context:** When a bug is fixed mid-observation and you want to replay a batch, the only option is direct KV CLI manipulation (`wrangler kv key delete methodb:cursor:BJK`). A button in `/admin/pipeline` removes this friction.

**What to add in `worker-story-agent.js` fetch handler (~line 58):**
```js
if (url.pathname === '/reset-cursor' && request.method === 'POST') {
  const key = request.headers.get('x-methodb-key');
  const expected = await env.PITCHOS_CACHE.get('methodb:admin_key');
  if (!expected || key !== expected) return new Response('unauthorized', { status: 401 });
  const body = await request.json().catch(() => ({}));
  const code = body.site;
  if (!code) return Response.json({ error: 'site required' }, { status: 400 });
  await env.PITCHOS_CACHE.delete(`methodb:cursor:${code}`);
  return Response.json({ ok: true, site: code, cursor_reset: true });
}
```

**What to add in `worker-fetch-agent.js` pipeline route (~line 3248):**

A proxy endpoint so the admin UI doesn't need to know the story worker URL:
```js
if (url.pathname === '/admin/pipeline/reset-cursor' && request.method === 'POST') {
  const authErr = await requireOps(request, env); if (authErr) return authErr;
  const body = await request.json().catch(() => ({}));
  const code = body.site || currentSite.short_code;
  await env.PITCHOS_CACHE.delete(`methodb:cursor:${code}`);
  return Response.json({ ok: true, site: code });
}
```

**What to add in `renderPipelineComparePage` (in the `<header>` meta section):**
```html
<button onclick="resetCursor()" style="margin-left:10px;padding:3px 10px;border-radius:6px;font-size:12px;cursor:pointer;background:#3d1a1a;border:1px solid #7f1d1d;color:#fca5a5">
  Reset cursor
</button>
<script>
async function resetCursor() {
  if (!confirm('Cursor sıfırlanacak — son batch yeniden işlenecek. Emin misiniz?')) return;
  const r = await fetch('/admin/pipeline/reset-cursor', {method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({site:'${esc(site.short_code)}'})});
  if (r.ok) { alert('Cursor sıfırlandı. Worker sonraki saatte yeniden işleyecek.'); location.reload(); }
}
</script>
```

**Acceptance criterion:** After clicking "Reset cursor" on `/admin/pipeline?site=BJK`, the cursor KV key is deleted. Next hourly run reprocesses from the last-seen timestamp.

- [ ] Add `/reset-cursor` endpoint in `worker-story-agent.js`
- [ ] Add `/admin/pipeline/reset-cursor` proxy endpoint in `worker-fetch-agent.js`
- [ ] Add reset button + JS to `renderPipelineComparePage`
- [ ] `git commit -m "feat: cursor reset button in /admin/pipeline"`

---

### Task B3: Delta inspection — persist skip reasons to KV ring buffer

**Files:**
- Modify: `worker-story-agent.js:123–174` (main processing loop)

**Context:** When `rulesPreFilterDelta` or `detectDeltaLLM` rejects an item (`confirmingSkip`), the reason is only logged to console — invisible in the admin UI. During the observation window you need to audit *why* items are being skipped to validate the pre-filter quality.

**What to add:**

At the top of `processSiteMethodB` after `tally` declaration, add a ring buffer array:
```js
const deltaLog = []; // ring buffer of last 20 delta decisions per site
```

In the loop, wherever a decision is made, push a compact entry. After the `rulesPreFilterDelta` call:
```js
// confirming skip (rules)
deltaLog.push({ ts: item.created_at, title: (item.title||'').slice(0,60), decision: 'rules_skip', reasons: pre.reasons });
```

After `detectDeltaLLM` returns:
```js
// LLM decision
deltaLog.push({
  ts: item.created_at,
  title: (item.title||'').slice(0,60),
  decision: delta?.material ? 'material' : 'llm_skip',
  trigger: delta?.trigger || null,
  conflict: delta?.new_track?.conflict || false,
});
```

After the loop, persist the ring buffer (last 20 entries, newest first):
```js
const deltaLogKey = `methodb:delta_log:${code}`;
let prevLog = [];
try { prevLog = JSON.parse((await env.PITCHOS_CACHE.get(deltaLogKey)) || '[]'); } catch {}
const merged = [...deltaLog.reverse(), ...prevLog].slice(0, 20);
await env.PITCHOS_CACHE.put(deltaLogKey, JSON.stringify(merged), { expirationTtl: 7 * 86400 });
```

**What to add in `renderPipelineComparePage`:**

Read the delta log in the `/admin/pipeline` GET handler:
```js
const deltaLog = JSON.parse((await env.PITCHOS_CACHE.get(`methodb:delta_log:${code}`)) || '[]');
```

Pass it to the render function and display as a collapsible table below the tally strip:
```html
<details style="margin:10px 14px;font-size:12px">
  <summary style="cursor:pointer;color:#7c9adb">Delta log — son ${deltaLog.length} karar</summary>
  <table style="width:100%;border-collapse:collapse;margin-top:8px">
    <tr style="color:#9aa4b2"><th>Zaman</th><th>Başlık</th><th>Karar</th><th>Neden</th></tr>
    ${deltaLog.map(d => `<tr>
      <td style="white-space:nowrap;padding:3px 6px">${d.ts?.slice(11,16)||''}</td>
      <td style="padding:3px 6px;max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(d.title)}</td>
      <td style="padding:3px 6px;color:${d.decision==='material'?'#4ade80':d.decision.includes('skip')?'#f87171':'#cbd5e1'}">${d.decision}${d.conflict?' ⚠conflict':''}</td>
      <td style="padding:3px 6px;color:#8b95a4">${Array.isArray(d.reasons)?d.reasons.join(', '):(d.trigger||'')}</td>
    </tr>`).join('')}
  </table>
</details>
```

**Acceptance criterion:** After one worker run, `/admin/pipeline?site=BJK` shows a "Delta log" collapsible with entries for each decision (rules_skip, llm_skip, material), with reasons and conflict flag visible.

- [ ] Add `deltaLog` array to `processSiteMethodB`
- [ ] Push entries in rules pre-filter branch
- [ ] Push entries in detectDeltaLLM branch
- [ ] Persist ring buffer after loop (TTL 7 days)
- [ ] Read delta log in `/admin/pipeline` GET handler
- [ ] Add collapsible delta log table to `renderPipelineComparePage`
- [ ] `git commit -m "feat: delta inspection ring buffer + pipeline delta log table"`

---

## GROUP C — Method B: Post-Observation Polish
*Effort: ~3h total. Execute AFTER the 5-day observation window — you need real data to make these useful.*
*Prerequisite: Group B deployed and at least one full observation cycle complete.*

---

### Task C1: Topic browser tab in `/admin/pipeline`

**Context:** Method B writes `topics` and `phases` rows but there is no UI to inspect them. After observation you'll want to see open topics, their `claim_tracks` state, and how many phases each has generated.

**What to add in the `/admin/pipeline` GET handler (~line 3222):**
```js
// Read open topics for this site
const topics = await supabase(env, 'GET',
  `/rest/v1/topics?site_id=eq.${currentSite.id}&state=eq.open&order=last_event_at.desc&limit=30` +
  `&select=id,title,story_type,entities,claim_tracks,last_event_at`
) || [];
const topicIds = topics.map(t => t.id);
const phaseCounts = topicIds.length ? await supabase(env, 'GET',
  `/rest/v1/phases?topic_id=in.(${topicIds.join(',')})&select=topic_id,count()`,
  null, { 'Prefer': 'count=exact' }
) || [] : [];
const phaseCountMap = Object.fromEntries((phaseCounts || []).map(r => [r.topic_id, r.count]));
```

**In `renderPipelineComparePage`:** add a third column or a tab below the compare columns showing a topic list:
```html
<div style="padding:14px;border-top:1px solid #232a36">
  <h2 style="font-size:13px;color:#9aa4b2;margin:0 0 8px">Açık Konular (${topics.length})</h2>
  ${topics.length === 0 ? '<div style="color:#666;font-size:12px">Henüz konu yok — worker çalışmamış veya methodb disabled</div>' :
    topics.map(t => `<div style="background:#161a22;border:1px solid #232a36;border-radius:8px;padding:8px 12px;margin-bottom:6px;font-size:12px">
      <div style="font-weight:600">${esc((t.title||'').slice(0,80))}</div>
      <div style="color:#8b95a4;margin-top:3px">${esc(t.story_type)} · ${phaseCountMap[t.id]||0} faz · ${rel(t.last_event_at)}</div>
      <div style="color:#4b5563;margin-top:3px;font-size:11px">tracks: ${esc(JSON.stringify(Object.keys(t.claim_tracks||{})))}</div>
    </div>`).join('')
  }
</div>
```

**Acceptance criterion:** `/admin/pipeline?site=BJK` shows open topics with phase counts after at least one worker run. Empty state message shown when no topics exist yet.

---

### Task C2: Shadow article full-body preview

**Context:** `/admin/pipeline` shows title + meta for shadow articles but clicking them does nothing. You need to read `full_body` and see the `topic_id`/`trigger` that produced the article to evaluate synthesis quality.

**What to add in `renderPipelineComparePage`:**

Make each shadow card clickable — show a modal with full_body:
```js
const shadowCard = (a) => `<div class="c" onclick='showPreview(${JSON.stringify({
  title: a.title,
  body: (a.full_body||'').slice(0, 3000),
  topic: a._methodb?.topic_id || null,
  trigger: a._methodb?.trigger || null,
  slug: a.slug,
})})' style="cursor:pointer">
  <div class="t">${esc(a.title)}</div>
  <div class="m">${esc(a.source_name||'')} · ${esc(a.publish_mode||'')} · NVS ${a.nvs||0} · ${rel(a.published_at)} · trigger:${esc(a._methodb?.trigger||'?')}</div>
</div>`;
```

Add modal + JS at the bottom of the page:
```html
<div id="preview-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;overflow:auto;padding:40px">
  <div style="max-width:700px;margin:0 auto;background:#1a2030;border-radius:12px;padding:24px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">
      <h2 id="pm-title" style="font-size:16px;margin:0"></h2>
      <button onclick="document.getElementById('preview-modal').style.display='none'" style="background:none;border:none;color:#9aa4b2;font-size:20px;cursor:pointer">✕</button>
    </div>
    <div id="pm-meta" style="font-size:11px;color:#8b95a4;margin-bottom:12px"></div>
    <div id="pm-body" style="font-size:14px;line-height:1.7;white-space:pre-wrap"></div>
  </div>
</div>
<script>
function showPreview(d) {
  document.getElementById('pm-title').textContent = d.title;
  document.getElementById('pm-meta').textContent = 'topic:' + (d.topic||'?') + ' · trigger:' + (d.trigger||'?') + ' · slug:' + (d.slug||'?');
  document.getElementById('pm-body').textContent = d.body;
  document.getElementById('preview-modal').style.display = 'block';
}
</script>
```

**Acceptance criterion:** Clicking a shadow article card opens a modal with `full_body`, `topic_id`, and `trigger` visible. Modal dismisses on ✕ click.

---

### Task C3: Financials sparkline in `/admin/pipeline`

**Context:** `/admin/pipeline` shows `methodb_month_cost_usd` as a single number. The daily spend trajectory from `/admin/cost?json=1` would tell you immediately if Method B is burning budget abnormally fast.

**What to add in `/admin/pipeline` GET handler:**
```js
const costData = JSON.parse((await env.PITCHOS_CACHE.get(`cost:${new Date().toISOString().slice(0,7)}`)) || '0');
// daily breakdown lives in /admin/cost?json=1 response — make an internal call
// simplest: read the daily KV keys directly
const today = new Date();
const dailyCosts = [];
for (let i = 6; i >= 0; i--) {
  const d = new Date(today); d.setDate(d.getDate() - i);
  const key = `cost:day:${d.toISOString().slice(0,10)}`;
  const val = parseFloat((await env.PITCHOS_CACHE.get(key)) || '0');
  dailyCosts.push({ day: d.toISOString().slice(5,10), usd: val });
}
```

**In `renderPipelineComparePage` header meta section**, add a mini inline SVG sparkline:
```html
<div style="margin-top:8px">
  <span style="font-size:11px;color:#9aa4b2">Günlük harcama (7g): </span>
  <svg width="120" height="24" style="vertical-align:middle">
    ${dailyCosts.map((d, i) => {
      const maxVal = Math.max(...dailyCosts.map(x => x.usd), 0.01);
      const h = Math.max(2, Math.round((d.usd / maxVal) * 20));
      const x = 4 + i * 17;
      return `<rect x="${x}" y="${24 - h}" width="12" height="${h}" fill="#2563eb" rx="2" title="${d.day}: $${d.usd.toFixed(4)}"/>`;
    }).join('')}
  </svg>
  <span style="font-size:11px;color:#9aa4b2">(cap: $${cap_usd}/mo)</span>
</div>
```

**Acceptance criterion:** `/admin/pipeline` shows a 7-bar sparkline of daily Claude spend. Bars scale to the highest daily value seen in the last 7 days.

---

## GROUP D — Consolidation (Low Priority, Post-G2M)
*Effort: ~4h total. No urgency — these are UX improvements, not correctness fixes. Do after Method B cutover.*

---

### Task D1: Merge `/admin/season-notes` into `/admin/notes`

**Context:** Two overlapping editorial notes APIs with separate KV storage:
- `/admin/notes` → `editorial_notes` rows in Supabase, managed via the `/admin` home page UI
- `/admin/season-notes` → `season:notes:{team_id}` KV keys, no UI

**Plan:** Add a `season` scope to the existing `/admin/notes` system. Read `season:notes:{team_id}` in the notes GET handler and return it under `scope: 'season'`. Add a UI card in `/admin` home page to edit season notes inline. Remove the separate `/admin/season-notes` endpoint.

**Acceptance criterion:** Season notes are editable from `/admin` home. `/admin/season-notes` returns a redirect to `/admin#season-notes`. Existing KV keys are migrated on first load.

---

### Task D2: Combine `/admin/sources`, `/admin/source-health`, `/admin/source-stats`

**Context:** Three pages with overlapping data:
- `/admin/sources` — CRUD for source configs, trust tiers, treatment column
- `/admin/source-health` — per-source health status (dead/noisy/idle/healthy)
- `/admin/source-stats` — publication counts per source

**Plan:** Collapse all three into tabs within a new `renderSourcesDashboardPage` function. The existing `/admin/sources/ui` GET returns the CRUD tab (tab 0). `/admin/source-health` data becomes tab 1. `/admin/source-stats` data becomes tab 2. All three routes redirect to `/admin/sources?tab=N`.

**Acceptance criterion:** All source data accessible from `/admin/sources` with tab navigation. Individual old URLs redirect correctly. No data regression.

---

## Execution Order

```
Week 0 (before deploy):   A1 → A2 → A3 → A4 (30 min)
Deploy story worker:       wrangler deploy -c wrangler-story.toml
Week 1 (pre-observation): B1 → B2 → B3 (2h)
Arm + observe 5 days
Week 2+ (after data):     C1 → C2 → C3 (3h)
Post-G2M:                 D1 → D2 (4h)
```
