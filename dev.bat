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
    python check.py
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
