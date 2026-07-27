"""Tests for the experience-loop playbook store: write → recall closed loop."""

import json
import sys
sys.path.insert(0, "src")

from memory import PlaybookEntry, PlaybookStore


def _store(tmp_path):
    return PlaybookStore(str(tmp_path / "playbook.jsonl"))


class TestPersistence:
    def test_empty_store_recall_and_all(self, tmp_path):
        s = _store(tmp_path)
        assert s.all() == []
        assert s.recall("anything") == []

    def test_add_then_read_back(self, tmp_path):
        s = _store(tmp_path)
        s.add(PlaybookEntry(request="计算次日留存率", gate_type="scope", chosen="自然日活跃"))
        entries = s.all()
        assert len(entries) == 1
        assert entries[0].request == "计算次日留存率"
        assert entries[0].chosen == "自然日活跃"

    def test_survives_new_instance(self, tmp_path):
        path = tmp_path / "playbook.jsonl"
        PlaybookStore(str(path)).add(PlaybookEntry(request="生成销售额环比图", chosen="折线图"))
        # a fresh store pointed at the same file sees the entry (cross-session)
        reopened = PlaybookStore(str(path))
        assert len(reopened.all()) == 1

    def test_appends_not_overwrites(self, tmp_path):
        s = _store(tmp_path)
        s.add(PlaybookEntry(request="a", chosen="x"))
        s.add(PlaybookEntry(request="b", chosen="y"))
        assert len(s.all()) == 2

    def test_bad_lines_skipped(self, tmp_path):
        path = tmp_path / "playbook.jsonl"
        path.write_text('{"request": "ok", "chosen": "c"}\nnot json\n{bad}\n', encoding="utf-8")
        entries = PlaybookStore(str(path)).all()
        assert len(entries) == 1
        assert entries[0].request == "ok"


class TestRecall:
    def test_matching_ranks_above_unrelated(self, tmp_path):
        s = _store(tmp_path)
        s.add(PlaybookEntry(request="计算用户次日留存率", question="留存口径？", chosen="自然日活跃"))
        s.add(PlaybookEntry(request="生成销售额环比折线图", chosen="折线图"))
        hits = s.recall("次日留存率应该怎么算")
        assert hits, "expected a keyword match"
        assert hits[0][0].chosen == "自然日活跃"

    def test_unrelated_query_returns_empty(self, tmp_path):
        s = _store(tmp_path)
        s.add(PlaybookEntry(request="计算次日留存率", chosen="自然日活跃"))
        assert s.recall("天气预报明天下雨吗") == []

    def test_top_k_limit(self, tmp_path):
        s = _store(tmp_path)
        for i in range(5):
            s.add(PlaybookEntry(request=f"留存率计算方案 {i}", chosen=f"方案{i}"))
        hits = s.recall("留存率计算", top_k=2)
        assert len(hits) == 2

    def test_scores_descending(self, tmp_path):
        s = _store(tmp_path)
        s.add(PlaybookEntry(request="留存率留存率留存率", chosen="a"))
        s.add(PlaybookEntry(request="留存率 其他内容", chosen="b"))
        hits = s.recall("留存率")
        scores = [sc for _, sc in hits]
        assert scores == sorted(scores, reverse=True)


