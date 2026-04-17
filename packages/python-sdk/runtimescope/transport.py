"""HTTP transport — batches events and POSTs to the collector.

Uses urllib from the stdlib so we stay zero-dependency. Runs the flush loop
in a background daemon thread so it doesn't block the main app.
"""

from __future__ import annotations

import json
import threading
import time
import urllib.error
import urllib.request
from collections import deque
from typing import Any, Deque, Dict, List, Optional


class HttpTransport:
    """Batches events in memory and flushes them to the collector.

    Thread-safe. Events are accepted on the calling thread; the background
    flush thread handles HTTP. Network errors fail silently — the SDK should
    never break the user's app.
    """

    def __init__(
        self,
        url: str,
        session_id: str,
        app_name: str,
        sdk_version: str,
        auth_token: Optional[str] = None,
        project_id: Optional[str] = None,
        batch_size: int = 50,
        flush_interval_ms: int = 2000,
        max_queue_size: int = 10_000,
    ) -> None:
        self._url = url
        self._session_id = session_id
        self._app_name = app_name
        self._sdk_version = sdk_version
        self._auth_token = auth_token
        self._project_id = project_id
        self._batch_size = batch_size
        self._flush_interval = flush_interval_ms / 1000.0
        self._max_queue_size = max_queue_size

        self._queue: Deque[Dict[str, Any]] = deque()
        self._lock = threading.Lock()
        self._session_registered = False
        self._shutdown = threading.Event()

        self._thread = threading.Thread(
            target=self._flush_loop,
            name="runtimescope-transport",
            daemon=True,
        )
        self._thread.start()

    def send(self, event: Dict[str, Any]) -> None:
        """Queue an event for the next flush. O(1), non-blocking."""
        with self._lock:
            if len(self._queue) >= self._max_queue_size:
                # Drop oldest to make room — better than dropping new, which
                # would hide the most recent activity
                self._queue.popleft()
            self._queue.append(event)
            should_flush_now = len(self._queue) >= self._batch_size

        if should_flush_now:
            # Fire off a flush from the caller's thread, but don't block
            threading.Thread(target=self.flush, daemon=True).start()

    def flush(self) -> None:
        """Send all queued events immediately. Safe to call multiple times."""
        with self._lock:
            if not self._queue:
                return
            batch = list(self._queue)
            self._queue.clear()

        self._post(batch)

    def close(self) -> None:
        """Flush remaining events and stop the background thread."""
        self._shutdown.set()
        try:
            self.flush()
        except Exception:
            pass

    # ------------------------------------------------------------------ private

    def _flush_loop(self) -> None:
        while not self._shutdown.wait(self._flush_interval):
            try:
                self.flush()
            except Exception:
                # Never let a transport error bubble up and kill the thread
                pass

    def _post(self, batch: List[Dict[str, Any]]) -> None:
        payload: Dict[str, Any] = {
            "sessionId": self._session_id,
            "events": batch,
        }

        # Include registration fields on the first post so the collector can
        # create the session record
        if not self._session_registered:
            payload["appName"] = self._app_name
            payload["sdkVersion"] = self._sdk_version
            if self._project_id:
                payload["projectId"] = self._project_id

        body = json.dumps(payload, default=str).encode("utf-8")

        headers = {"Content-Type": "application/json"}
        if self._auth_token:
            headers["Authorization"] = f"Bearer {self._auth_token}"

        req = urllib.request.Request(
            self._url,
            data=body,
            headers=headers,
            method="POST",
        )

        try:
            with urllib.request.urlopen(req, timeout=5) as resp:
                if 200 <= resp.status < 300:
                    self._session_registered = True
        except (urllib.error.URLError, urllib.error.HTTPError, TimeoutError, OSError):
            # Network/server errors are non-fatal. Events in this batch are lost;
            # future batches will still attempt registration.
            pass
        except Exception:
            pass

    # Test helper
    def _queue_size(self) -> int:
        with self._lock:
            return len(self._queue)


_last_millis = 0


def now_ms() -> int:
    """Monotonic-ish millisecond timestamp."""
    global _last_millis
    ms = int(time.time() * 1000)
    # Guard against coarse clock ties
    if ms <= _last_millis:
        ms = _last_millis + 1
    _last_millis = ms
    return ms
