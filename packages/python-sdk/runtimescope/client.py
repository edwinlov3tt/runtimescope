"""Main RuntimeScope client — the public entrypoint for the Python SDK."""

from __future__ import annotations

import logging
import os
import sys
import traceback
import uuid
from typing import Any, Callable, Dict, Optional

from .dsn import ParsedDsn, parse_dsn
from .transport import HttpTransport, now_ms

SDK_VERSION = "0.10.0"

_log = logging.getLogger("runtimescope")


def _generate_session_id() -> str:
    return uuid.uuid4().hex


def _generate_event_id() -> str:
    return uuid.uuid4().hex


class _RuntimeScopeImpl:
    """Singleton implementation — use via the module-level `RuntimeScope`."""

    def __init__(self) -> None:
        self._transport: Optional[HttpTransport] = None
        self._session_id: Optional[str] = None
        self._project_id: Optional[str] = None
        self._app_name: str = "python-app"
        self._enabled: bool = False
        self._original_excepthook: Optional[Callable] = None
        self._logging_handler: Optional[logging.Handler] = None

    # ------------------------------------------------------------------ public

    @property
    def session_id(self) -> Optional[str]:
        return self._session_id

    @property
    def is_connected(self) -> bool:
        return self._enabled and self._transport is not None

    def connect(
        self,
        dsn: Optional[str] = None,
        app_name: Optional[str] = None,
        project_id: Optional[str] = None,
        auth_token: Optional[str] = None,
        capture_errors: bool = True,
        capture_logging: bool = True,
        batch_size: int = 50,
        flush_interval_ms: int = 2000,
    ) -> None:
        """Initialize the SDK and start sending events.

        Auto-disables in production when no DSN is provided — set the
        `RUNTIMESCOPE_DSN` env var or pass `dsn=` explicitly.

        Calling connect() multiple times is safe; subsequent calls after the
        first successful init are no-ops.
        """
        if self.is_connected:
            return

        resolved_dsn = dsn or os.environ.get("RUNTIMESCOPE_DSN")

        if not resolved_dsn:
            # Production-safe: silently do nothing. No connection, no patching.
            # Matches the browser/Node SDK behaviour.
            return

        try:
            parsed: ParsedDsn = parse_dsn(resolved_dsn)
        except ValueError as e:
            _log.debug("[RuntimeScope] Invalid DSN: %s", e)
            return

        self._session_id = _generate_session_id()
        self._project_id = project_id or parsed.project_id
        self._app_name = app_name or parsed.app_name or "python-app"

        http_url = f"{parsed.http_endpoint}/api/events"

        self._transport = HttpTransport(
            url=http_url,
            session_id=self._session_id,
            app_name=self._app_name,
            sdk_version=SDK_VERSION,
            auth_token=auth_token or parsed.auth_token or os.environ.get("RUNTIMESCOPE_AUTH_TOKEN"),
            project_id=self._project_id,
            batch_size=batch_size,
            flush_interval_ms=flush_interval_ms,
        )
        self._enabled = True

        # Emit a session event so the collector creates a session record
        self._send_event({
            "eventType": "session",
            "appName": self._app_name,
            "projectId": self._project_id,
            "connectedAt": now_ms(),
            "sdkVersion": SDK_VERSION,
        })

        if capture_errors:
            self._install_excepthook()

        if capture_logging:
            self._install_logging_handler()

    def init(self, **kwargs: Any) -> None:
        """Alias for connect() — matches the browser SDK's API shape."""
        self.connect(**kwargs)

    def track(self, name: str, properties: Optional[Dict[str, Any]] = None) -> None:
        """Emit a custom event."""
        if not self.is_connected:
            return
        self._send_event({
            "eventType": "custom",
            "name": name,
            "properties": properties or {},
        })

    def add_breadcrumb(
        self, message: str, data: Optional[Dict[str, Any]] = None
    ) -> None:
        """Record a breadcrumb — useful for debugging flows."""
        if not self.is_connected:
            return
        self._send_event({
            "eventType": "ui",
            "action": "breadcrumb",
            "target": "manual",
            "text": message,
            **({"data": data} if data else {}),
        })

    def capture_exception(self, exc: Optional[BaseException] = None) -> None:
        """Manually capture an exception."""
        if not self.is_connected:
            return
        if exc is None:
            exc_type, exc, exc_tb = sys.exc_info()
            if exc is None:
                return
        else:
            exc_type = type(exc)
            exc_tb = exc.__traceback__

        stack = "".join(traceback.format_exception(exc_type, exc, exc_tb))
        self._send_event({
            "eventType": "console",
            "level": "error",
            "message": f"[Uncaught] {exc_type.__name__}: {exc}",
            "args": [{"name": exc_type.__name__, "message": str(exc)}],
            "stackTrace": stack,
            "source": "server",
        })

    def emit_http(
        self,
        method: str,
        url: str,
        status: int,
        duration_ms: float,
        request_headers: Optional[Dict[str, str]] = None,
        response_headers: Optional[Dict[str, str]] = None,
        request_body_size: int = 0,
        response_body_size: int = 0,
    ) -> None:
        """Emit a network event — used by framework middleware."""
        if not self.is_connected:
            return
        self._send_event({
            "eventType": "network",
            "method": method,
            "url": url,
            "status": status,
            "duration": duration_ms,
            "ttfb": duration_ms,
            "requestHeaders": request_headers or {},
            "responseHeaders": response_headers or {},
            "requestBodySize": request_body_size,
            "responseBodySize": response_body_size,
            "source": "server-http",
        })

    def disconnect(self) -> None:
        """Flush and shut down the transport. Restores any patched hooks."""
        if self._original_excepthook is not None:
            sys.excepthook = self._original_excepthook
            self._original_excepthook = None
        if self._logging_handler is not None:
            logging.getLogger().removeHandler(self._logging_handler)
            self._logging_handler = None
        if self._transport is not None:
            self._transport.close()
            self._transport = None
        self._enabled = False
        self._session_id = None

    # Internal — used by integrations
    def _send_event(self, event: Dict[str, Any]) -> None:
        if not self._transport or not self._session_id:
            return
        full = {
            "eventId": _generate_event_id(),
            "sessionId": self._session_id,
            "timestamp": now_ms(),
            **event,
        }
        self._transport.send(full)

    # ------------------------------------------------------------------ private

    def _install_excepthook(self) -> None:
        original = sys.excepthook
        self._original_excepthook = original

        def hook(exc_type, exc, exc_tb):
            try:
                if self.is_connected:
                    stack = "".join(traceback.format_exception(exc_type, exc, exc_tb))
                    self._send_event({
                        "eventType": "console",
                        "level": "error",
                        "message": f"[Uncaught] {exc_type.__name__}: {exc}",
                        "args": [{"name": exc_type.__name__, "message": str(exc)}],
                        "stackTrace": stack,
                        "source": "server",
                    })
            except Exception:
                pass
            original(exc_type, exc, exc_tb)

        sys.excepthook = hook

    def _install_logging_handler(self) -> None:
        handler = _RuntimeScopeLoggingHandler(self)
        # Only forward WARNING and above by default — less noise
        handler.setLevel(logging.WARNING)
        logging.getLogger().addHandler(handler)
        self._logging_handler = handler


class _RuntimeScopeLoggingHandler(logging.Handler):
    """Forwards Python `logging` records as console events."""

    # Avoid the handler re-entering itself via our own logger
    _RECURSION_GUARD_LOGGER = "runtimescope"

    def __init__(self, client: "_RuntimeScopeImpl") -> None:
        super().__init__()
        self._client = client

    def emit(self, record: logging.LogRecord) -> None:
        if record.name.startswith(self._RECURSION_GUARD_LOGGER):
            return
        try:
            level_map = {
                logging.DEBUG: "debug",
                logging.INFO: "info",
                logging.WARNING: "warn",
                logging.ERROR: "error",
                logging.CRITICAL: "error",
            }
            level = level_map.get(record.levelno, "info")
            msg = record.getMessage()
            stack: Optional[str] = None
            if record.exc_info:
                stack = "".join(traceback.format_exception(*record.exc_info))
            self._client._send_event({
                "eventType": "console",
                "level": level,
                "message": msg,
                "args": [{"logger": record.name}],
                **({"stackTrace": stack} if stack else {}),
                "source": "server",
            })
        except Exception:
            pass


# Singleton instance — mirrors the JS SDK's `RuntimeScope` class shape
RuntimeScope = _RuntimeScopeImpl()
