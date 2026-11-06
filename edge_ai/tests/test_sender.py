"""How backend responses are classified: delivered, retry later, or give up."""

import pytest
import requests

import metadata_sender


class Response:
    def __init__(self, status_code, body=None, text=""):
        self.status_code = status_code
        self._body = body or {}
        self.text = text

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise requests.HTTPError(f"{self.status_code} error")


@pytest.fixture(autouse=True)
def signing_key(monkeypatch):
    monkeypatch.setenv("GHOST_HMAC_SECRET", "test-secret")


def send(monkeypatch, outcome):
    def post(*_args, **_kwargs):
        if isinstance(outcome, Exception):
            raise outcome
        return outcome

    monkeypatch.setattr(metadata_sender.requests, "post", post)
    return metadata_sender.send_room_metadata("room_101", "vacant", 0.0, "2026-01-01T00:00:00+00:00")


def test_accepted(monkeypatch):
    assert send(monkeypatch, Response(200, {"outcome": "warned"}))["success"] is True


def test_a_duplicate_counts_as_delivered(monkeypatch):
    assert send(monkeypatch, Response(409))["success"] is True


@pytest.mark.parametrize("status", [400, 401, 403, 404])
def test_a_rejection_will_never_succeed_so_it_is_permanent(monkeypatch, status):
    result = send(monkeypatch, Response(status, text='{"error":"nope"}'))
    assert result["success"] is False
    assert result["permanent"] is True
    assert str(status) in result["error"]
    assert "nope" in result["error"]


@pytest.mark.parametrize("status", [408, 429, 500, 503])
def test_server_trouble_is_worth_retrying(monkeypatch, status):
    result = send(monkeypatch, Response(status))
    assert result["success"] is False
    assert not result.get("permanent")


def test_a_network_failure_is_worth_retrying(monkeypatch):
    result = send(monkeypatch, requests.ConnectionError("no route to host"))
    assert result["success"] is False
    assert not result.get("permanent")
    assert "no route" in result["error"]
