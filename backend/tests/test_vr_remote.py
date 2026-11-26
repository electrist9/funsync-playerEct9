"""Tests for the VR (WebXR) static mount, shared-JS whitelist, cache headers,
network-info scheme reporting, and the `clientKind` WebSocket passthrough.

The VR SPA itself is static assets — these tests lock down the serving
plumbing around it, not the XR app.
"""

import time

import pytest
from fastapi.testclient import TestClient

from main import app
from routes.remote_sync import _reset_state_for_tests, _get_state_for_tests


@pytest.fixture(autouse=True)
def reset_remote_sync_state():
    _reset_state_for_tests()
    yield
    _reset_state_for_tests()


@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c


# --- /vr/ static mount ------------------------------------------------------

def test_vr_mount_serves_placeholder(client):
    res = client.get("/vr/")
    assert res.status_code == 200
    assert "FunSync VR" in res.text
    # no-cache like the 2D remote: an app update must not mix stale assets.
    assert res.headers.get("cache-control") == "no-cache"


def test_vr_bare_path_redirects(client):
    res = client.get("/vr", follow_redirects=False)
    assert res.status_code in (301, 302, 307)
    assert "/vr/" in res.headers["location"]


# --- /shared-js/ whitelist ----------------------------------------------------

def test_shared_js_serves_whitelisted_modules(client):
    for name in ("slideshow-timing.js", "slideshow-color.js"):
        res = client.get(f"/shared-js/{name}")
        assert res.status_code == 200, name
        assert res.headers["content-type"].startswith("application/javascript")
        assert "export" in res.text
        assert res.headers.get("cache-control") == "no-cache"


def test_shared_js_blocks_non_whitelisted(client):
    # Any file outside the whitelist 404s — no directory browsing, no
    # arbitrary reads of renderer/ or backend/.
    assert client.get("/shared-js/main.js").status_code == 404
    assert client.get("/shared-js/slideshow-timing.json").status_code == 404
    assert client.get("/shared-js/").status_code == 404


def test_shared_js_blocks_traversal(client):
    # %2e%2e decodes to ".." only after routing, so the whitelist check is
    # the guard; either way it must never resolve to a real file.
    assert client.get("/shared-js/%2e%2e").status_code == 404
    assert client.get("/shared-js/%2e%2e%2fmain").status_code == 404


# --- /network-info scheme ----------------------------------------------------

def test_network_info_reports_plain_http_without_tls(client):
    res = client.get("/network-info")
    assert res.status_code == 200
    body = res.json()
    # Tests always run the plain-ASGI app, so TLS is off here.
    assert body["tls"] is False
    assert body["scheme"] == "http"
    assert "ip" in body


# --- clientKind passthrough (VR client hint) ---------------------------------

def test_ws_client_kind_vr_from_query(client):
    with client.websocket_connect("/api/remote/sync?videoId=vr1&clientKind=vr"):
        state = _get_state_for_tests()
        assert state["has_phone"] is True
        assert state["phone_client_kind"] == "vr"


def test_ws_client_kind_vr_from_hello(client):
    with client.websocket_connect("/api/remote/sync?videoId=vr2") as ws:
        ws.send_json({"type": "hello", "videoId": "vr2", "clientKind": "vr"})
        time.sleep(0.05)
        assert _get_state_for_tests()["phone_client_kind"] == "vr"


def test_ws_client_kind_other_values_treated_as_phone(client):
    with client.websocket_connect("/api/remote/sync?videoId=x&clientKind=hacked"):
        assert _get_state_for_tests()["phone_client_kind"] is None


def test_ws_plain_phone_has_no_client_kind(client):
    with client.websocket_connect("/api/remote/sync?videoId=x"):
        assert _get_state_for_tests()["phone_client_kind"] is None


def test_observer_sees_client_kind(client):
    with client.websocket_connect("/api/remote/sync/observe") as obs:
        with client.websocket_connect("/api/remote/sync?videoId=vr3&clientKind=vr"):
            msg = obs.receive_json()
            assert msg["type"] == "phone-connected"
            assert msg["videoId"] == "vr3"
            assert msg["clientKind"] == "vr"


def test_observer_catch_up_carries_client_kind(client):
    with client.websocket_connect("/api/remote/sync?videoId=vr4&clientKind=vr") as phone:
        phone.send_json({"type": "state", "at": 100, "paused": True})
        time.sleep(0.05)
        with client.websocket_connect("/api/remote/sync/observe") as obs:
            first = obs.receive_json()
            assert first["type"] == "phone-connected"
            assert first["clientKind"] == "vr"
