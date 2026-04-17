# runtimescope (Python)

Python SDK for [RuntimeScope](https://github.com/edwinlov3tt/runtimescope) — runtime profiling and telemetry for Django, Flask, FastAPI, and any Python app.

```bash
pip install runtimescope
```

Zero required dependencies — the SDK uses only the Python standard library. Framework integrations (Django / Flask / FastAPI) are opt-in.

## Quick Start

```python
from runtimescope import RuntimeScope

RuntimeScope.connect(dsn="runtimescope://proj_xxx@localhost:9091/my-app")
# or set RUNTIMESCOPE_DSN in your environment and call with no args:
RuntimeScope.connect()

RuntimeScope.track("user_signed_up", {"plan": "pro"})
RuntimeScope.add_breadcrumb("task started", {"task_id": 42})
```

When `RUNTIMESCOPE_DSN` is not set, the SDK is **completely inert** — no connection attempts, no patching, zero overhead. Safe to ship to production.

## Framework Integrations

### Django

```python
# settings.py
MIDDLEWARE = [
    "runtimescope.integrations.django.RuntimeScopeMiddleware",
    # ...
]

# Optional: set DSN via Django settings (otherwise uses RUNTIMESCOPE_DSN env var)
RUNTIMESCOPE_DSN = "runtimescope://proj_xxx@localhost:9091/my-django-app"
```

### Flask

```python
from flask import Flask
from runtimescope.integrations.flask import init_app

app = Flask(__name__)
init_app(app)  # reads RUNTIMESCOPE_DSN from env
```

### FastAPI

```python
from fastapi import FastAPI
from runtimescope.integrations.fastapi import RuntimeScopeMiddleware

app = FastAPI()
app.add_middleware(RuntimeScopeMiddleware)
```

## What Gets Captured

| Capture | Default | How |
|---------|---------|-----|
| Every HTTP request | ✅ via middleware | method, URL, status, duration |
| Uncaught exceptions | ✅ | `sys.excepthook` hook |
| `logging.WARNING+` | ✅ | Python `logging` handler |
| Custom events | Manual | `RuntimeScope.track(name, properties)` |
| Breadcrumbs | Manual | `RuntimeScope.add_breadcrumb(msg, data)` |
| Manual exception | Manual | `RuntimeScope.capture_exception(exc)` |

You can disable the auto-captures via `connect()` kwargs:

```python
RuntimeScope.connect(
    dsn="...",
    capture_errors=False,    # don't install sys.excepthook
    capture_logging=False,   # don't hook into `logging`
)
```

## DSN Format

Same as every other RuntimeScope SDK:

```
runtimescope://proj_xxx@host:9091/app-name
runtimescopes://proj_xxx@runtimescope.example.com/app-name   # TLS
```

The HTTP port is canonical; the WebSocket port is derived as `http_port - 1`.

## Auth Tokens

Pass `auth_token="..."` to `connect()` or set `RUNTIMESCOPE_AUTH_TOKEN` in the environment. The token is sent as a Bearer header on every POST.

## License

MIT
