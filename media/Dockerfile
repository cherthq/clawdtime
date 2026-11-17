FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt requirements-live.txt ./
ARG ENABLE_GPT_LIVE=false
RUN apt-get update && apt-get install -y --no-install-recommends fonts-dejavu-core && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir -r requirements.txt && if [ "$ENABLE_GPT_LIVE" = "true" ]; then pip install --no-cache-dir -r requirements-live.txt; fi
COPY camera.py camera_http.py document_preview.py presentation.py policy.py playback.py captions.py devices.py screen_diagnostics.py lifecycle_diagnostics.py speech_diagnostics.py device_actions.py device_relay.py ledger_backup.py utterances.py voice_interaction.py conversational.py elevenlabs_frontend.py text_devices.py probe_live.py acoustic.py server.py ./
ENV HOST=0.0.0.0 MEDIA_DATABASE_PATH=/data/media.sqlite PYTHONUNBUFFERED=1
EXPOSE 4212
CMD ["python", "server.py"]
