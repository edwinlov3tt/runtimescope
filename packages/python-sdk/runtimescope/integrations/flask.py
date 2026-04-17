"""Flask integration.

    from flask import Flask
    from runtimescope.integrations.flask import init_app

    app = Flask(__name__)
    init_app(app)

Captures every request as a network event, all uncaught errors as console
error events. Reads `RUNTIMESCOPE_DSN` from the environment by default.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from ..client import RuntimeScope


def init_app(app: Any, dsn: Optional[str] = None) -> None:
    """Install the RuntimeScope middleware on a Flask app."""
    RuntimeScope.connect(dsn=dsn)

    @app.before_request  # type: ignore[misc]
    def _before_request() -> None:
        from flask import g, request  # type: ignore

        g._rs_start = time.perf_counter()
        g._rs_path = request.full_path if request.query_string else request.path
        g._rs_method = request.method

    @app.after_request  # type: ignore[misc]
    def _after_request(response: Any) -> Any:
        try:
            from flask import g  # type: ignore

            start = getattr(g, "_rs_start", None)
            if start is None:
                return response
            duration_ms = (time.perf_counter() - start) * 1000

            RuntimeScope.emit_http(
                method=getattr(g, "_rs_method", "GET"),
                url=getattr(g, "_rs_path", "/"),
                status=response.status_code,
                duration_ms=duration_ms,
            )
        except Exception:
            pass
        return response

    @app.errorhandler(Exception)  # type: ignore[misc]
    def _on_exception(exc: BaseException) -> Any:
        try:
            RuntimeScope.capture_exception(exc)
        except Exception:
            pass
        # Re-raise so Flask's normal error handling still runs
        raise exc
