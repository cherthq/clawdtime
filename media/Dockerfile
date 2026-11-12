FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -r requirements.txt
COPY policy.py playback.py captions.py devices.py screen_diagnostics.py lifecycle_diagnostics.py device_actions.py device_relay.py ledger_backup.py server.py ./
ENV HOST=0.0.0.0 MEDIA_DATABASE_PATH=/data/media.sqlite PYTHONUNBUFFERED=1
EXPOSE 4212
CMD ["python", "server.py"]
