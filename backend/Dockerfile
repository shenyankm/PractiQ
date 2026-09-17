FROM python:3.14-slim
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY src ./src
RUN pip install --no-cache-dir uv \
 && uv export --locked --no-dev --no-emit-project -o /tmp/requirements.txt \
 && uv pip install --system --no-deps -r /tmp/requirements.txt .
CMD ["python", "-m", "uvicorn", "practiq_backend.app:app", "--host", "127.0.0.1", "--port", "8080"]
