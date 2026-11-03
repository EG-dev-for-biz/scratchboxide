# Pipeline K-D chunk job (packages/core/src/node/3d-engine/staged-location/kd-chunk-job.ts): one district chunk a task.
# Built by Cloud Build (cloudbuild.yaml) from a `git archive` of one commit (deploy.sh build), tagged with that commit.
FROM node:22-trixie

# clang for the native engine (C++20, -O3, never -march=native: the task's CPU is not the build machine's): trixie's
# clang 19, since bookworm's clang 14 rejects C++20 the native kernels use (a lambda capturing a structured binding);
# python3 with numpy and OpenCV for the photo-tier rectify the orchestrator spawns
RUN apt-get update \
 && apt-get install -y --no-install-recommends clang zlib1g-dev python3 python3-numpy python3-opencv ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY . .

# packages/core's dependencies alone (the workspace's other package.json files are in the archive for the lock file), and
# ts-node, which runs the TypeScript as the app's worker threads do (worker-ts-register.ts)
RUN npm ci --workspace packages/core --include-workspace-root=false --no-audit --no-fund \
 && npm install --no-save --no-audit --no-fund ts-node@10.9.2 \
 && npm cache clean --force

ENV NODE_ENV=production \
    SCRATCHBOX_ROOT=/app \
    SCRATCHBOX_NATIVE_BUILD_CACHE=/opt/native-cache \
    CXX=clang++ \
    TS_NODE_TRANSPILE_ONLY=true \
    TS_NODE_SKIP_PROJECT=true \
    TS_NODE_COMPILER_OPTIONS='{"target":"ES2022","module":"commonjs","moduleResolution":"node","esModuleInterop":true,"allowSyntheticDefaultImports":true}' \
    SCRATCHBOX_NATIVE_WARMUP=0 \
    SCRATCHBOX_ASSET_STORE=0 \
    SCRATCHBOX_KD_CHUNK_JOB=1

# every native engine a chunk runs, compiled now: a Linux build failure fails the image, not a district
RUN node -r ts-node/register packages/core/src/node/3d-engine/staged-location/kd-chunk-job.ts --warm

ARG COMMIT
ENV KD_IMAGE_COMMIT=${COMMIT}
CMD ["node", "--max-old-space-size=28672", "-r", "ts-node/register", "packages/core/src/node/3d-engine/staged-location/kd-chunk-job.ts"]
