-- ============================================================
-- PM Agent Migration — Slice 0
-- Run in: Supabase Dashboard → SQL Editor → New Query
-- ============================================================

create table pm_sessions (
  id             uuid primary key default gen_random_uuid(),
  created_at     timestamptz default now(),

  -- Session type
  type           text not null
                 check (type in ('kickoff','close','drift','session','pause','resume','monthly')),

  -- Week reference — ISO format e.g. '2026-W18'
  week_ref       text,

  -- Message content
  message_out    text,                    -- what the bot sent to Telegram
  message_in     text,                    -- what the user replied

  -- Structured session data
  commitments    jsonb default '[]',      -- [{text, done}] set Monday, checked Friday
  shipped        jsonb default '[]',      -- [{text}] what shipped this week
  slips          jsonb default '[]',      -- [{text, reason}] what slipped and why
  decisions      jsonb default '[]',      -- architectural decisions made this session

  -- Snapshots at session time
  next_action    text,                    -- snapshot of NEXT.md
  slice_snapshot jsonb default '{}',      -- {slice_num: status}

  -- Pause state
  pause_until    date,                    -- populated when type='pause'

  -- Trigger
  triggered_by   text default 'cron'     -- 'cron' | 'user'
);

-- Fast lookup for most recent session by type
create index pm_sessions_type_date on pm_sessions(type, created_at desc);

-- Fast lookup for active pause
create index pm_sessions_pause on pm_sessions(pause_until) where pause_until is not null;
