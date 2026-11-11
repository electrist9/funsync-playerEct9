"""Tests for the shared funscript construction / post-processing layer."""

import sys
import os

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from services.funscript import parse_funscript
from services.funscript_build import (
    BuildError,
    apply_idle_segments,
    build_funscript,
    cap_actions,
    clamp_pos,
    enforce_min_interval,
    events_to_actions,
    finalize_actions,
    limit_speed,
    reduce_keyframes,
    signal_to_actions,
    speed_limit_for,
    to_funscript,
)


class TestClampPos:
    def test_rounds_and_clamps(self):
        assert clamp_pos(49.6, 0, 100) == 50
        assert clamp_pos(-5, 0, 100) == 0
        assert clamp_pos(140, 0, 100) == 100

    def test_respects_custom_bounds(self):
        assert clamp_pos(10, 40, 60) == 40
        assert clamp_pos(90, 40, 60) == 60

    def test_reversed_bounds_are_normalized(self):
        assert clamp_pos(70, 60, 40) == 60
        assert clamp_pos(10, 60, 40) == 40


class TestSpeedLimitFor:
    def test_known_devices(self):
        assert speed_limit_for("handy") == 400
        assert speed_limit_for("handy2") == 320
        assert speed_limit_for("handy2pro") == 360
        assert speed_limit_for("handy2pro_oc") == 640

    def test_case_and_separator_insensitive(self):
        assert speed_limit_for("Handy 2 Pro") == 360

    def test_disable_words_mean_no_limit(self):
        for value in ("", "none", "off", "unlimited", None):
            assert speed_limit_for(value) is None

    def test_override_wins(self):
        assert speed_limit_for("handy", 250) == 250

    def test_unknown_device_raises(self):
        with pytest.raises(BuildError, match="Unknown device"):
            speed_limit_for("floppy")


class TestEventsToActions:
    def test_alternating_swings_between_ends(self):
        actions = events_to_actions([(0, 1.0), (500, 1.0), (1000, 1.0)])
        assert [(a["at"], a["pos"]) for a in actions] == [(0, 100), (500, 0), (1000, 100)]

    def test_weak_event_does_not_swing_all_the_way(self):
        actions = events_to_actions([(0, 1.0), (500, 0.4)])
        assert actions[1]["pos"] == 60

    def test_sine_makes_a_full_stroke_per_event(self):
        actions = events_to_actions([(0, 1.0), (1000, 1.0)], style="sine")
        # Peak a quarter period in, back to the low end at the next event;
        # the last event's return leg uses the previous gap as its period.
        assert [(a["at"], a["pos"]) for a in actions] == [(250, 100), (1000, 0), (1250, 100), (2000, 0)]

    def test_energy_follows_strength(self):
        actions = events_to_actions([(0, 0.2), (500, 0.8)], style="energy")
        assert [(a["at"], a["pos"]) for a in actions] == [(0, 20), (500, 80)]

    def test_custom_range(self):
        actions = events_to_actions([(0, 1.0), (500, 1.0)], min_pos=20, max_pos=80)
        assert [a["pos"] for a in actions] == [80, 20]

    def test_unsorted_events_are_sorted(self):
        actions = events_to_actions([(1000, 1.0), (0, 1.0)])
        assert [a["at"] for a in actions] == [0, 1000]

    def test_unknown_style_raises(self):
        with pytest.raises(BuildError, match="Unknown style"):
            events_to_actions([(0, 1.0)], style="tornado")

    def test_invalid_range_raises(self):
        with pytest.raises(BuildError):
            events_to_actions([(0, 1.0)], min_pos=80, max_pos=20)


class TestSignalToActions:
    def test_signed_signal_maps_onto_the_range(self):
        actions = signal_to_actions([(0, -1.0), (500, 0.0), (1000, 1.0)])
        assert [(a["at"], a["pos"]) for a in actions] == [(0, 0), (500, 50), (1000, 100)]

    def test_values_are_clipped(self):
        actions = signal_to_actions([(0, -3.0), (500, 3.0)])
        assert [a["pos"] for a in actions] == [0, 100]

    def test_custom_range(self):
        actions = signal_to_actions([(0, 0.0)], min_pos=30, max_pos=70)
        assert actions[0]["pos"] == 50


class TestReduceKeyframes:
    def test_collinear_points_are_dropped(self):
        actions = [{"at": 0, "pos": 0}, {"at": 500, "pos": 50}, {"at": 1000, "pos": 100}]
        assert reduce_keyframes(actions, tolerance=2.0) == [{"at": 0, "pos": 0}, {"at": 1000, "pos": 100}]

    def test_turnarounds_survive(self):
        actions = [{"at": 0, "pos": 0}, {"at": 500, "pos": 100}, {"at": 1000, "pos": 0}]
        assert len(reduce_keyframes(actions, tolerance=20.0)) == 3

    def test_zero_tolerance_is_a_noop(self):
        actions = [{"at": 0, "pos": 0}, {"at": 500, "pos": 50}, {"at": 1000, "pos": 100}]
        assert reduce_keyframes(actions, tolerance=0) == actions


