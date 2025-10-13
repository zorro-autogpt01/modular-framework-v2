FROM node:18-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci || npm i

FROM deps AS build
WORKDIR /app
COPY . .
RUN npm run build

FROM node:18-alpine
WORKDIR /app
COPY --from=build /app/dist ./dist
RUN npm i -g serve
EXPOSE 4173
CMD ["npx", "serve", "-s", "dist", "-l", "4173"]
