-- Migration 0006 — normalize story_type on existing stories rows
-- Run in Supabase SQL editor.
-- Maps 35+ free-text Claude-generated types back to the 8-item controlled set.
-- Safe to run multiple times (idempotent WHERE clauses).

UPDATE stories SET story_type = 'transfer'
WHERE story_type NOT IN ('transfer','injury','disciplinary','contract','institutional','match_result','squad','other')
  AND (story_type ILIKE '%transfer%' OR story_type ILIKE '%signing%' OR story_type ILIKE '%loan%');

UPDATE stories SET story_type = 'injury'
WHERE story_type NOT IN ('transfer','injury','disciplinary','contract','institutional','match_result','squad','other')
  AND (story_type ILIKE '%injur%' OR story_type ILIKE '%medical%' OR story_type ILIKE '%recovery%');

UPDATE stories SET story_type = 'disciplinary'
WHERE story_type NOT IN ('transfer','injury','disciplinary','contract','institutional','match_result','squad','other')
  AND (story_type ILIKE '%disciplin%' OR story_type ILIKE '%suspension%' OR story_type ILIKE '%ban%' OR story_type ILIKE '%fine%');

UPDATE stories SET story_type = 'contract'
WHERE story_type NOT IN ('transfer','injury','disciplinary','contract','institutional','match_result','squad','other')
  AND (story_type ILIKE '%contract%' OR story_type ILIKE '%renewal%' OR story_type ILIKE '%extension%' OR story_type ILIKE '%buyout%');

UPDATE stories SET story_type = 'institutional'
WHERE story_type NOT IN ('transfer','injury','disciplinary','contract','institutional','match_result','squad','other')
  AND (story_type ILIKE '%institution%' OR story_type ILIKE '%management%' OR story_type ILIKE '%ownership%'
       OR story_type ILIKE '%executive%' OR story_type ILIKE '%appointment%' OR story_type ILIKE '%managerial%');

UPDATE stories SET story_type = 'match_result'
WHERE story_type NOT IN ('transfer','injury','disciplinary','contract','institutional','match_result','squad','other')
  AND (story_type ILIKE '%match%' OR story_type ILIKE '%result%' OR story_type ILIKE '%cup%');

UPDATE stories SET story_type = 'squad'
WHERE story_type NOT IN ('transfer','injury','disciplinary','contract','institutional','match_result','squad','other')
  AND (story_type ILIKE '%squad%' OR story_type ILIKE '%lineup%' OR story_type ILIKE '%formation%');

-- Everything else → other
UPDATE stories SET story_type = 'other'
WHERE story_type NOT IN ('transfer','injury','disciplinary','contract','institutional','match_result','squad','other');

-- Verify result
SELECT story_type, COUNT(*) FROM stories GROUP BY story_type ORDER BY count DESC;
