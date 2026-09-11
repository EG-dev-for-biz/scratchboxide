# Scratchbox IDE — standalone web build (Express API + static Vite bundle).
#
#   docker build -t scratchbox-ide .
#   docker run -p 3001:3001 -e GEMINI_API_KEY=... -v $PWD/workspace:/workspace scratchbox-ide
#
# The API binds 0.0.0.0 inside the container (override with HOST) and serves the
# built frontend from desktop-app/dist. Credentials are read from environment
# variables or from /home/scratchbox/.scratchbox/secrets.json (mount it read-only).

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY desktop-app/package.json desktop-app/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
RUN adduser --system --group scratchbox && mkdir -p /workspace && chown scratchbox:scratchbox /workspace
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    SCRATCHBOX_WORKSPACE_ROOTS=/workspace
COPY --from=build --chown=scratchbox:scratchbox /app/package.json /app/package-lock.json ./
COPY --from=build --chown=scratchbox:scratchbox /app/packages/core/package.json packages/core/
COPY --from=build --chown=scratchbox:scratchbox /app/desktop-app/package.json desktop-app/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY --from=build --chown=scratchbox:scratchbox /app/desktop-app/dist desktop-app/dist
COPY --from=build --chown=scratchbox:scratchbox /app/desktop-app/dist-electron desktop-app/dist-electron
USER scratchbox
EXPOSE 3001
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "desktop-app/dist-electron/desktop-app/server/index.js"]
