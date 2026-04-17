"""Unit tests for the DSN parser."""

import pytest

from runtimescope.dsn import build_dsn, parse_dsn


class TestParseDsn:
    def test_parses_standard_local_dsn(self) -> None:
        p = parse_dsn("runtimescope://proj_abc123@localhost:6768/my-app")
        assert p.project_id == "proj_abc123"
        assert p.ws_endpoint == "ws://localhost:6767"
        assert p.http_endpoint == "http://localhost:6768"
        assert p.app_name == "my-app"
        assert p.tls is False

    def test_parses_dsn_without_app_name(self) -> None:
        p = parse_dsn("runtimescope://proj_abc@localhost:6768")
        assert p.project_id == "proj_abc"
        assert p.app_name is None

    def test_parses_tls_dsn(self) -> None:
        p = parse_dsn("runtimescopes://proj_xyz@collector.example.com:443/app")
        assert p.tls is True
        assert p.ws_endpoint == "wss://collector.example.com:442"
        assert p.http_endpoint == "https://collector.example.com:443"
        assert p.app_name == "app"

    def test_default_port_is_6768(self) -> None:
        p = parse_dsn("runtimescope://proj_abc@localhost")
        assert p.http_endpoint == "http://localhost:6768"
        assert p.ws_endpoint == "ws://localhost:6767"

    def test_round_trip(self) -> None:
        dsn = build_dsn(project_id="proj_abc", host="example.com", port=8091, app_name="web")
        parsed = parse_dsn(dsn)
        assert parsed.project_id == "proj_abc"
        assert parsed.app_name == "web"
        assert parsed.http_endpoint == "http://example.com:8091"

    def test_invalid_protocol_raises(self) -> None:
        with pytest.raises(ValueError, match="must start with"):
            parse_dsn("http://proj_abc@localhost:6768")

    def test_missing_project_id_raises(self) -> None:
        with pytest.raises(ValueError, match="missing projectId"):
            parse_dsn("runtimescope://localhost:6768")

    def test_project_id_must_start_with_proj(self) -> None:
        with pytest.raises(ValueError, match="missing projectId"):
            parse_dsn("runtimescope://notavalidprefix@localhost:6768")


class TestBuildDsn:
    def test_builds_minimal_dsn(self) -> None:
        assert build_dsn(project_id="proj_abc") == "runtimescope://proj_abc@localhost:6768"

    def test_builds_with_all_fields(self) -> None:
        assert (
            build_dsn(project_id="proj_x", host="collector.example.com", port=443, app_name="api", tls=True)
            == "runtimescopes://proj_x@collector.example.com:443/api"
        )
