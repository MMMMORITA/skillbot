"""Tests for PromptBuilder execution modes: pipeline vs exploration assembly."""

import sys
sys.path.insert(0, "src")

from agent.prompt import PromptBuilder, SECTIONS


class TestExecutionModes:
    def test_default_is_pipeline(self):
        p = PromptBuilder.main()
        assert SECTIONS["pipeline"] in p
        assert SECTIONS["exploration"] not in p

    def test_exploration_swaps_posture(self):
        p = PromptBuilder.main(mode="exploration")
        assert SECTIONS["exploration"] in p
        assert SECTIONS["pipeline"] not in p

    def test_pipeline_explicit(self):
        assert PromptBuilder.main(mode="pipeline") == PromptBuilder.main()

    def test_plan_mode_alias_maps_to_exploration(self):
        assert PromptBuilder.main(plan_mode=True) == PromptBuilder.main(mode="exploration")

    def test_unknown_mode_falls_back_to_pipeline(self):
        assert PromptBuilder.main(mode="bogus") == PromptBuilder.main()

    def test_explicit_mode_overrides_plan_mode_flag(self):
        # mode= takes precedence over the legacy plan_mode bool
        assert PromptBuilder.main(plan_mode=True, mode="pipeline") == PromptBuilder.main()

    def test_both_modes_share_common_sections(self):
        pipe = PromptBuilder.main(mode="pipeline")
        expl = PromptBuilder.main(mode="exploration")
        for key in ("role", "output", "decision_gate", "tool_usage"):
            assert SECTIONS[key] in pipe
            assert SECTIONS[key] in expl

    def test_modes_constant(self):
        assert PromptBuilder.MODES == ("pipeline", "exploration")
