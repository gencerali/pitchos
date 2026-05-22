import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const fixture = JSON.parse(
  readFileSync('fixtures/cases/rashica_transfer_5_contribs.json', 'utf8')
);

function entityOverlap(factsEntities, storyEntities) {
  const factsPlayers = (factsEntities?.players || []).map(s => s.toLowerCase());
  const factsClubs   = (factsEntities?.clubs   || []).map(s => s.toLowerCase());
  const storyPlayers = (storyEntities?.players || []).map(s => s.toLowerCase());
  const storyClubs   = (storyEntities?.clubs   || []).map(s => s.toLowerCase());
  if (factsPlayers.some(p => storyPlayers.includes(p))) return true;
  return factsClubs.filter(c => storyClubs.includes(c)).length >= 2;
}

function nextState(currentState, newConfidence, contributionType) {
  if (contributionType === 'contradicting' && newConfidence < 15) return 'debunked';
  if (contributionType === 'contradicting' && newConfidence < 60) {
    if (currentState === 'confirmed' || currentState === 'active') return 'developing';
  }
  if ((currentState === 'emerging' || currentState === 'developing') && newConfidence >= 60) return 'confirmed';
  if (currentState === 'emerging' && newConfidence >= 40) return 'developing';
  return currentState;
}

function applyDelta(confidence, delta) {
  return Math.max(0, Math.min(100, confidence + delta));
}

describe('rashica_transfer_5_contribs — Slice 2 done-when criterion', () => {
  const { contributions, invariants } = fixture;

  it('fixture has exactly 5 contributions', () => {
    expect(contributions).toHaveLength(5);
  });

  it('step 1: first article creates a new story (no open stories)', () => {
    const step = contributions[0];
    expect(step.mock_open_stories).toHaveLength(0);
    expect(step.mock_judge_response.match).toBe('new');
    expect(step.expected.is_new_story).toBe(true);
    expect(step.expected.state_after).toBe('emerging');
    expect(step.expected.generation_triggered).toBe(false);
  });

  it('steps 2-5: all contributions match the same story (no new stories spawned)', () => {
    for (const step of contributions.slice(1)) {
      expect(step.mock_judge_response.match).toBe('story-rashica-001');
      expect(step.expected.is_new_story).toBe(false);
      expect(step.expected.matched_story_id).toBe('story-rashica-001');
    }
  });

  it('entity fingerprint matches contributions 2-5 to story-rashica-001', () => {
    for (const step of contributions.slice(1)) {
      const candidates = step.mock_open_stories.filter(s =>
        entityOverlap(step.extracted_facts.entities, s.entities)
      );
      expect(candidates.map(s => s.id)).toContain('story-rashica-001');
    }
  });

  it('confidence builds correctly across all 5 steps', () => {
    let confidence = 0;
    for (const step of contributions) {
      confidence = applyDelta(confidence, step.mock_judge_response.confidence_delta);
      expect(confidence).toBe(step.expected.confidence_after);
    }
  });

  it('state machine progresses correctly across all 5 steps', () => {
    let confidence = 0;
    let state = null;

    for (const step of contributions) {
      confidence = applyDelta(confidence, step.mock_judge_response.confidence_delta);

      if (step.expected.is_new_story) {
        state = step.expected.state_after;
      } else {
        const prevState = step.mock_open_stories[0].state;
        state = nextState(prevState, confidence, step.mock_judge_response.contribution_type);
      }

      expect(state).toBe(step.expected.state_after);

      // Generation fires on confirmed → advance to active
      if (state === 'confirmed' && step.expected.generation_triggered) {
        state = 'active';
      }
    }
  });

  it('generation fires exactly once — at step 3 (confirmed transition)', () => {
    const generationSteps = contributions.filter(s => s.expected.generation_triggered);
    expect(generationSteps).toHaveLength(1);
    expect(generationSteps[0].step).toBe(3);
    expect(generationSteps[0].expected.state_after).toBe('confirmed');
  });

  it('generation does not fire again at steps 4 and 5 (story is already active)', () => {
    expect(contributions[3].expected.generation_triggered).toBe(false);
    expect(contributions[4].expected.generation_triggered).toBe(false);
    expect(contributions[3].expected.state_after).toBe('active');
    expect(contributions[4].expected.state_after).toBe('active');
  });

  it('invariant: exactly 1 story created, 1 Kartalix article generated', () => {
    expect(invariants.stories_created).toBe(1);
    expect(invariants.kartalix_articles_generated).toBe(1);
  });

  it('invariant: final state is active at confidence 100', () => {
    expect(invariants.final_state).toBe('active');
    expect(invariants.final_confidence).toBe(100);
    expect(invariants.final_story_id).toBe('story-rashica-001');
  });
});
