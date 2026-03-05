FROM node:22-alpine
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/server-manager/package.json apps/server-manager/package.json
RUN npm install
COPY . .
RUN npm run build -w @csgofaceit/server-manager
EXPOSE 3003
CMD ["npm", "run", "start", "-w", "@csgofaceit/server-manager"]