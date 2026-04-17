"""DSN (Data Source Name) parser — mirrors @runtimescope/sdk."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional
from urllib.parse import urlparse


@dataclass
class ParsedDsn:
    """Parsed form of a RuntimeScope DSN."""

    project_id: str
    ws_endpoint: str  # ws(s)://host:wsport
    http_endpoint: str  # http(s)://host:httpport
    app_name: Optional[str]
    tls: bool


def parse_dsn(dsn: str) -> ParsedDsn:
    """Parse a DSN string like `runtimescope://proj_abc@localhost:6768/my-app`.

    Raises ValueError for malformed DSNs.

    The HTTP port is the canonical port in the DSN. The WebSocket port is
    derived as `http_port - 1` to match the collector's convention (6768/6767).
    """
    if not isinstance(dsn, str):
        raise ValueError("DSN must be a string")

    tls = dsn.startswith("runtimescopes://")
    if not dsn.startswith("runtimescope://") and not tls:
        raise ValueError(
            "Invalid RuntimeScope DSN: must start with runtimescope:// or runtimescopes://"
        )

    # Replace our custom protocol with http:// so urllib can parse it reliably
    normalized = dsn.replace("runtimescopes://", "http://", 1) if tls else dsn.replace(
        "runtimescope://", "http://", 1
    )
    url = urlparse(normalized)

    project_id = url.username or ""
    if not project_id or not project_id.startswith("proj_"):
        raise ValueError(
            "Invalid RuntimeScope DSN: missing projectId (expected proj_xxx@host)"
        )

    host = url.hostname
    if not host:
        raise ValueError("Invalid RuntimeScope DSN: missing host")

    http_port = url.port or 6768
    ws_port = http_port - 1

    app_name = url.path.lstrip("/") if url.path else ""
    app_name_opt: Optional[str] = app_name if app_name else None

    ws_proto = "wss" if tls else "ws"
    http_proto = "https" if tls else "http"

    return ParsedDsn(
        project_id=project_id,
        ws_endpoint=f"{ws_proto}://{host}:{ws_port}",
        http_endpoint=f"{http_proto}://{host}:{http_port}",
        app_name=app_name_opt,
        tls=tls,
    )


def build_dsn(
    project_id: str,
    host: str = "localhost",
    port: int = 6768,
    app_name: Optional[str] = None,
    tls: bool = False,
) -> str:
    """Build a DSN string from individual fields."""
    proto = "runtimescopes" if tls else "runtimescope"
    path = f"/{app_name}" if app_name else ""
    return f"{proto}://{project_id}@{host}:{port}{path}"
