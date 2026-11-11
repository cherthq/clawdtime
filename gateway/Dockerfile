FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY service.py relay.py ./
ENV PYTHONUNBUFFERED=1 DEVICE_GATEWAY_DATABASE_PATH=/data/gateway.sqlite
CMD ["python", "relay.py"]
