FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY . .
RUN npm run build

FROM node:24-slim AS runtime

WORKDIR /app

COPY --from=build /app/.mastra/output ./

RUN npm install

EXPOSE 4111

CMD ["node", "index.mjs"]
