FROM node:20-alpine

# openssl is only used by the entrypoint, to mint a throwaway certificate when
# no mkcert one has been generated yet, so the dev server can still speak HTTPS.
RUN apk add --no-cache openssl

WORKDIR /app

COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json

RUN npm install --workspace web --include-workspace-root

COPY web ./web
RUN chmod +x /app/web/docker-entrypoint.sh

# 8080 is the origin Twitch Local Test is configured for. TLS is terminated by
# the dev server itself, so the extension, /api and /socket.io all share one
# HTTPS origin and the browser never sees mixed content.
EXPOSE 8080

ENTRYPOINT ["/app/web/docker-entrypoint.sh"]
# Host and port come from web/vite.config.ts (WEB_PORT), so there is exactly one
# place that decides them.
CMD ["npx", "vite", "--config", "web/vite.config.ts"]
