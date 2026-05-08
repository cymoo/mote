# Flask API

The backend built with Python, Flask, SQLite, SQLAlchemy and Redis.

## Getting Started

To begin with this project:

### Create a Virtual Environment and Install Dependencies

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
```

### Run Redis

```bash
redis-server
```

### Starting the Application

- Run in development

```bash
MOTE_PASSWORD=xxx flask run
```

- Run in production

```bash
MOTE_PASSWORD=xxx gunicorn -k gevent -b :8000 --timeout 120 wsgi:app
```

NOTE: `--timeout` is a **worker liveness** check (not a per-request I/O deadline, and has no
read/write distinction). With gevent workers, cooperative I/O scheduling keeps workers responsive
during long downloads or uploads, so this timeout mainly guards against CPU-bound hangs such as
thumbnail generation on a very large image. The default of 30s is usually sufficient; 120s is a
conservative upper bound.

NOTE: The `MOTE_PASSWORD` variable is used for login. Ensure it is complex and securely stored in production.

### Database Initialization

To create the sqlite database and tables if missing:

```bash
flask create_tables
```

### Test

```bash
pytest .
```
