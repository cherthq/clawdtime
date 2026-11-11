FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY tsconfig*.json ./
COPY src ./src
COPY cli ./cli
COPY connectors ./connectors
COPY skills ./skills
COPY media/device-port.ts ./media/device-port.ts
COPY scripts ./scripts
COPY public ./public
RUN npm run build
RUN npm prune --omit=dev --ignore-scripts
FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/skills ./skills
COPY --from=build /app/package.json ./package.json
RUN mkdir /data && chown node:node /data
USER node
ENV CLAWDTIME_MODE=standby CLAWDTIME_DATABASE=/data/clawdtime.sqlite CLAWDTIME_PORT=3310 CLAWDTIME_HOST=0.0.0.0
EXPOSE 3310
CMD ["node","dist/src/server.js"]
