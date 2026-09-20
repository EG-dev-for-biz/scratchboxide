FROM pytorch/pytorch:2.3.0-cuda12.1-cudnn8-runtime

ENV DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Install system utilities
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install python dependencies
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Copy source tree
COPY . ./

# Vertex AI expects output directory in /tmp/output or AIP_MODEL_DIR
ENV AIP_MODEL_DIR=/app/output
RUN mkdir -p /app/output

ENTRYPOINT ["python", "train_vertex.py"]
