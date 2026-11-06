"""The offline queue and the decision of when to send anything at all."""

import json
from datetime import datetime, timedelta, timezone

import pytest

import orchestrator

OFFLINE = {"success": False, "error": "connection refused"}
REJECTED = {"success": False, "error": "HTTP 401: Invalid signature", "permanent": True}
DELIVERED = {"success": True, "response": {}}


@pytest.fixture(autouse=True)
def empty_queue():
    orchestrator.conn.execute("DELETE FROM pending")
    orchestrator.conn.execute("DELETE FROM dead_letter")
    orchestrator.conn.commit()


def reading(age_seconds=0):
    at = datetime.now(timezone.utc) - timedelta(seconds=age_seconds)
    return {"room_id": "room_101", "status": "vacant", "confidence": 0, "timestamp": at.isoformat()}


def stub_sender(monkeypatch, result):
    calls = []

    def send(**kwargs):
        calls.append(kwargs)
        return result

    monkeypatch.setattr(orchestrator, "send_room_metadata", send)
    return calls


def count(table):
    return orchestrator.conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]


def make_all_due():
    orchestrator.conn.execute("UPDATE pending SET next_retry_at = 0")
    orchestrator.conn.commit()


def test_a_network_outage_does_not_use_up_the_reading(monkeypatch):
    # Retries used to run out after about 15 seconds of downtime, far inside
    # the 5 minutes the backend would still have accepted the reading.
    stub_sender(monkeypatch, OFFLINE)
    orchestrator._store_pending(reading())
    for _ in range(20):
        make_all_due()
        orchestrator._flush_pending()
    assert count("pending") == 1
    assert count("dead_letter") == 0


def test_retries_keep_a_useful_pace_during_an_outage(monkeypatch):
    stub_sender(monkeypatch, OFFLINE)
    orchestrator._store_pending(reading())
    for _ in range(12):
        make_all_due()
        orchestrator._flush_pending()
    delay = orchestrator.conn.execute("SELECT next_retry_at FROM pending").fetchone()[0]
    assert delay - datetime.now(timezone.utc).timestamp() <= orchestrator.MAX_BACKOFF_SECONDS + 1


def test_a_reading_the_backend_would_refuse_as_stale_is_not_sent(monkeypatch):
    calls = stub_sender(monkeypatch, DELIVERED)
    orchestrator._store_pending(reading(age_seconds=orchestrator.MAX_QUEUE_AGE_SECONDS + 5))
    orchestrator._flush_pending()
    assert calls == []
    assert count("pending") == 0
    assert count("dead_letter") == 1


def test_a_rejected_reading_is_dead_lettered_at_once_with_the_reason(monkeypatch):
    stub_sender(monkeypatch, REJECTED)
    orchestrator._store_pending(reading())
    orchestrator._flush_pending()
    assert count("pending") == 0
    error = orchestrator.conn.execute("SELECT last_error FROM dead_letter").fetchone()[0]
    assert "401" in error


def test_a_delivered_reading_leaves_the_queue(monkeypatch):
    stub_sender(monkeypatch, DELIVERED)
    orchestrator._store_pending(reading())
    orchestrator._flush_pending()
    assert count("pending") == 0
    assert count("dead_letter") == 0


def test_one_failed_send_ends_the_flush_so_capture_is_not_held_up(monkeypatch):
    # Each failed send can block for the full request timeout.
    calls = stub_sender(monkeypatch, OFFLINE)
    for _ in range(5):
        orchestrator._store_pending(reading())
    orchestrator._flush_pending()
    assert len(calls) == 1


def test_a_new_reading_that_cannot_be_sent_is_queued(monkeypatch):
    stub_sender(monkeypatch, OFFLINE)
    orchestrator._deliver(reading())
    assert count("pending") == 1


def test_a_failed_send_is_not_retried_in_the_same_pass(monkeypatch):
    # The loop flushes right after sending. Retrying straight away would
    # double the time a network timeout holds up capture.
    calls = stub_sender(monkeypatch, OFFLINE)
    orchestrator._deliver(reading())
    orchestrator._flush_pending()
    assert len(calls) == 1


def test_a_new_reading_that_is_rejected_is_not_retried(monkeypatch):
    stub_sender(monkeypatch, REJECTED)
    orchestrator._deliver(reading())
    assert count("pending") == 0
    assert count("dead_letter") == 1
    assert json.loads(orchestrator.conn.execute("SELECT payload FROM dead_letter").fetchone()[0])["room_id"] == "room_101"


def verdict(settled=True, changed=False):
    return {"settled": settled, "changed": changed}


def test_nothing_is_sent_before_the_detector_has_evidence():
    # The detector starts out "occupied" on purpose. Sending that guess after
    # a reboot would clear an open warning for a room nobody is in.
    assert orchestrator._should_send(verdict(settled=False), 1000.0, 0.0) is False


def test_the_first_settled_verdict_goes_out_straight_away():
    assert orchestrator._should_send(verdict(), 1000.0, 0.0) is True


def test_state_changes_are_immediate_and_heartbeats_are_periodic():
    sent = 10_000.0
    assert orchestrator._should_send(verdict(), sent + 10, sent) is False
    assert orchestrator._should_send(verdict(changed=True), sent + 10, sent) is True
    assert orchestrator._should_send(verdict(), sent + orchestrator.HEARTBEAT_SECONDS, sent) is True


def test_a_good_configuration_has_no_problems():
    assert orchestrator.config_problems("room_101", "https://api.example/api/occupancy", "key") == []


@pytest.mark.parametrize(
    "room, url, secret, mentions",
    [
        ("room_unknown", "https://api.example/api/occupancy", "key", "ROOM_ID"),
        ("room_101", "https://<your-app>.vercel.app/api/occupancy", "key", "GHOST_BACKEND_URL"),
        ("room_101", "", "key", "GHOST_BACKEND_URL"),
        ("room_101", "https://api.example/api/occupancy", None, "GHOST_HMAC_SECRET"),
        ("room_101", "https://api.example/api/occupancy", "change-me-use-the-device-key-for-this-room", "GHOST_HMAC_SECRET"),
    ],
)
def test_a_device_refuses_to_start_on_a_bad_configuration(room, url, secret, mentions):
    # These used to run forever, queueing readings that could never arrive.
    problems = orchestrator.config_problems(room, url, secret)
    assert len(problems) == 1
    assert mentions in problems[0]
