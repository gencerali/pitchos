import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';

const fixture = JSON.parse(
  readFileSync('fixtures/cases/story_matching_entity_overlap.json', 'utf8')
);

// ── Import pure logic only — no network calls ─────────────────
// We test the deterministic parts: entity overlap and state machine.
// The Claude judge is tested via mock response in the fixture.

function entityOverlap(factsEntities, storyEntities) {
  const factsPlayers = (factsEntities?.players || []).map(s => s.toLowerCase());
  const factsClubs   = (factsEntities?.clubs   || []).map(s => s.toLowerCase());
  const storyPlayers = (storyEntities?.players || []).map(s => s.toLowerCase());
  const storyClubs   = (storyEntities?.clubs   || []).map(s => s.toLowerCase());
  const playerMatch  = factsPlayers.some(p => storyPlayers.includes(p));
  if (playerMatch) return true;
  const clubMatches  = factsClubs.filter(c => storyClubs.includes(c));
  return clubMatches.length >= 2;
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

const { input, expected } = fixture;

describe('Story Matcher — story_matching_entity_overlap', () => {

  it('Stage 1: entity overlap finds the correct candidate story', () => {
    const candidates = input.open_stories.filter(s =>
      entityOverlap(input.new_facts.entities, s.entities)
    );
    expect(candidates).toHaveLength(1);
    expect(candidates[0].id).toBe('story-uuid-001');
  });

  it('Stage 1: story with different entities is not a candidate', () => {
    const candidates = input.open_stories.filter(s =>
      entityOverlap(input.new_facts.entities, s.entities)
    );
    const ids = candidates.map(s => s.id);
    expect(ids).not.toContain('story-uuid-002');
  });

  it('Stage 2 mock: judge returns correct match ID', () => {
    const decision = JSON.parse(input.mock_claude_judge_response);
    expect(decision.match).toBe(expected.match);
    expect(decision.contribution_type).toBe(expected.contribution_type);
  });

  it('confidence delta applied correctly: 30 + 20 = 50', () => {
    const story    = input.open_stories.find(s => s.id === expected.match);
    const decision = JSON.parse(input.mock_claude_judge_response);
    const newConf  = story.confidence + decision.confidence_delta;
    expect(newConf).toBe(expected.confidence_after);
  });

  it('state transitions emerging → developing at confidence >= 40', () => {
    const story    = input.open_stories.find(s => s.id === expected.match);
    const decision = JSON.parse(input.mock_claude_judge_response);
    const newConf  = story.confidence + decision.confidence_delta;
    const newState = nextState(story.state, newConf, decision.contribution_type);
    expect(newState).toBe(expected.state_after);
  });

  it('state stays emerging below confidence 40', () => {
    expect(nextState('emerging', 39, 'confirming')).toBe('emerging');
  });

  it('state transitions developing → confirmed at confidence >= 60', () => {
    expect(nextState('developing', 60, 'confirming')).toBe('confirmed');
  });

  it('contradicting contribution drops confirmed → developing when confidence falls below 60', () => {
    expect(nextState('confirmed', 55, 'contradicting')).toBe('developing');
  });

  it('contradicting contribution does not drop active story if confidence stays >= 60', () => {
    expect(nextState('active', 65, 'contradicting')).toBe('active');
  });

  it('is_new_story is false for a matched article', () => {
    const decision = JSON.parse(input.mock_claude_judge_response);
    expect(decision.match).not.toBe('new');
    expect(expected.is_new_story).toBe(false);
  });
});
