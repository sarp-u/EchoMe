# syntax=docker/dockerfile:1
# EchoMe — CPU image for Hugging Face Spaces / any Docker host.
# The Chatterbox weights are baked into the image so cold starts skip the
# ~3 GB download. Build time and image size are both large (~6-7 GB).

FROM python:3.11-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/app/.cache/huggingface \
    HOST=0.0.0.0 \
    PORT=8760 \
    CHATTERBOX_DEVICE=cpu \
    OMP_NUM_THREADS=2 \
    MKL_NUM_THREADS=2

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg libsndfile1 curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# CPU wheels keep the image ~2 GB smaller than the default CUDA build.
RUN pip install --upgrade pip \
    && pip install --no-cache-dir \
        torch==2.6.0 torchaudio==2.6.0 \
        --index-url https://download.pytorch.org/whl/cpu

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

# Bake the model weights into the image (matches mtl_tts.from_pretrained).
RUN python -c "from huggingface_hub import snapshot_download; snapshot_download('ResembleAI/chatterbox', allow_patterns=['ve.pt', 't3_mtl23ls_v2.safetensors', 's3gen.pt', 'grapheme_mtl_merged_expanded_v1.json', 'conds.pt', 'Cangjie5_TC.json'])"

COPY server.py ./
COPY static ./static

RUN mkdir -p outputs uploads \
    && chmod -R 777 outputs uploads /app/.cache

EXPOSE 8760

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s \
    CMD curl -fsS http://127.0.0.1:8760/healthz || exit 1

# One worker only: the model must live in a single process.
CMD ["python", "-m", "uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8760"]
