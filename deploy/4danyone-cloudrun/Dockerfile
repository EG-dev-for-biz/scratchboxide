# Cloud Run GPU job image: 4DAnyone multi-view diffusion + Scratchbox animatable Gaussian refinement.
# Build context (assembled by FourDAnyoneCloudRunBuilder / deploy/4danyone-cloudrun/build.sh):
#   Dockerfile, entrypoint.sh, 4danyone-src.tgz (ant-research/4DAnyone checkout incl. third_party/GVHMR)
# Weights, inputs and outputs live in the GCS bucket mounted at /mnt/artifacts at run time.
FROM nvidia/cuda:12.8.1-devel-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONUNBUFFERED=1 \
    TORCH_CUDA_ARCH_LIST="8.0;8.9" \
    TORCH_EXTENSIONS_DIR=/opt/torch_extensions \
    HOME=/root

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3.10 python3.10-venv python3-dev build-essential ffmpeg git ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY 4danyone-src.tgz /opt/
RUN cd /opt && tar --no-same-owner -xzf 4danyone-src.tgz 2>/dev/null && rm 4danyone-src.tgz \
    && git config --system --add safe.directory '*'

WORKDIR /opt/4DAnyone-main
RUN python3.10 -m venv /opt/venv \
    && /opt/venv/bin/pip install --no-cache-dir --upgrade pip \
    && /opt/venv/bin/pip install --no-cache-dir -r requirements.txt scipy ninja gsplat==1.5.3

# Compile gsplat's CUDA kernels now (nvcc only, no GPU needed) so jobs never JIT-compile.
RUN PATH=/usr/local/cuda/bin:/opt/venv/bin:$PATH MAX_JOBS=8 \
    /opt/venv/bin/python -c "from gsplat.cuda._backend import _C; assert _C is not None; print('gsplat kernels built')"

COPY entrypoint.sh /opt/entrypoint.sh
ENTRYPOINT ["/bin/bash", "/opt/entrypoint.sh"]
