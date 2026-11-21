FROM python:3.12-slim

RUN pip install --no-cache-dir 'Telethon==1.45.0' 'psycopg[binary]==3.2.13'
COPY status.py queue_worker.py login.py /app/
USER 65532:65532
ENTRYPOINT ["python", "-B", "/app/status.py"]