class TestUpsert:
    def test_first_write_is_add(self, tmp_path):
        s = _store(tmp_path)
        assert s.upsert(PlaybookEntry(request="计算次日留存率", gate_type="scope", chosen="自然日活跃")) == "add"
        assert len(s.all()) == 1

    def test_similar_same_choice_is_noop(self, tmp_path):
        s = _store(tmp_path)
        s.upsert(PlaybookEntry(request="计算用户次日留存率口径", gate_type="scope", chosen="自然日活跃"))
        action = s.upsert(PlaybookEntry(request="计算用户次日留存率口径", gate_type="scope", chosen="自然日活跃"))
        assert action == "noop"
        assert len(s.all()) == 1  # no duplicate

    def test_similar_different_choice_is_update(self, tmp_path):
        s = _store(tmp_path)
        s.upsert(PlaybookEntry(request="计算用户次日留存率口径", gate_type="scope", chosen="自然日活跃"))
        action = s.upsert(PlaybookEntry(request="计算用户次日留存率口径", gate_type="scope", chosen="登录日活跃"))
        assert action == "update"
        entries = s.all()
        assert len(entries) == 1  # replaced, not appended
        assert entries[0].chosen == "登录日活跃"  # corrected to the new choice

    def test_different_request_is_add(self, tmp_path):
        s = _store(tmp_path)
        s.upsert(PlaybookEntry(request="计算次日留存率", gate_type="scope", chosen="自然日活跃"))
        action = s.upsert(PlaybookEntry(request="生成销售额环比折线图", gate_type="scope", chosen="折线图"))
        assert action == "add"
        assert len(s.all()) == 2

    def test_different_gate_type_is_add(self, tmp_path):
        # same request text but a different gate_type must not collide → ADD
        s = _store(tmp_path)
        s.upsert(PlaybookEntry(request="分析用户留存", gate_type="scope", chosen="自然日活跃"))
        action = s.upsert(PlaybookEntry(request="分析用户留存", gate_type="direction", chosen="先看转化"))
        assert action == "add"
        assert len(s.all()) == 2

    def test_recall_still_correct_after_update(self, tmp_path):
        s = _store(tmp_path)
        s.upsert(PlaybookEntry(request="计算用户次日留存率口径", gate_type="scope", chosen="自然日活跃"))
        s.upsert(PlaybookEntry(request="计算用户次日留存率口径", gate_type="scope", chosen="登录日活跃"))
        hits = s.recall("次日留存率口径怎么算")
        assert hits
        assert hits[0][0].chosen == "登录日活跃"  # recall surfaces the corrected value

    def test_bad_lines_do_not_break_rewrite(self, tmp_path):
        path = tmp_path / "playbook.jsonl"
        # a valid entry we'll later correct, plus junk lines that all() skips
        path.write_text(
            '{"request": "计算次日留存率口径", "gate_type": "scope", "chosen": "自然日活跃"}\n'
            "not json\n{bad}\n",
            encoding="utf-8",
        )
        s = PlaybookStore(str(path))
        action = s.upsert(PlaybookEntry(request="计算次日留存率口径", gate_type="scope", chosen="登录日活跃"))
        assert action == "update"
        entries = s.all()
        assert len(entries) == 1  # rewrite dropped the junk, kept the corrected entry
        assert entries[0].chosen == "登录日活跃"


class TestAnnotateGate:
    def _gate(self):
        return {
            "type": "scope",
            "question": "「留存」用哪个口径？",
            "options": [
                {"label": "次日留存 (D1)", "evidence": "最简单", "recommended": True},
                {"label": "7日/30日留存", "evidence": "成本更高"},
            ],
        }

    def test_hit_marks_precedent_option(self, tmp_path):
        s = _store(tmp_path)
        s.add(PlaybookEntry(request="帮我分析用户次日留存口径", gate_type="scope", chosen="7日/30日留存"))
        gate = self._gate()
        assert s.annotate_gate(gate, "帮我分析用户次日留存口径") is True
        opts = gate["options"]
        assert opts[1]["recommended"] is True          # precedent option now preselected
        assert "recommended" not in opts[0]            # single-recommended invariant
        assert "上次相似诉求你选了这个" in opts[1]["evidence"]

    def test_miss_leaves_gate_untouched(self, tmp_path):
        s = _store(tmp_path)
        s.add(PlaybookEntry(request="生成销售额环比折线图", gate_type="scope", chosen="7日/30日留存"))
        gate = self._gate()
        before = json.loads(json.dumps(gate))
        assert s.annotate_gate(gate, "帮我看看今天天气") is False
        assert gate == before  # completely unchanged

    def test_empty_store_no_annotation(self, tmp_path):
        s = _store(tmp_path)
        gate = self._gate()
        assert s.annotate_gate(gate, "任意诉求") is False

    def test_different_gate_type_ignored(self, tmp_path):
        s = _store(tmp_path)
        s.add(PlaybookEntry(request="帮我分析用户次日留存口径", gate_type="direction", chosen="7日/30日留存"))
        gate = self._gate()  # type == scope
        assert s.annotate_gate(gate, "帮我分析用户次日留存口径") is False

    def test_chosen_not_in_current_options(self, tmp_path):
        # precedent exists but its choice isn't among the current gate's options
        s = _store(tmp_path)
        s.add(PlaybookEntry(request="帮我分析用户次日留存口径", gate_type="scope", chosen="分群留存"))
        gate = self._gate()
        assert s.annotate_gate(gate, "帮我分析用户次日留存口径") is False
