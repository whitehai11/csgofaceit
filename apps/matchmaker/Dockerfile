FROM node:22-alpine
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/matchmaker/package.json apps/matchmaker/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install
COPY . .
RUN npm run build -w @csgofaceit/shared && npm run build -w @csgofaceit/matchmaker
CMD ["npm", "run", "start", "-w", "@csgofaceit/matchmaker"]