-- 0015_facts_delta_type.sql
-- Additive: semantic delta classification on facts, set by classifyStoryType() at
-- extraction time. Replaces the JS keyword pre-filter + detectDeltaLLM Haiku call
-- in the Method B story worker (design §6.3).
--
-- delta_type: milestone | statement | decision | contradiction | development | routine
-- news_mode:  event | accretive

alter table facts add column if not exists delta_type text;
alter table facts add column if not exists news_mode  text;

-- Partial index: story worker queries only actionable (non-routine) facts.
create index if not exists facts_delta_type_idx
  on facts (delta_type)
  where delta_type is not null and delta_type <> 'routine';
