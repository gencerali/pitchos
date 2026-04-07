@echo off
if "%1"=="run" (
    curl -s "https://pitchos-fetch-agent.gencerali.workers.dev/run"
    echo.
    echo Pipeline started. Waiting 90 seconds...
    timeout /t 90 /nobreak > nul
    call %0 check
    goto end
)

if "%1"=="enrich" (
    echo Enriching articles with full content...
    curl -s --max-time 120 "https://pitchos-fetch-agent.gencerali.workers.dev/enrich"
    echo.
    echo Waiting 60 seconds...
    timeout /t 60 /nobreak > nul
    call %0 check
    goto end
)

if "%1"=="check" (
    curl -s "https://pitchos-fetch-agent.gencerali.workers.dev/cache?site=BJK" > cache.txt
    curl -s "https://pitchos-fetch-agent.gencerali.workers.dev/status" > status.txt
    python -c "
import json, sys
sys.stdout.reconfigure(encoding='utf-8')
cache = json.load(open('cache.txt', encoding='utf-8'))
status = json.load(open('status.txt', encoding='utf-8'))
print('=== KARTALIX STATUS ===')
print(f'Cache: {len(cache)} articles')
print(f'Last run: {status.get(chr(99)+chr(114)+chr(101)+chr(97)+chr(116)+chr(101)+chr(100)+chr(95)+chr(97)+chr(116),chr(63))[:16]} ({status.get(chr(115)+chr(116)+chr(97)+chr(116)+chr(117)+chr(115),chr(63))})')
print(f'Cost: EUR{status.get(chr(101)+chr(115)+chr(116)+chr(105)+chr(109)+chr(97)+chr(116)+chr(101)+chr(100)+chr(95)+chr(99)+chr(111)+chr(115)+chr(116)+chr(95)+chr(101)+chr(117)+chr(114),0):.4f}')
print()
sources = {}
modes = {}
for a in cache:
    s = a.get('source') or a.get('source_name') or '?'
    sources[s] = sources.get(s, {'count':0,'total_body':0})
    sources[s]['count'] += 1
    sources[s]['total_body'] += len(a.get('full_body','') or '')
    m = a.get('publish_mode','?')
    modes[m] = modes.get(m,0)+1
print('SOURCES:')
for s,v in sorted(sources.items(), key=lambda x: -x[1]['count']):
    avg = v['total_body']//v['count'] if v['count'] else 0
    print(f'  {s[:20]:<20} {v[chr(99)+chr(111)+chr(117)+chr(110)+chr(116)]} articles  avg_body: {avg} chars')
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
        print(f'  {funnel.get(chr(114)+chr(97)+chr(119)+chr(95)+chr(102)+chr(101)+chr(116)+chr(99)+chr(104)+chr(101)+chr(100),0)} fetched -> {funnel.get(chr(97)+chr(102)+chr(116)+chr(101)+chr(114)+chr(95)+chr(107)+chr(101)+chr(121)+chr(119)+chr(111)+chr(114)+chr(100),0)} keyword -> {funnel.get(chr(97)+chr(102)+chr(116)+chr(101)+chr(114)+chr(95)+chr(104)+chr(97)+chr(115)+chr(104),0)} hash -> {funnel.get(chr(97)+chr(102)+chr(116)+chr(101)+chr(114)+chr(95)+chr(116)+chr(105)+chr(116)+chr(108)+chr(101),0)} title -> {status.get(chr(105)+chr(116)+chr(101)+chr(109)+chr(115)+chr(95)+chr(112)+chr(117)+chr(98)+chr(108)+chr(105)+chr(115)+chr(104)+chr(101)+chr(100),0)} published')
    except: pass
"
    goto end
)

if "%1"=="deploy" (
    wrangler deploy
    git add .
    git commit -m "deploy"
    git push
    goto end
)

if "%1"=="fresh" (
    echo WARNING: Use only when adding new sources.
    curl -s "https://pitchos-fetch-agent.gencerali.workers.dev/clear-cache"
    curl -s "https://pitchos-fetch-agent.gencerali.workers.dev/run"
    echo Pipeline started fresh. Waiting 90 seconds...
    timeout /t 90 /nobreak > nul
    call %0 check
    goto end
)

:end
