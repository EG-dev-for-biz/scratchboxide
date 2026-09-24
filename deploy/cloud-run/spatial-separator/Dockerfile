# syntax=docker/dockerfile:1
# ------------------------------------------------------------------------------
# Scratchbox IDE - Spatial Object Separator & 3D Bounding Box Service
# Google Cloud Run Optimized Container Image (Self-Contained Alpine Build)
# ------------------------------------------------------------------------------

FROM node:20-alpine

ENV NODE_ENV=production
ENV HOST=0.0.0.0

WORKDIR /app

# Install curl for container health probes
RUN apk add --no-cache curl

# Copy pre-bundled server and required spatial assets
COPY dist/server.cjs ./server.cjs
COPY assets ./assets

# Expose standard Cloud Run port
EXPOSE 8080

# Cloud Run Container Healthcheck
HEALTHCHECK --interval=20s --timeout=4s --start-period=5s --retries=3 \
  CMD curl -f http://localhost:8080/health || exit 1

# Launch bundled CJS service
CMD ["node", "server.cjs"]
