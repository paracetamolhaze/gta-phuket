FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json

RUN npm install --workspace web --include-workspace-root

COPY web ./web

EXPOSE 5173

# Vite dev server: the compose setup proxies /api and /socket.io to the api
# service, so every surface is reachable from one origin on :5173.
CMD ["npx", "vite", "--host", "0.0.0.0", "--port", "5173", "--config", "web/vite.config.ts"]
