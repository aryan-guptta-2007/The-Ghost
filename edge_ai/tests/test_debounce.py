"""PresenceDetector must not flip state on a few noisy frames."""

import pytest

import human_presence


class ScriptedBackend:
    name = "scripted"

    def __init__(self, frames):
        self._frames = iter(frames)

    def detect(self, _frame):
        present = next(self._frames)
        return present, 0.8 if present else 0.0

    def close(self):
        pass


def run(monkeypatch, frames):
    monkeypatch.setattr(human_presence, "_build_backend", lambda: ScriptedBackend(frames))
    detector = human_presence.PresenceDetector(window_size=10, threshold=7)
    return [detector.update(None) for _ in frames]


def test_starts_occupied_and_ignores_brief_absence(monkeypatch):
    # Six empty frames out of ten is not enough evidence to accuse anyone.
    verdicts = run(monkeypatch, [False] * 6 + [True] * 4)
    assert all(v["occupied"] for v in verdicts)
    assert not any(v["changed"] for v in verdicts)


def test_flips_to_vacant_after_seven_of_ten(monkeypatch):
    verdicts = run(monkeypatch, [False] * 7)
    assert [v["occupied"] for v in verdicts] == [True] * 6 + [False]
    assert verdicts[-1]["changed"] is True


def test_flips_back_when_person_returns(monkeypatch):
    verdicts = run(monkeypatch, [False] * 10 + [True] * 7)
    assert verdicts[9]["occupied"] is False
    assert verdicts[-1]["occupied"] is True
    assert verdicts[-1]["changed"] is True


def test_threshold_cannot_exceed_window(monkeypatch):
    monkeypatch.setattr(human_presence, "_build_backend", lambda: ScriptedBackend([]))
    with pytest.raises(ValueError):
        human_presence.PresenceDetector(window_size=5, threshold=6)
