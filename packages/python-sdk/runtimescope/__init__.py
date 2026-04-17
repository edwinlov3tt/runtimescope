"""RuntimeScope Python SDK.

Quick start:

    from runtimescope import RuntimeScope

    RuntimeScope.connect(
        dsn="runtimescope://proj_xxx@localhost:9091/my-app",
    )
    # Or set RUNTIMESCOPE_DSN in your environment and call with no args.

    RuntimeScope.track("user_signed_up", {"plan": "pro"})

Framework integrations live in `runtimescope.integrations`:

    - runtimescope.integrations.django
    - runtimescope.integrations.flask
    - runtimescope.integrations.fastapi
"""

from .client import SDK_VERSION, RuntimeScope
from .dsn import ParsedDsn, build_dsn, parse_dsn

__version__ = SDK_VERSION

__all__ = [
    "RuntimeScope",
    "parse_dsn",
    "build_dsn",
    "ParsedDsn",
    "SDK_VERSION",
    "__version__",
]
