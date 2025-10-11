FROM node:18-alpine
WORKDIR /app

COPY package.json ./
RUN npm install --production
RUN npm install && npm install micromatch
RUN apk add --no-cache python3 make g++

COPY . .

ENV NODE_ENV=production
ENV PORT=3005
ENV ALLOW_STEP_EXEC=true
ENV INTERNAL_API_TOKEN=supersecret
ENV RUNNER_REG_TOKEN=supersecret
ENV RUNNER_CONTROLLER_BASE=http://llm-runner-controller:4015/api/llm-runner


EXPOSE 3005

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://localhost:$PORT/health || exit 1

CMD ["node", "server/index.js"]
#CMD ["tail","-f","/dev/null"]
