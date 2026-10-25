FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache python3 make g++ && npm ci --ignore-scripts && npm rebuild better-sqlite3 esbuild
COPY src ./src
COPY scripts/build-node.mjs ./scripts/build-node.mjs
RUN npm run build:node && npm prune --omit=dev --ignore-scripts

FROM node:24-alpine
ENV NODE_ENV=production TZ=UTC MAILSTACK_CONFIG=/config/mailstack.json
WORKDIR /app
RUN mkdir /data && chown node:node /data
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s CMD node -e "fetch('http://127.0.0.1:8080/health').then(async r=>{const h=await r.json();if(!r.ok||h.store!=='ok')process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/node-api.mjs"]
