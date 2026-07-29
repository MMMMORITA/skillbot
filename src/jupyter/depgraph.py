"""Static data-dependency analysis for step-revise re-runs (Tier A).

When a step's premise ("口径") is revised, we don't want to blindly re-run every
cell physically below it (``runAllBelow``) — the notebook may have been reordered,
so physical position no longer reflects true data dependency. Instead we compute a
*forward slice*: starting from the changed cell, follow the data-flow (which cells
read variables the changed cell — or its dependents — write) and re-run only those.

Two ideas make this robust to a reordered notebook:

1. **Order by execution, not by position.** Each code cell carries an
   ``execution_count`` recording the order it last ran. We sort by that, so a cell
   physically dragged out of place is still visited in its true run order.

2. **Fail safe, never silent.** Cells we can't statically analyze (``%%sql`` /
   line-magics / syntax errors) act as *barriers*: once we pass one after the change
   point, every subsequent cell is re-run too. We would rather re-run too much than
   leave a downstream result stale.
"""

from __future__ import annotations

import ast


def _base_name(node: ast.AST) -> str | None:
    """Peel Subscript/Attribute layers to find the root variable name.

    ``df['x']['y']`` → ``df``; ``obj.a.b`` → ``obj``; anything else → None.
    """
    while isinstance(node, (ast.Subscript, ast.Attribute)):
        node = node.value
    return node.id if isinstance(node, ast.Name) else None


def analyze(code: str) -> tuple[set[str], set[str], set[str], bool]:
    """Return ``(reads, writes, mutates, analyzable)`` for a single cell.

    ``reads``  — free variable names the cell consumes from earlier cells.
    ``writes`` — module-level names the cell *binds* (assignments, def/class, imports).
    ``mutates`` — names of objects mutated *in place* without rebinding, i.e. the base
    of a subscript/attribute assignment (``df['x'] = ...``, ``obj.attr = ...``). Static
    analysis can't see how these side-effect the object, so a *dirty* cell that mutates
    is treated as a barrier downstream (see ``dependent_cells``).
    ``analyzable`` — False for magics / SQL / syntax errors; caller treats those as
    conservative barriers.

    Names produced *and* consumed within the same cell are not counted as cross-cell
    reads (a cell that does ``x = 1; print(x)`` does not depend on an upstream ``x``).
    """
    stripped = code.lstrip()
    # Cell magics (%%sql, %%bash, ...) and pure line-magic cells aren't Python.
    if stripped.startswith("%%") or stripped.startswith("!"):
        return set(), set(), set(), False

    try:
        tree = ast.parse(code)
    except SyntaxError:
        return set(), set(), set(), False

    reads: set[str] = set()
    writes: set[str] = set()
    mutates: set[str] = set()
    dynamic = False
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            if isinstance(node.ctx, ast.Store):
                writes.add(node.id)
            else:
                reads.add(node.id)
        elif isinstance(node, (ast.Subscript, ast.Attribute)) and isinstance(node.ctx, ast.Store):
            # df['x'] = ...  /  obj.attr = ...  → in-place mutation of the base object.
            base = _base_name(node.value)
            if base:
                mutates.add(base)
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            writes.add(node.name)
        elif isinstance(node, ast.Import):
            for a in node.names:
                writes.add((a.asname or a.name).split(".")[0])
        elif isinstance(node, ast.ImportFrom):
            for a in node.names:
                if a.name == "*":
                    dynamic = True  # star import → unknown names enter scope
                else:
                    writes.add(a.asname or a.name)
        elif isinstance(node, ast.Global):
            writes.update(node.names)
        elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
            # exec / eval / globals()/locals() mutation → we can't track names.
            if node.func.id in ("exec", "eval", "globals", "locals", "vars"):
                dynamic = True

    reads -= writes
    mutates -= writes  # freshly-bound-then-mutated is self-contained, not a cross-cell dep
    return reads, writes, mutates, (not dynamic)


def dependent_cells(cells: list[dict], changed_id: str) -> list[str]:
    """Compute the ordered list of cell ids to re-run after ``changed_id`` changes.

    ``cells`` — ``[{"id", "code", "exec"}]`` in physical order; ``exec`` is the
    cell's ``execution_count`` (int) or ``None`` if never run.

    Returns the changed cell followed by its transitive downstream dependents, in
    execution order. Returns ``[]`` if ``changed_id`` isn't found (caller should then
    fall back to ``runAllBelow``).
    """
    if not any(c.get("id") == changed_id for c in cells):
        return []

    # Sort by real execution order; never-run cells (exec=None) go last, keeping
    # their relative physical order (sorted() is stable).
    def _key(c: dict):
        e = c.get("exec")
        return e if isinstance(e, int) else float("inf")

    ordered = sorted(cells, key=_key)

    tainted: set[str] = set()
    dirty: list[str] = []
    seen_change = False
    barrier = False

    for c in ordered:
        cid = c.get("id")
        code = c.get("code") or ""
        reads, writes, mutates, ok = analyze(code)

        if cid == changed_id:
            seen_change = True
            dirty.append(cid)
            # The revised cell's bound names AND any object it mutates in place are
            # now stale for downstream consumers.
            tainted |= writes | mutates
            if not ok:
                barrier = True
            continue

        if not seen_change:
            continue

        # A cell reading a tainted value that then mutates some object *in place*
        # (df['x']=..., obj.attr=...) is a barrier: we can't statically see which
        # downstream reads that object, so everything after it re-runs too.
        depends = reads & tainted
        if barrier or not ok or depends:
            dirty.append(cid)
            tainted |= writes
            if not ok or (depends and mutates):
                barrier = True

    return dirty
