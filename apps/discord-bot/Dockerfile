FROM node:22-alpine
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/discord-bot/package.json apps/discord-bot/package.json
RUN npm install
COPY . .
RUN npm run build -w @csgofaceit/discord-bot
CMD ["npm", "run", "start", "-w", "@csgofaceit/discord-bot"]