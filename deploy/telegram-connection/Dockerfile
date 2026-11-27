FROM python:3.12-slim

COPY requirements.txt /app/requirements.txt
RUN pip install --no-cache-dir -r /app/requirements.txt
COPY status.py queue_worker.py login.py cabinet_worker.py recover_replies.py /app/
RUN mkdir -p /var/lib/cabinet-telegram && chown 65532:65532 /var/lib/cabinet-telegram
USER 65532:65532
ENTRYPOINT ["python", "-B", "/app/status.py"]
