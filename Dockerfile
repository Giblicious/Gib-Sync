FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package*.json tsconfig.base.json ./
COPY packages/protocol/package.json packages/protocol/package.json
COPY apps/server/package.json apps/server/package.json
COPY plugin/package.json plugin/package.json
RUN npm install
COPY packages/protocol packages/protocol
COPY apps/server apps/server
RUN npm run build -w @gib-sync/protocol && npm run build -w @gib-sync/server && npm prune --omit=dev

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/protocol ./packages/protocol
COPY --from=build /app/apps/server ./apps/server
USER node
EXPOSE 8787
CMD ["node", "--enable-source-maps", "apps/server/dist/index.js"]

