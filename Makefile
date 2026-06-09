run:
	curl https://pitchos-fetch-agent.gencerali.workers.dev/run

cache:
	curl https://pitchos-fetch-agent.gencerali.workers.dev/cache?site=BJK

deploy:
	wrangler deploy

test-frontend:
	@node -e 'const fs=require("fs");const h=fs.readFileSync("index.html","utf8");const s=[...h.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(m=>m[1]).sort((a,b)=>b.length-a.length)[0];new Function(s);console.log("parse OK")'
	node scripts/frontend-harness.cjs index.html cache.txt


push:
	git add . && git commit -m "update" && git push

clear-cache:
	wrangler kv key delete --binding=PITCHOS_CACHE "articles:BJK"

fresh:
	wrangler kv key delete --binding=PITCHOS_CACHE "articles:BJK" && curl https://pitchos-fetch-agent.gencerali.workers.dev/run && curl https://pitchos-fetch-agent.gencerali.workers.dev/cache?site=BJK

all:
	wrangler deploy && git add . && git commit -m "update" && git push
