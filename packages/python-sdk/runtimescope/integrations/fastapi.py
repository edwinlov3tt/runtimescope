"""FastAPI / Starlette integration.

    from fastapi import FastAPI
    from runtimescope.integrations.fastapi import RuntimeScopeMiddleware

    app = FastAPI()
    app.add_middleware(RuntimeScopeMiddleware)

Captures every request as a network event. Calls `RuntimeScope.connect()` on
first request unless the SDK is already initialized.
"""

from __future__ import annotations

import time
from typing import Any, Optional

from ..client import RuntimeScope


class RuntimeScopeMiddleware:
    """ASGI middleware for FastAPI / Starlette.

    Works as a standard `add_middleware(...)` entry. Uses Starlette's
    `BaseHTTPMiddleware` shape so both FastAPI and raw Starlette apps are
    supported.
    """

    def __init__(self, app: Any, dsn: Optional[str] = None) -> None:
        self.app = app
        if not RuntimeScope.is_connected:
            RuntimeScope.connect(dsn=dsn)

    async def __call__(self, scope: dict, receive: Any, send: Any) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return

        start = time.perf_counter()
        status_holder: dict = {"status": 0}

        async def send_wrapper(message: dict) -> None:
            if message.get("type") == "http.response.start":
                status_holder["status"] = message.get("status", 0)
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:
            RuntimeScope.capture_exception(exc)
            raise
        finally:
            try:
                duration_ms = (time.perf_counter() - start) * 1000
                path = scope.get("path", "/")
                query = scope.get("query_string", b"")
                if query:
                    path = f"{path}?{query.decode('utf-8', errors='ignore')}"
                RuntimeScope.emit_http(
                    method=scope.get("method", "GET"),
                    url=path,
                    status=status_holder["status"],
                    duration_ms=duration_ms,
                )
            except Exception:
                pass
