FROM node:22-alpine
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/watchdog/package.json apps/watchdog/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/logger/package.json packages/logger/package.json
RUN npm install
COPY . .
RUN npm run build -w @csgofaceit/db && npm run build -w @csgofaceit/logger && npm run build -w @csgofaceit/watchdog
EXPOSE 3005
CMD ["npm", "run", "start", "-w", "@csgofaceit/watchdog"]

