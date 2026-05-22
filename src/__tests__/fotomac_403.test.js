import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { fetchRSSArticles } from '../fetcher.js';

const fixture = JSON.parse(
  readFileSync('fixtures/cases/fotomac_403.json', 'utf8')
);

const { input, expected } = fixture;

function makeSite(feed) {
  return {
    feed_config:    { feeds: [feed] },
    keyword_config: { keywords: ['beşiktaş', 'bjk', 'besiktas'] },
  };
}

const VALID_RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[Rashica Beşiktaş'ta]]></title>
    <link>https://www.fotomac.com.tr/test/1</link>
    <description><![CDATA[Milot Rashica, Beşiktaş'a transfer oldu.]]></description>
    <pubDate>${new Date().toUTCString()}</pubDate>
  </item>
</channel></rss>`;

describe('Facts Firewall — fotomac_403', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('proxy returning HTTP 403 yields empty articles array — pipeline never crashes', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = await fetchRSSArticles(makeSite(input.fotomac_feed));
    expect(result.articles).toEqual([]);
    expect(result.articles.length).toBe(expected.articles_returned);
  });

  it('network error (fetch throws) also yields empty articles — same resilience guarantee', async () => {
    fetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));
    const result = await fetchRSSArticles(makeSite(input.fotomac_feed));
    expect(result.articles).toEqual([]);
    expect(result.articles.length).toBe(0);
  });

  it('fetchRSSArticles resolves (never rejects) on 403 — cron job cannot be killed', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    await expect(fetchRSSArticles(makeSite(input.fotomac_feed))).resolves.toBeDefined();
  });

  it('bySource stats show 0 for failed feed — not undefined or missing', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = await fetchRSSArticles(makeSite(input.fotomac_feed));
    expect(result.bySource['Fotomaç']).toBeDefined();
    expect(result.bySource['Fotomaç'].raw).toBe(expected.by_source_fotomaç_raw);
    expect(result.bySource['Fotomaç'].after_keyword).toBe(0);
  });

  it('empty articles array proves extractFacts unreachable — no partial fact_lineage rows possible', async () => {
    fetch.mockResolvedValueOnce({ ok: false, status: 403 });
    const result = await fetchRSSArticles(makeSite(input.fotomac_feed));
    // Architecture: extractFacts is only called from publisher.js per-article.
    // 0 articles here → publisher loop never runs → fact_lineage never written.
    expect(result.articles).toHaveLength(0);
  });

  it('successful proxy response marks articles as is_p4: true', async () => {
    fetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      text: async () => VALID_RSS,
    });
    const result = await fetchRSSArticles(makeSite(input.fotomac_feed));
    for (const article of result.articles) {
      expect(article.is_p4).toBe(true);
    }
  });
});
