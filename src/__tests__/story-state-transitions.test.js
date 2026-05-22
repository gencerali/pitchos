import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const fixture = JSON.parse(
  readFileSync('fixtures/cases/story_state_transitions.json', 'utf8')
);

function nextState(currentState, newConfidence, contributionType) {
  if (contributionType === 'contradicting' && newConfidence < 15) return 'debunked';
  if (contributionType === 'contradicting' && newConfidence < 60) {
    if (currentState === 'confirmed' || currentState === 'active') return 'developing';
  }
  if ((currentState === 'emerging' || currentState === 'developing') && newConfidence >= 60) return 'confirmed';
  if (currentState === 'emerging' && newConfidence >= 40) return 'developing';
  return currentState;
}

function applyDelta(fromConfidence, delta) {
  return Math.max(0, Math.min(100, fromConfidence + delta));
}

describe('Story State Machine — story_state_transitions', () => {
  for (const t of fixture.transitions) {
    it(t.label, () => {
      const newConfidence = applyDelta(t.from_confidence, t.delta);
      const newState      = nextState(t.from_state, newConfidence, t.contribution_type);
      expect(newConfidence).toBe(t.expected_confidence);
      expect(newState).toBe(t.expected_state);
    });
  }
});
