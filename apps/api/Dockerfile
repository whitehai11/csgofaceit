FROM node:22-alpine
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY packages/auth/package.json packages/auth/package.json
COPY packages/db/package.json packages/db/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install
COPY . .
RUN npm run build -w @csgofaceit/shared && npm run build -w @csgofaceit/db && npm run build -w @csgofaceit/auth && npm run build -w @csgofaceit/api
EXPOSE 3001
CMD ["npm", "run", "start", "-w", "@csgofaceit/api"]