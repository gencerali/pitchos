import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../functions/api/_shared/auth.js', () => ({
  getUser:     vi.fn(),
  json:        (data, status = 200) => new Response(JSON.stringify(data), {
    status, headers: { 'Content-Type': 'application/json' },
  }),
  err:         (msg, status = 400) => new Response(JSON.stringify({ error: msg }), { status }),
  corsHeaders: () => new Response(null, { status: 204 }),
}));

vi.mock('../../functions/api/_shared/site.js', () => ({
  getSiteId: vi.fn(),
}));

vi.mock('../../functions/api/_shared/xp.js', async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, sbGet: vi.fn() };
});

import { getUser }   from '../../functions/api/_shared/auth.js';
import { getSiteId } from '../../functions/api/_shared/site.js';
import { sbGet }     from '../../functions/api/_shared/xp.js';
import { onRequest } from '../../functions/api/activity.js';

const U    = { id: 'u-1', email: 'test@example.com' };
const SITE = 'site-abc';
const ENV  = { SUPABASE_URL: 'https://x.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'sk' };

function makeReq(qs = '') {
  return new Request(`https://kartalix.com/api/activity${qs}`, {
    headers: { Authorization: 'Bearer tok' },
  });
}

beforeEach(() => {
  vi.mocked(getUser).mockResolvedValue(U);
  vi.mocked(getSiteId).mockResolvedValue(SITE);
  vi.mocked(sbGet).mockResolvedValue([]);
});

describe('/api/activity', () => {
  it('returns 401 without auth', async () => {
    vi.mocked(getUser).mockResolvedValueOnce(null);
    const res = await onRequest({ request: makeReq(), env: ENV });
    expect(res.status).toBe(401);
  });

  it('returns 405 for non-GET', async () => {
    const res = await onRequest({
      request: new Request('https://kartalix.com/api/activity', { method: 'POST' }),
      env: ENV,
    });
    expect(res.status).toBe(405);
  });

  it('returns events array and pagination meta', async () => {
    const events = Array.from({ length: 5 }, (_, i) => ({
      action_id: 'daily_checkin', xp_earned: 10,
      created_at: `2026-06-${18 - i}T10:00:00Z`, source_ref: null,
    }));
    vi.mocked(sbGet).mockResolvedValueOnce(events);
    const res = await onRequest({ request: makeReq(), env: ENV });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.events).toHaveLength(5);
    expect(body.offset).toBe(0);
    expect(body.limit).toBe(20);
    expect(body.has_more).toBe(false);
  });

  it('has_more is true when events.length === limit', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce(Array(20).fill({ action_id: 'x', xp_earned: 1, created_at: '', source_ref: null }));
    const body = await onRequest({ request: makeReq(), env: ENV }).then(r => r.json());
    expect(body.has_more).toBe(true);
  });

  it('respects offset param', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([]);
    await onRequest({ request: makeReq('?offset=40&limit=20'), env: ENV });
    expect(vi.mocked(sbGet)).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining('offset=40'),
    );
  });

  it('clamps limit to max 50', async () => {
    vi.mocked(sbGet).mockResolvedValueOnce([]);
    await onRequest({ request: makeReq('?limit=999'), env: ENV });
    expect(vi.mocked(sbGet)).toHaveBeenCalledWith(
      ENV,
      expect.stringContaining('limit=50'),
    );
  });

  it('returns empty events array on DB error', async () => {
    vi.mocked(sbGet).mockRejectedValueOnce(new Error('DB error'));
    const body = await onRequest({ request: makeReq(), env: ENV }).then(r => r.json());
    expect(body.events).toEqual([]);
    expect(body.has_more).toBe(false);
  });
});
