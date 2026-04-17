"""Django integration.

Add to `settings.py`:

    MIDDLEWARE = [
        "runtimescope.integrations.django.RuntimeScopeMiddleware",
        # ...other middleware
    ]

The middleware auto-calls `RuntimeScope.connect()` on the first request using
the `RUNTIMESCOPE_DSN` env var (or `settings.RUNTIMESCOPE_DSN` if set).
Captures request method, URL, status code, and duration.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from ..client import RuntimeScope


class RuntimeScopeMiddleware:
    """Django request middleware that records every request as a network event."""

    def __init__(self, get_response: Callable[[Any], Any]) -> None:
        self.get_response = get_response
        self._initialized = False

    def __call__(self, request: Any) -> Any:
        self._ensure_connected()

        start = time.perf_counter()
        response = self.get_response(request)
        duration_ms = (time.perf_counter() - start) * 1000

        try:
            RuntimeScope.emit_http(
                method=request.method,
                url=request.get_full_path(),
                status=getattr(response, "status_code", 0),
                duration_ms=duration_ms,
                request_headers=_safe_headers(request),
                response_headers=_safe_response_headers(response),
            )
        except Exception:
            pass

        return response

    def process_exception(self, request: Any, exc: BaseException) -> None:
        try:
            RuntimeScope.capture_exception(exc)
        except Exception:
            pass
        return None

    # ------------------------------------------------------------------ helpers

    def _ensure_connected(self) -> None:
        if self._initialized:
            return
        self._initialized = True

        # Allow `RUNTIMESCOPE_DSN` to come from Django settings if users prefer
        dsn = None
        try:
            from django.conf import settings  # type: ignore

            dsn = getattr(settings, "RUNTIMESCOPE_DSN", None)
        except Exception:
            pass

        RuntimeScope.connect(dsn=dsn)


_REDACT_HEADERS = {"authorization", "cookie", "set-cookie", "x-api-key"}


def _safe_headers(request: Any) -> dict:
    """Redact sensitive request headers."""
    headers: dict = {}
    try:
        for key, value in request.headers.items():
            if key.lower() in _REDACT_HEADERS:
                headers[key] = "[REDACTED]"
            else:
                headers[key] = str(value)
    except Exception:
        pass
    return headers


def _safe_response_headers(response: Any) -> dict:
    try:
        return {k: str(v) for k, v in response.items()}
    except Exception:
        return {}
