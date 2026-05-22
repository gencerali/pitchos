import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const fixture = JSON.parse(
  readFileSync('fixtures/cases/confidence_scoring.json', 'utf8')
);

const DELTA = fixture.deltas;

function applyDelta(fromConfidence, delta) {
  return Math.max(0, Math.min(100, fromConfidence + delta));
}

function getDelta(contributionType, trustTier) {
  if (contributionType === 'initial') {
    return trustTier === 'official' ? DELTA.official_initial : DELTA.initial;
  }
  return DELTA[contributionType] ?? 0;
}

function initialState(confidence) {
  if (confidence >= 60) return 'confirmed';
  if (confidence >= 40) return 'developing';
  return 'emerging';
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

describe('Confidence Scoring — single contributions', () => {
  for (const c of fixture.single_contribution_cases) {
    it(c.label, () => {
      const delta      = getDelta(c.contribution_type, c.trust_tier);
      const confidence = applyDelta(c.from_confidence, delta);
      expect(delta).toBe(c.expected_delta);
      expect(confidence).toBe(c.expected_confidence);
      if (c.expected_initial_state !== undefined) {
        expect(initialState(confidence)).toBe(c.expected_initial_state);
      }
    });
  }
});

describe('Confidence Scoring — multi-contribution sequence (Rashica transfer)', () => {
  const seq = fixture.multi_contribution_sequence;

  it('sequence has 5 steps', () => {
    expect(seq.steps).toHaveLength(5);
  });

  it('each step produces the correct confidence and state', () => {
    let confidence = 0;
    let state      = null;
    let generationCount = 0;

    for (const step of seq.steps) {
      const delta    = getDelta(step.contribution_type, step.trust_tier);
      confidence     = applyDelta(confidence, delta);
      state          = state === null
        ? initialState(confidence)
        : nextState(state, confidence, step.contribution_type);

      // After createStory, state is set via initialState
      if (step.contribution_type === 'initial') {
        state = initialState(confidence);
      }

      expect(confidence).toBe(step.confidence_after);
      expect(state).toBe(step.state_after);

      // Generation fires on confirmed transition, then advances story to active
      if (state === 'confirmed' && step.generation_triggered) {
        generationCount++;
        state = 'active';
      }
    }

    expect(generationCount).toBe(1);
    expect(confidence).toBe(seq.final_confidence);
    expect(state).toBe(seq.final_state);
  });

  it('generation triggered exactly at step 3 (confirmed transition)', () => {
    expect(seq.generation_triggered_at_step).toBe(3);
    expect(seq.steps[2].generation_triggered).toBe(true);
    expect(seq.steps[3].generation_triggered).toBeUndefined();
    expect(seq.steps[4].generation_triggered).toBeUndefined();
  });

  it('final state is active after 5 contributions', () => {
    expect(seq.final_state).toBe('active');
    expect(seq.final_confidence).toBe(100);
  });
});
