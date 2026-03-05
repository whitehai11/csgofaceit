FROM node:22-alpine
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/discord-bot/package.json apps/discord-bot/package.json
COPY apps/matchmaker/package.json apps/matchmaker/package.json
COPY apps/server-manager/package.json apps/server-manager/package.json
COPY apps/watchdog/package.json apps/watchdog/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/elo/package.json packages/elo/package.json
COPY packages/logger/package.json packages/logger/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install
COPY . .
RUN npm run build -w @csgofaceit/db && npm run build -w @csgofaceit/logger && npm run build -w @csgofaceit/watchdog
EXPOSE 3005
CMD ["npm", "run", "start", "-w", "@csgofaceit/watchdog"]
