-- 0014_method_b.sql — Method B (fact-based news generator) shadow pipeline.
-- ADDITIVE ONLY. Legacy tables (content_items, stories, facts) are not altered
-- destructively, so the legacy pipeline keeps running and rollback needs no downgrade.
-- See docs/method-b-design.md.

-- ─── Topics: the durable correlation anchor ──────────────────────────────────
-- Supersedes the publication/confidence roles of `stories`; `stories` is left intact
-- for the legacy pipeline during the dual-run window.
create table if not exists topics (
  id               uuid primary key default gen_random_uuid(),
  site_id          int  not null,
  title            text,                           -- primary headline of the topic (from first correlating item)
  story_type       text not null,                 -- transfer/injury/disciplinary/contract/institutional/match/other
  news_mode        text not null default 'accretive', -- 'event' | 'accretive'
  entities         jsonb not null default '{}',
  importance       int  not null default 50,       -- editorial weight → publish threshold & ranking
  parent_topic_ids uuid[] default '{}',            -- multi-parent DAG (e.g. injury ∈ player ∩ match)
  claim_tracks     jsonb not null default '{}',    -- { track_key: {status, fee, dates, confidence} }
  state            text not null default 'open',   -- open | dormant | closed
  created_at       timestamptz default now(),
  last_event_at    timestamptz default now()
);
create index if not exists topics_site_state_idx on topics (site_id, state, last_event_at desc);

-- ─── Topic edges: the graph (trunk-default + 3 edge types) ────────────────────
create table if not exists topic_edges (
  id            uuid primary key default gen_random_uuid(),
  from_topic_id uuid not null references topics(id) on delete cascade,
  to_topic_id   uuid not null references topics(id) on delete cascade,
  edge_type     text not null,                     -- 'child_of' | 'branch_of' | 'sequel_of'
  created_at    timestamptz default now()
);
create index if not exists topic_edges_from_idx on topic_edges (from_topic_id);
create index if not exists topic_edges_to_idx   on topic_edges (to_topic_id);

-- ─── Phases: a newsworthy delta on a topic/track → licenses article(s) ────────
create table if not exists phases (
  id               uuid primary key default gen_random_uuid(),
  topic_id         uuid not null references topics(id) on delete cascade,
  track_key        text,                           -- which claim-track moved (null = whole topic)
  seq              int  not null,                  -- phase number within topic
  trigger          text not null,                  -- 'initial' | 'update' | 'contradiction' | 'event'
  delta            jsonb,                          -- what changed
  opened_by_fact_id uuid,                          -- references facts(id)
  opened_at        timestamptz default now()
);
create index if not exists phases_topic_idx on phases (topic_id, seq);

-- ─── content_items linkage + the pipeline serve/cost tag ──────────────────────
alter table content_items add column if not exists topic_id uuid;
alter table content_items add column if not exists phase_id uuid;
alter table content_items add column if not exists pipeline text default 'legacy'; -- legacy | methodb
create index if not exists content_items_pipeline_idx on content_items (site_id, pipeline, created_at desc);
