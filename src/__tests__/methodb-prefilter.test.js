import { describe, it, expect } from 'vitest';
import { rulesPreFilterDelta, routeNewsMode } from '../../worker-story-agent.js';

// The rules pre-filter is the cost guardrail (design §6.3): only a `possibleDelta` is
// allowed to spend a Haiku diff in Step 2; pure confirmations must stay free.
describe('Method B — rulesPreFilterDelta (cost guardrail)', () => {
  it('treats the first contribution (no prior track) as an initial delta', () => {
    const r = rulesPreFilterDelta(null, { numbers: {} }, { title: 'X ile ilgileniyor' });
    expect(r.possibleDelta).toBe(true);
    expect(r.reasons).toContain('initial');
  });

  it('skips a true confirmation — same status + same values → no LLM spend', () => {
    const r = rulesPreFilterDelta(
      { status: 'görüşme', numbers: { transfer_fee: 5 }, dates: {} },
      { numbers: { transfer_fee: 5 }, dates: {} },
      { title: 'Görüşmeler sürüyor', summary: 'aynı haber' },
    );
    expect(r.possibleDelta).toBe(false);
    expect(r.reasons).toEqual([]);
  });

  it('flags a status change (görüşme → imza)', () => {
    const r = rulesPreFilterDelta({ status: 'görüşme' }, {}, { title: 'Resmi imza atıldı' });
    expect(r.reasons).toContain('status_change');
  });

  it('flags a new number the track does not yet hold (fee 5 → 7)', () => {
    const r = rulesPreFilterDelta(
      { status: 'anlaşma', numbers: { transfer_fee: 5 } },
      { numbers: { transfer_fee: 7 } },
      { title: 'anlaşma' },
    );
    expect(r.reasons).toContain('new_number');
  });

  it('flags contradiction markers (iptal / yalanladı)', () => {
    const r = rulesPreFilterDelta({ status: 'anlaşma' }, {}, { title: 'Transfer iptal, kulüp yalanladı' });
    expect(r.reasons).toContain('contradiction_marker');
  });
});

describe('Method B — routeNewsMode (EVENT/ACCRETIVE router)', () => {
  it('routes match_result / squad facts to EVENT (fire now)', () => {
    expect(routeNewsMode({ title: 'Maç sonucu' }, { story_type: 'match_result' })).toBe('event');
    expect(routeNewsMode({ title: 'İlk 11 açıklandı' }, { story_type: 'squad' })).toBe('event');
  });

  it('routes official-announcement keywords to EVENT even without an event story_type', () => {
    expect(routeNewsMode({ title: 'Beşiktaş resmen açıkladı' }, { story_type: 'transfer' })).toBe('event');
  });

  it('routes developing rumors to ACCRETIVE', () => {
    expect(routeNewsMode({ title: 'transfer söylentisi', summary: 'iddiaya göre' }, { story_type: 'transfer' })).toBe('accretive');
  });
});
