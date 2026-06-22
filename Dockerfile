FROM node:22-alpine AS build

WORKDIR /app

ARG VITE_API_BASE_URL=
ARG VITE_AMAP_WEB_MAP_KEY=
ARG VITE_AMAP_SECURITY_JS_CODE=
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL
ENV VITE_AMAP_WEB_MAP_KEY=$VITE_AMAP_WEB_MAP_KEY
ENV VITE_AMAP_SECURITY_JS_CODE=$VITE_AMAP_SECURITY_JS_CODE

COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci

COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3101
ENV APP_DATA_PATH=/data/ai-house-assistant.json

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/packages/shared/package.json ./packages/shared/package.json
COPY --from=build /app/packages/shared/dist ./packages/shared/dist

RUN addgroup -S app \
  && adduser -S app -G app \
  && mkdir -p /data \
  && chown -R app:app /app /data

USER app

EXPOSE 3101
CMD ["npm", "run", "start", "--workspace", "@ai-house-assistant/server"]
