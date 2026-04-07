import json, sys, urllib.request

def fetch(url):
    with urllib.request.urlopen(url, timeout=15) as r:
        return json.loads(r.read().decode('utf-8'))

try:
    cache = fetch('https://pitchos-fetch-agent.gencerali.workers.dev/cache?site=BJK')
    status = fetch('https://pitchos-fetch-agent.gencerali.workers.dev/status')
except Exception as e:
    print('ERROR:', e)
    sys.exit(1)

print('=== KARTALIX STATUS ===')
print(f'Cache: {len(cache)} articles')
print(f'Last run: {status.get("created_at","?")[:16]} ({status.get("status","?")})')
print(f'Cost: EUR{status.get("estimated_cost_eur",0):.4f}')
print()

sources = {}
modes = {}
for a in cache:
    s = a.get('source') or a.get('source_name') or '?'
    if s not in sources:
        sources[s] = {'count':0,'total_body':0}
    sources[s]['count'] += 1
    sources[s]['total_body'] += len(a.get('full_body','') or '')
    m = a.get('publish_mode','rss_summary')
    modes[m] = modes.get(m,0)+1

print('SOURCES:')
for s,v in sorted(sources.items(), key=lambda x: -x[1]['count']):
    avg = v['total_body']//v['count'] if v['count'] else 0
    print(f'  {s[:20]:<20} {v["count"]} articles  avg_body: {avg} chars')

print()
print('CONTENT QUALITY:')
for m,c in sorted(modes.items(), key=lambda x: -x[1]):
    print(f'  {m:<15} {c} articles')

print()
print('TOP 3:')
for a in cache[:3]:
    nvs = a.get('nvs',0)
    src = (a.get('source') or a.get('source_name') or '?')[:10]
    body = len(a.get('full_body','') or '')
    title = a.get('title','')[:45]
    print(f'  [{nvs}] {src:<10} {body}ch  {title}')

err = status.get('error_message','')
if err:
    try:
        funnel = json.loads(err)
        print()
        print('FUNNEL:')
        print(f'  {funnel.get("raw_fetched",0)} fetched -> {funnel.get("after_keyword",0)} keyword -> {funnel.get("after_hash",0)} hash -> {funnel.get("after_title",0)} title -> {status.get("items_published",0)} published')
    except:
        pass
