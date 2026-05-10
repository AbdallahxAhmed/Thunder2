FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DOWNLOAD_DIR=/data/downloads \
    LOG_DIR=/data/logs \
    DB_PATH=/data/thunder.db

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        aria2 \
        ca-certificates \
        curl \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

RUN curl -L https://github.com/nilaoda/N_m3u8DL-RE/releases/latest/download/N_m3u8DL-RE \
    -o /usr/local/bin/N_m3u8DL-RE \
    && chmod +x /usr/local/bin/N_m3u8DL-RE

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY src ./src
COPY extension ./extension
COPY README.md ./README.md
COPY pyproject.toml ./pyproject.toml

EXPOSE 8000

CMD ["/bin/sh", "-c", "mkdir -p \"$DOWNLOAD_DIR\" \"$LOG_DIR\" && aria2c --enable-rpc --rpc-listen-all=false --rpc-listen-port=6800 --rpc-allow-origin-all --dir \"$DOWNLOAD_DIR\" --daemon=true && uvicorn src.main:app --host 0.0.0.0 --port 8000"]