class TestEnforceMinInterval:
    def test_same_millisecond_duplicates_keep_the_more_extreme(self):
        actions = [{"at": 100, "pos": 45}, {"at": 100, "pos": 90}]
        assert enforce_min_interval(actions, 120) == [{"at": 100, "pos": 90}]

    def test_points_too_close_are_thinned_keeping_the_bigger_move(self):
        # (50, 0) is only 50 ms after (0, 100): the pair collapses to the
        # point that preserves the larger stroke, here the far one.
        actions = [{"at": 0, "pos": 100}, {"at": 50, "pos": 0}, {"at": 500, "pos": 100}]
        assert enforce_min_interval(actions, 120) == [{"at": 50, "pos": 0}, {"at": 500, "pos": 100}]

    def test_output_is_sorted(self):
        actions = [{"at": 900, "pos": 0}, {"at": 100, "pos": 100}]
        assert [a["at"] for a in enforce_min_interval(actions, 0)] == [100, 900]

    def test_empty_input(self):
        assert enforce_min_interval([], 120) == []


class TestLimitSpeed:
    def test_impossible_jump_is_clamped_to_the_reachable_position(self):
        actions = [{"at": 0, "pos": 0}, {"at": 100, "pos": 100}]
        limited = limit_speed(actions, 400)
        assert limited[1]["pos"] == 40

    def test_sequential_walk_spreads_a_long_move(self):
        actions = [{"at": 0, "pos": 0}, {"at": 100, "pos": 100}, {"at": 200, "pos": 100}]
        limited = limit_speed(actions, 400)
        assert [a["pos"] for a in limited] == [0, 40, 80]

    def test_no_limit_passes_through(self):
        actions = [{"at": 0, "pos": 0}, {"at": 10, "pos": 100}]
        assert limit_speed(actions, None) == actions

    def test_zero_dt_does_not_move_backwards(self):
        actions = [{"at": 0, "pos": 10}, {"at": 0, "pos": 90}]
        assert limit_speed(actions, 400)[1] == {"at": 0, "pos": 10}


class TestCapActions:
    def test_density_ceiling_is_ten_per_second(self):
        actions = [{"at": i * 10, "pos": 0 if i % 2 else 100} for i in range(100)]
        capped = cap_actions(actions, 0, 1000)
        assert len(capped) == 10
        assert [a["at"] for a in capped] == sorted(a["at"] for a in capped)

    def test_under_the_cap_is_untouched(self):
        actions = [{"at": 0, "pos": 0}, {"at": 500, "pos": 100}]
        assert cap_actions(actions, 0, 1000) == actions


class TestApplyIdleSegments:
    def test_actions_inside_the_window_are_replaced_by_a_hold(self):
        actions = [{"at": 0, "pos": 100}, {"at": 2000, "pos": 0}, {"at": 3000, "pos": 100}, {"at": 6000, "pos": 0}]
        result = apply_idle_segments(actions, [(1500, 5000)])
        assert [(a["at"], a["pos"]) for a in result] == [(0, 100), (1500, 0), (5000, 0), (6000, 0)]

    def test_hold_position_is_configurable(self):
        actions = [{"at": 0, "pos": 100}, {"at": 5000, "pos": 100}]
        result = apply_idle_segments(actions, [(1000, 2000)], hold_pos=30)
        assert [a["pos"] for a in result if 1000 <= a["at"] <= 2000] == [30, 30]

    def test_no_windows_is_a_noop(self):
        actions = [{"at": 0, "pos": 100}]
        assert apply_idle_segments(actions, []) == actions


class TestFinalizeActions:
    def test_chain_respects_the_speed_limit_and_range(self):
        raw = events_to_actions([(i * 100.0, 1.0) for i in range(20)])
        result = finalize_actions(raw, start_ms=0, end_ms=2000, speed_limit=400)
        assert all(0 <= a["pos"] <= 100 for a in result)
        for prev, nxt in zip(result, result[1:]):
            dt = (nxt["at"] - prev["at"]) / 1000.0
            assert abs(nxt["pos"] - prev["pos"]) <= 400 * dt + 1

    def test_idle_windows_park_the_device(self):
        raw = events_to_actions([(0, 1.0), (3000, 1.0), (6000, 1.0)])
        result = finalize_actions(raw, idle_windows=[(1000, 5000)])
        inside = [a for a in result if 1000 <= a["at"] <= 5000]
        assert all(a["pos"] == 0 for a in inside)

    def test_custom_range_is_enforced(self):
        raw = events_to_actions([(0, 1.0), (500, 1.0)])
        result = finalize_actions(raw, min_pos=20, max_pos=60)
        assert all(20 <= a["pos"] <= 60 for a in result)

    def test_invalid_range_raises(self):
        with pytest.raises(BuildError):
            finalize_actions([{"at": 0, "pos": 10}], min_pos=60, max_pos=20)


class TestToFunscriptAndBuild:
    def test_output_parses_as_a_funscript(self):
        script = build_funscript(events_to_actions([(0, 1.0), (500, 1.0)]))
        parsed = parse_funscript(__import__("json").dumps(script))
        assert parsed["version"] == "1.0"
        assert [a["at"] for a in parsed["actions"]] == [0, 500]

    def test_inverted_and_range_flags(self):
        script = build_funscript(events_to_actions([(0, 1.0)]), inverted=True, max_pos=80)
        assert script["inverted"] is True
        assert script["range"] == 80

    def test_empty_input_yields_empty_actions(self):
        script = build_funscript([])
        assert script["actions"] == []
