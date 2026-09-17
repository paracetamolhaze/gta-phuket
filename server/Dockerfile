FROM node:20-alpine

WORKDIR /app

# Workspace manifests first so `npm ci` is cached across source edits.
COPY package.json package-lock.json* ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json

RUN npm install --workspace server --include-workspace-root

COPY server ./server

ENV NODE_ENV=development
EXPOSE 4000

# migrate-then-serve; tsx runs TypeScript directly so the dev bind mount works.
CMD ["sh", "-c", "npm run migrate -w server && npx tsx server/src/index.ts"]
