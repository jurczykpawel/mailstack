#!/usr/bin/env bash
# Starts the image read-only with the example demo brand and requires a healthy /health with a working store.
set -euo pipefail
image="$1"
jq '{version, brands: {demo: .brands.demo}, logging, sender: {type:"smtp"}}' config/mailstack.example.json > "$RUNNER_TEMP/mailstack.json"
trap 'docker logs smoke; docker rm -f smoke' EXIT
docker run -d --name smoke --read-only --tmpfs /data:uid=1000,gid=1000 --tmpfs /tmp -v "$RUNNER_TEMP/mailstack.json:/config/mailstack.json:ro" -e SMTP_HOST=localhost "$image"
timeout 60 bash -c "until [ \"\$(docker inspect -f '{{.State.Health.Status}}' smoke)\" = healthy ]; do sleep 2; done"
docker exec smoke node -e 'fetch("http://127.0.0.1:8080/health").then(async r=>{const h=await r.json();if(!r.ok||h.ok!==true||h.store!=="ok")process.exit(1)}).catch(()=>process.exit(1))'
docker stop smoke
