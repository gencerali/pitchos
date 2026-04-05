@echo off
if "%1"=="run" curl https://pitchos-fetch-agent.gencerali.workers.dev/run
if "%1"=="cache" curl "https://pitchos-fetch-agent.gencerali.workers.dev/cache?site=BJK"
if "%1"=="deploy" wrangler deploy
if "%1"=="push" git add . && git commit -m "update" && git push
if "%1"=="clear" curl https://pitchos-fetch-agent.gencerali.workers.dev/clear-cache
if "%1"=="fresh" curl https://pitchos-fetch-agent.gencerali.workers.dev/clear-cache && curl https://pitchos-fetch-agent.gencerali.workers.dev/run
if "%1"=="all" wrangler deploy && git add . && git commit -m "update" && git push
