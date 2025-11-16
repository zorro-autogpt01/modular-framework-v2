#!/usr/bin/env bash
set -euo pipefail

# Wait for DB
if [ -n "${DATABASE_URL:-}" ]; then
  echo "Waiting for database..."
  python - <<'PY'
import os, time
import sqlalchemy
from sqlalchemy import text
url=os.environ['DATABASE_URL']
engine=sqlalchemy.create_engine(url)
for _ in range(60):
    try:
        with engine.connect() as c:
            c.execute(text('SELECT 1'))
            print('DB up'); break
    except Exception as e:
        print('DB not ready:', e); time.sleep(2)
else:
    raise SystemExit('DB not reachable')
PY
fi

# Run migrations
alembic upgrade head || true

# Start server
exec uvicorn app.main:app --host 0.0.0.0 --port 8000