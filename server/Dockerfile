# NanoHab Connect API — Cloud Run container
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

WORKDIR /app

# Install deps first (better layer caching)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# App code
COPY main.py .
COPY pdfbuilder.py .
COPY verifypage.py .
COPY fonts/ ./fonts/

# Cloud Run sends traffic to $PORT (defaults to 8080). Listen on it.
ENV PORT=8080
CMD exec uvicorn main:app --host 0.0.0.0 --port ${PORT}
