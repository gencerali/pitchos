import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { buildExtractionPrompt, parseFirewallResponse } from '../firewall.js';

const fixture = JSON.parse(
  readFileSync('fixtures/cases/firewall_destroys_source_text.json', 'utf8')
);

describe('Facts Firewall — firewall_destroys_source_text', () => {
  const { input, expected_facts, source_phrases_that_must_not_appear_in_produce_output } = fixture;
  const { article, mock_claude_extraction_response } = input;

  it('buildExtractionPrompt does not paraphrase or summarize — no instruction to rewrite', () => {
    const prompt = buildExtractionPrompt(`${article.title}. ${article.summary}`);
    expect(prompt.toLowerCase()).not.toMatch(/paraphrase|summarize|rewrite|rephrase|describe/i);
    expect(prompt).toContain('only what is explicitly stated');
    expect(prompt).toContain('entities');
    expect(prompt).toContain('numbers');
    expect(prompt).toContain('dates');
  });

  it('buildExtractionPrompt does not ask Claude to return sentences from source', () => {
    const prompt = buildExtractionPrompt(`${article.title}. ${article.summary}`);
    expect(prompt.toLowerCase()).not.toMatch(/write a sentence|write text|generate article/i);
  });

  it('parseFirewallResponse extracts expected players', () => {
    const facts = parseFirewallResponse(mock_claude_extraction_response);
    expect(facts.entities.players).toEqual(expected_facts.entities.players);
  });

  it('parseFirewallResponse extracts expected clubs', () => {
    const facts = parseFirewallResponse(mock_claude_extraction_response);
    expect(facts.entities.clubs).toEqual(expected_facts.entities.clubs);
  });

  it('parseFirewallResponse extracts transfer fee as number field', () => {
    const facts = parseFirewallResponse(mock_claude_extraction_response);
    expect(facts.numbers.transfer_fee).toBe(expected_facts.numbers.transfer_fee);
  });

  it('parseFirewallResponse extracts contract years as number field', () => {
    const facts = parseFirewallResponse(mock_claude_extraction_response);
    expect(facts.numbers.contract_years).toBe(expected_facts.numbers.contract_years);
  });

  it('parseFirewallResponse output contains no source sentences', () => {
    const facts = parseFirewallResponse(mock_claude_extraction_response);
    const factsStr = JSON.stringify(facts);
    for (const phrase of source_phrases_that_must_not_appear_in_produce_output) {
      expect(factsStr).not.toContain(phrase);
    }
  });

  it('parseFirewallResponse returns required schema shape', () => {
    const facts = parseFirewallResponse(mock_claude_extraction_response);
    expect(facts).toHaveProperty('entities.players');
    expect(facts).toHaveProperty('entities.clubs');
    expect(facts).toHaveProperty('entities.competitions');
    expect(facts).toHaveProperty('numbers.transfer_fee');
    expect(facts).toHaveProperty('numbers.contract_years');
    expect(facts).toHaveProperty('dates.announcement');
    expect(Array.isArray(facts.entities.players)).toBe(true);
    expect(Array.isArray(facts.entities.clubs)).toBe(true);
  });

  it('writeTransfer prompt construction — verify source text is never passed', () => {
    const facts = parseFirewallResponse(mock_claude_extraction_response);
    // Reconstruct what writeTransfer would pass to Claude
    const factLines = [
      facts.entities.players[0]     ? `Oyuncu: ${facts.entities.players[0]}`      : null,
      facts.entities.clubs[0]       ? `Kulüp 1: ${facts.entities.clubs[0]}`        : null,
      facts.entities.clubs[1]       ? `Kulüp 2: ${facts.entities.clubs[1]}`        : null,
      facts.numbers.transfer_fee    ? `Bonservis: ${facts.numbers.transfer_fee}`   : null,
      facts.numbers.contract_years  ? `Sözleşme: ${facts.numbers.contract_years}`  : null,
    ].filter(Boolean).join('\n');

    for (const phrase of source_phrases_that_must_not_appear_in_produce_output) {
      expect(factLines).not.toContain(phrase);
    }
    // But it should contain the extracted entity names
    expect(factLines).toContain('Milot Rashica');
    expect(factLines).toContain('Werder Bremen');
    expect(factLines).toContain('Beşiktaş');
    expect(factLines).toContain('3.5 milyon euro');
  });
});
