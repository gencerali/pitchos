import { describe, it, expect } from 'vitest';
import { getServedArticles } from '../publisher.js';

// Minimal KV-backed env mock.
const mkEnv = (kv) => ({ PITCHOS_CACHE: { get: async (k) => (k in kv ? kv[k] : null) } });

const legacy = JSON.stringify([{ slug: 'legacy-1' }]);
const methodbReady = JSON.stringify({ ready: true, articles: [{ slug: 'mb-1' }] });

describe('getServedArticles — blue/green serving resolver (cutover seam)', () => {
  it('defaults to legacy when no pointer is set', async () => {
    const env = mkEnv({ 'articles:BJK': legacy });
    expect((await getServedArticles(env, 'BJK'))[0].slug).toBe('legacy-1');
  });

  it('serves legacy when pointer=legacy (even if methodb pool is ready)', async () => {
    const env = mkEnv({ 'pipeline:active:BJK': 'legacy', 'articles:BJK': legacy, 'articles:BJK:methodb': methodbReady });
    expect((await getServedArticles(env, 'BJK'))[0].slug).toBe('legacy-1');
  });

  it('serves methodb when pointer=methodb and the shadow pool is ready', async () => {
    const env = mkEnv({ 'pipeline:active:BJK': 'methodb', 'articles:BJK': legacy, 'articles:BJK:methodb': methodbReady });
    expect((await getServedArticles(env, 'BJK'))[0].slug).toBe('mb-1');
  });

  it('cold-start gate: falls back to legacy when methodb selected but not ready', async () => {
    const env = mkEnv({ 'pipeline:active:BJK': 'methodb', 'articles:BJK': legacy, 'articles:BJK:methodb': JSON.stringify({ ready: false, articles: [] }) });
    expect((await getServedArticles(env, 'BJK'))[0].slug).toBe('legacy-1');
  });

  it('cold-start gate: falls back to legacy when methodb pool is empty', async () => {
    const env = mkEnv({ 'pipeline:active:BJK': 'methodb', 'articles:BJK': legacy, 'articles:BJK:methodb': JSON.stringify({ ready: true, articles: [] }) });
    expect((await getServedArticles(env, 'BJK'))[0].slug).toBe('legacy-1');
  });

  it('returns [] when nothing is cached', async () => {
    expect(await getServedArticles(mkEnv({}), 'BJK')).toEqual([]);
  });
});
