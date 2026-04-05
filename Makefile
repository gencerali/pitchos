run:
	curl https://pitchos-fetch-agent.gencerali.workers.dev/run

cache:
	curl https://pitchos-fetch-agent.gencerali.workers.dev/cache?site=BJK

deploy:
	wrangler deploy

push:
	git add . && git commit -m "update" && git push

clear-cache:
	wrangler kv key delete --binding=PITCHOS_CACHE "articles:BJK"

fresh:
	wrangler kv key delete --binding=PITCHOS_CACHE "articles:BJK" && curl https://pitchos-fetch-agent.gencerali.workers.dev/run && curl https://pitchos-fetch-agent.gencerali.workers.dev/cache?site=BJK

all:
	wrangler deploy && git add . && git commit -m "update" && git push
