"""Integration tests for the client — uses a stub HTTP server."""

import json
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import List

import pytest


@pytest.fixture
def stub_collector():
    """Spin up a tiny HTTP server that records every request body."""
    received: List[dict] = []

    class Handler(BaseHTTPRequestHandler):
        def do_POST(self):  # noqa: N802
            length = int(self.headers.get("Content-Length", "0"))
            body = self.rfile.read(length) if length else b"{}"
            try:
                received.append(json.loads(body))
            except Exception:
                pass
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(b'{"ok":true}')

        def log_message(self, *_args, **_kwargs):
            # Silence default request logging during tests
            pass

    # Bind on port 0 so the OS picks a free port
    server = HTTPServer(("127.0.0.1", 0), Handler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    yield port, received

    server.shutdown()
    server.server_close()


def _free_port_pair(http_port: int) -> None:
    """Confirm the derived ws_port (http_port - 1) doesn't matter for the HTTP test."""
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    s.close()


def test_connect_with_no_dsn_is_silent_noop():
    """Production safety: no DSN, no connection, no errors."""
    # Reload to get a fresh singleton state
    import importlib

    from runtimescope import client as c

    importlib.reload(c)
    assert c.RuntimeScope.is_connected is False
    c.RuntimeScope.connect()  # No dsn
    assert c.RuntimeScope.is_connected is False


def test_track_event_gets_posted(stub_collector):
    port, received = stub_collector

    import importlib

    from runtimescope import client as c

    importlib.reload(c)

    c.RuntimeScope.connect(
        dsn=f"runtimescope://proj_test@127.0.0.1:{port}/test-app",
        flush_interval_ms=100,
        batch_size=2,  # Flush after 2 events
    )

    c.RuntimeScope.track("user_action", {"foo": "bar"})
    c.RuntimeScope.track("second_event")

    # Allow flush thread to post
    for _ in range(20):
        if received:
            break
        time.sleep(0.1)

    c.RuntimeScope.disconnect()

    assert len(received) >= 1
    first_body = received[0]
    assert first_body["sessionId"]
    events = first_body["events"]
    assert any(e.get("eventType") == "session" for e in events)
    assert any(
        e.get("eventType") == "custom" and e.get("name") == "user_action" for e in events
    )


def test_invalid_dsn_is_silent_noop():
    import importlib

    from runtimescope import client as c

    importlib.reload(c)
    c.RuntimeScope.connect(dsn="not-a-valid-dsn")
    assert c.RuntimeScope.is_connected is False
