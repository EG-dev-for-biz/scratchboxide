# Scratchbox IDE - Headless ComfyUI Cloud Run Container
# Compatible with Google Cloud Run CPU and Cloud Run with NVIDIA L4 GPUs
# Features automated upstream ComfyUI tracking and dynamic custom node hot-loading.

FROM python:3.11-slim

# Prevent interactive prompts during installation
ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1
ENV PORT=8080
ENV STORAGE_DIR=/tmp/comfy_outputs

ARG COMFYUI_BRANCH=master
ARG COMFYUI_REPO=https://github.com/comfyanonymous/ComfyUI.git

ENV COMFYUI_BRANCH=${COMFYUI_BRANCH}
ENV COMFYUI_REPO=${COMFYUI_REPO}

# Install core system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    libgl1-mesa-glx \
    libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone latest upstream ComfyUI repository
RUN git clone --depth 1 --branch ${COMFYUI_BRANCH} ${COMFYUI_REPO} /app/ComfyUI || mkdir -p /app/ComfyUI

# Install Python requirements
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Ensure dynamic custom nodes directories exist and set python path
RUN mkdir -p /app/ComfyUI/custom_nodes/dynamic /tmp/comfy_outputs/custom_nodes
ENV PYTHONPATH="/app:/app/ComfyUI:${PYTHONPATH}"

# Copy server code
COPY server.py .

# Expose Cloud Run port
EXPOSE 8080

# Run entrypoint
CMD ["python3", "server.py"]
