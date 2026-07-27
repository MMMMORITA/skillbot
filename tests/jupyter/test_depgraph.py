"""Tests for the static data-dependency slice used by step revise-and-rerun."""

import sys
sys.path.insert(0, "src")

from jupyter.depgraph import analyze, dependent_cells


class TestAnalyze:
    def test_simple_read_write(self):
        reads, writes, mutates, ok = analyze("y = x + 1")
        assert reads == {"x"}
        assert writes == {"y"}
        assert mutates == set()
        assert ok is True

    def test_self_contained_not_a_read(self):
        # x is produced and consumed in the same cell → not a cross-cell dep.
        reads, writes, mutates, ok = analyze("x = 1\nprint(x)")
        assert "x" not in reads
        assert "x" in writes

    def test_def_and_class_are_writes(self):
        _, writes, _, ok = analyze("def foo():\n    pass\nclass Bar:\n    pass")
        assert {"foo", "Bar"} <= writes

    def test_import_is_write(self):
        _, writes, _, _ = analyze("import pandas as pd\nfrom os import path")
        assert "pd" in writes
        assert "path" in writes

    def test_sql_cell_not_analyzable(self):
        _, _, _, ok = analyze("%%sql\nSELECT * FROM t")
        assert ok is False

    def test_syntax_error_not_analyzable(self):
        _, _, _, ok = analyze("def (:")
        assert ok is False

    def test_exec_marks_dynamic(self):
        _, _, _, ok = analyze("exec('x = 1')")
        assert ok is False

    def test_star_import_marks_dynamic(self):
        _, _, _, ok = analyze("from os import *")
        assert ok is False

    def test_subscript_assign_is_mutate(self):
        reads, writes, mutates, ok = analyze("df['x'] = y")
        assert mutates == {"df"}
        assert "df" not in writes      # in-place, not a rebinding
        assert reads == {"df", "y"}    # df is still read (its base is loaded)

    def test_attribute_assign_is_mutate(self):
        _, _, mutates, _ = analyze("obj.attr = 5")
        assert mutates == {"obj"}

    def test_nested_subscript_peels_to_base(self):
        _, _, mutates, _ = analyze("d['a']['b'] = 1")
        assert mutates == {"d"}

    def test_freshly_bound_then_mutated_not_cross_cell(self):
        # df is created and mutated in the same cell → self-contained, no dep leak.
        _, writes, mutates, _ = analyze("df = make()\ndf['x'] = 1")
        assert "df" in writes
        assert "df" not in mutates


class TestDependentCells:
    def _cells(self, *specs):
        # specs: (id, code, exec)
        return [{"id": i, "code": c, "exec": e} for (i, c, e) in specs]

    def test_missing_id_returns_empty(self):
        cells = self._cells(("a", "x = 1", 1))
        assert dependent_cells(cells, "zzz") == []

    def test_only_dependents_are_rerun(self):
        cells = self._cells(
            ("a", "x = 1", 1),
            ("b", "y = x + 1", 2),   # depends on a
            ("c", "z = 99", 3),      # independent
            ("d", "w = y + z", 4),   # depends on b (via y)
        )
        assert dependent_cells(cells, "a") == ["a", "b", "d"]

    def test_independent_cell_change_only_itself(self):
        cells = self._cells(
            ("a", "x = 1", 1),
            ("b", "y = x + 1", 2),
            ("c", "z = 99", 3),
        )
        assert dependent_cells(cells, "c") == ["c"]

    def test_reordered_notebook_uses_exec_order(self):
        # Physical order is a, b, but b actually ran FIRST (exec=1) and defines x;
        # a ran second (exec=2) and reads x. Slicing from b must include a.
        cells = [
            {"id": "a", "code": "y = x + 1", "exec": 2},
            {"id": "b", "code": "x = 5", "exec": 1},
        ]
        assert dependent_cells(cells, "b") == ["b", "a"]

    def test_sql_barrier_forces_downstream_rerun(self):
        # A non-analyzable cell after the change point becomes a barrier: it and
        # everything after it re-run, even without a visible data link.
        cells = self._cells(
            ("a", "x = 1", 1),
            ("b", "%%sql\nSELECT 1", 2),   # barrier
            ("c", "print('hi')", 3),        # no dep on x, but after a barrier
        )
        assert dependent_cells(cells, "a") == ["a", "b", "c"]

    def test_never_run_cells_go_last(self):
        cells = [
            {"id": "a", "code": "x = 1", "exec": 1},
            {"id": "b", "code": "y = x", "exec": None},
        ]
        assert dependent_cells(cells, "a") == ["a", "b"]

    def test_inplace_mutation_of_tainted_object_is_barrier(self):
        # THE fix: change `config` → cell b reads config AND mutates df in place →
        # static analysis can't see df is now stale, so b becomes a barrier and c
        # (which reads df, not config) still re-runs. Without the guard c would be
        # silently skipped and left with a stale df.
        cells = self._cells(
            ("config", "config = {'k': 1}", 1),
            ("b", "df['y'] = config['k']", 2),   # reads config (tainted) + mutates df
            ("c", "out = df.sum()", 3),           # reads only df → would be missed
        )
        assert dependent_cells(cells, "config") == ["config", "b", "c"]

    def test_untainted_inplace_mutation_not_a_barrier(self):
        # A cell that mutates in place but does NOT read anything tainted is not a
        # barrier — no need to conservatively re-run everything after it.
        cells = self._cells(
            ("a", "x = 1", 1),
            ("b", "y = x + 1", 2),        # depends on a
            ("c", "other['z'] = 9", 3),   # in-place mutate, but reads nothing tainted
            ("d", "w = 42", 4),           # independent
        )
        assert dependent_cells(cells, "a") == ["a", "b"]

    def test_changed_cell_mutates_object_taints_downstream(self):
        # When the *revised* cell itself mutates an object in place, downstream
        # readers of that object must re-run.
        cells = self._cells(
            ("a", "df['x'] = 1", 1),   # revised cell mutates df
            ("b", "out = df.sum()", 2),
        )
        assert dependent_cells(cells, "a") == ["a", "b"]
