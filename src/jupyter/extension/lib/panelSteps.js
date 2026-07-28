"use strict";
// Steps-timeline UI helpers for AgentPanel.
// Renders the agent's plan as a list of step cards, each with rerun / rollback /
// revise actions so the human can operate on a single step without re-running
// the whole chain. Extracted from panel.ts; every function takes the panel
// instance as its first argument and accesses its state directly.
Object.defineProperty(exports, "__esModule", { value: true });
exports.enterStepsMode = enterStepsMode;
exports.exitStepsMode = exitStepsMode;
exports.renderStepList = renderStepList;
exports.renderStepCard = renderStepCard;
exports.rerunStep = rerunStep;
exports.rollbackStep = rollbackStep;
exports.reviseStep = reviseStep;
exports.showStepNotice = showStepNotice;
const notebook_1 = require("@jupyterlab/notebook");
const widgets_1 = require("@lumino/widgets");
const apputils_1 = require("@jupyterlab/apputils");
const STEP_BADGE = {
    pending: { icon: '○', cls: 'pending' },
    running: { icon: '◐', cls: 'running' },
    done: { icon: '✓', cls: 'done' },
    failed: { icon: '⚠', cls: 'failed' },
};
function enterStepsMode(panel) {
    if (panel._skillsMode)
        panel._exitSkillsMode();
    panel._stepsMode = true;
    panel._inputWrapper.style.display = 'none';
    panel._renderActionBar();
    // Pull the current timeline from the backend.
    if (panel._kernel) {
        try {
            panel._kernel.requestExecute({
                code: `get_ipython().user_ns['_panel_input']('/steps')`,
                store_history: false,
            });
        }
        catch (_) { }
    }
    panel._renderStepList(panel._stepData);
}
function exitStepsMode(panel) {
    panel._stepsMode = false;
    panel._inputWrapper.style.display = '';
    panel._outputEl.querySelectorAll('.skillbot-step-list').forEach((el) => el.remove());
    panel._renderActionBar();
    panel._inputEl.focus();
    setTimeout(() => panel._resizeInput(), 0);
}
function renderStepList(panel, steps) {
    panel._stepData = steps;
    panel._outputEl.querySelectorAll('.skillbot-step-list').forEach((el) => el.remove());
    const wrapper = document.createElement('div');
    wrapper.className = 'skillbot-step-list';
    const head = document.createElement('div');
    head.className = 'skillbot-step-head';
    const title = document.createElement('div');
    title.className = 'skillbot-step-title';
    title.textContent = `步骤 · ${steps.length}`;
    head.appendChild(title);
    wrapper.appendChild(head);
    if (!steps.length) {
        const empty = document.createElement('div');
        empty.className = 'skillbot-step-empty';
        empty.textContent = '暂无步骤。让 agent 规划并实现一个任务后，每一步会在这里出现，可单独重跑 / 回退 / 修正。';
        wrapper.appendChild(empty);
        panel._outputEl.appendChild(wrapper);
        panel._scrollBottom();
        return;
    }
    const items = document.createElement('div');
    items.className = 'skillbot-step-items';
    for (const step of steps) {
        items.appendChild(renderStepCard(panel, step));
    }
    wrapper.appendChild(items);
    panel._outputEl.appendChild(wrapper);
    panel._scrollBottom();
}
function renderStepCard(panel, step) {
    const card = document.createElement('div');
    card.className = 'skillbot-step-card ' + (step.status || 'pending');
    // Row 1: badge + index + title
    const row = document.createElement('div');
    row.className = 'skillbot-step-row';
    const badgeMeta = STEP_BADGE[step.status] || STEP_BADGE.pending;
    const badge = document.createElement('span');
    badge.className = 'skillbot-step-badge ' + badgeMeta.cls;
    badge.textContent = badgeMeta.icon;
    row.appendChild(badge);
    const label = document.createElement('span');
    label.className = 'skillbot-step-label';
    label.textContent = `${step.index}. ${step.title || 'step'}`;
    label.title = step.code || '';
    row.appendChild(label);
    card.appendChild(row);
    // Row 2: actions — rerun / rollback / revise (vertical-friendly, per user pref)
    const acts = document.createElement('div');
    acts.className = 'skillbot-step-acts';
    const bound = !!step.cell_id;
    const mk = (label, title, on, disabled = false) => {
        const b = document.createElement('button');
        b.className = 'skillbot-step-btn';
        b.textContent = label;
        b.title = title;
        if (disabled)
            b.classList.add('disabled');
        else
            b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); on(); });
        return b;
    };
    acts.appendChild(mk('▶ 重跑', bound ? '仅重跑这一步（不重跑全链路）' : '该步尚未生成 cell', () => panel._rerunStep(step), !bound));
    acts.appendChild(mk('⟲ 回退', bound ? '回退这一步到历史版本' : '该步尚未生成 cell', () => panel._rollbackStep(step), !bound));
    acts.appendChild(mk('✏️ 修正', bound ? '改这一步的方案/口径，AI 重写并可从这步往下重跑' : '该步尚未生成 cell', () => panel._reviseStep(step), !bound));
    card.appendChild(acts);
    return card;
}
/** ▶ Re-run just this step's cell in place (no full-chain re-run). */
function rerunStep(panel, step) {
    var _a;
    const nb = (_a = panel._tracker) === null || _a === void 0 ? void 0 : _a.currentWidget;
    if (!nb || !step.cell_id) {
        return;
    }
    const model = nb.model;
    if (!model)
        return;
    const cells = model.sharedModel.cells;
    for (let i = 0; i < cells.length; i++) {
        if (cells[i].id === step.cell_id) {
            nb.content.activeCellIndex = i;
            notebook_1.NotebookActions.run(nb.content, nb.context.sessionContext);
            panel._showStepNotice(`▶ 重跑步骤 ${step.index || ''}`);
            return;
        }
    }
    panel._showStepNotice('✗ 找不到对应的 cell（可能已被删除）');
}
/** ⟲ Roll this step's cell back to a previous snapshot version. */
function rollbackStep(panel, step) {
    var _a;
    const nb = (_a = panel._tracker) === null || _a === void 0 ? void 0 : _a.currentWidget;
    if (!nb || !step.cell_id || !panel._kernel)
        return;
    const model = nb.model;
    if (!model)
        return;
    let cell = null;
    const cells = nb.content.widgets;
    for (const c of cells) {
        if (c.model.id === step.cell_id) {
            cell = c;
            break;
        }
    }
    if (!cell) {
        panel._showStepNotice('✗ 找不到对应的 cell');
        return;
    }
    const nbPath = nb.context.path || nb.context.localPath || '';
    const future = panel._kernel.requestExecute({
        code: `from jupyter.cell_snapshot import list_versions; import json; d={"versions":list_versions(${JSON.stringify(step.cell_id)}, nb_path=${JSON.stringify(nbPath)}),"cell_id":${JSON.stringify(step.cell_id)}}; print(json.dumps(d))`,
        store_history: false,
    });
    let stdout = '';
    future.onIOPub = (msg) => {
        var _a;
        if (msg.header.msg_type === 'stream' && ((_a = msg.content) === null || _a === void 0 ? void 0 : _a.name) === 'stdout')
            stdout += msg.content.text;
    };
    future.done.then(() => {
        try {
            const data = JSON.parse(stdout.trim());
            const versions = data.versions || [];
            if (!versions.length) {
                panel._showStepNotice('该步暂无历史版本');
                return;
            }
            panel._showCellSnapshots(cell, versions);
        }
        catch (e) {
            console.error(e);
            panel._showStepNotice('✗ 读取历史版本失败');
        }
    });
}
/** ✏️ Revise just this step — describe the change, agent rewrites this cell only. */
async function reviseStep(panel, step) {
    var _a, _b;
    const nb = (_a = panel._tracker) === null || _a === void 0 ? void 0 : _a.currentWidget;
    if (!nb || !step.cell_id || !panel._kernel)
        return;
    let cell = null;
    for (const c of nb.content.widgets) {
        if (c.model.id === step.cell_id) {
            cell = c;
            break;
        }
    }
    if (!cell) {
        panel._showStepNotice('✗ 找不到对应的 cell');
        return;
    }
    const code = cell.model.sharedModel.getSource();
    let output = '';
    let cellError = '';
    try {
        const outputs = cell.model.outputs;
        if ((outputs === null || outputs === void 0 ? void 0 : outputs.length) > 0) {
            const last = outputs.get(outputs.length - 1);
            if ((last === null || last === void 0 ? void 0 : last.output_type) === 'error')
                cellError = `${last.ename || 'Error'}: ${last.evalue || ''}`;
            else
                output = ((_b = last === null || last === void 0 ? void 0 : last.data) === null || _b === void 0 ? void 0 : _b['text/plain']) || '';
        }
    }
    catch (_) { }
    // Frame as revising this step's PLAN / 口径, not "optimize code".
    const hint = document.createElement('div');
    hint.style.cssText = 'font-size:12px;color:#bbb;margin-bottom:6px;line-height:1.5;';
    hint.textContent = `修正这一步的方案/口径：步骤 ${step.index}「${step.title || ''}」。描述改法，AI 会按新方案重写这一步。`;
    const input = document.createElement('textarea');
    input.placeholder = `例如：GTL 敞口改用「未结算交易额 × 拒付率」口径 / 逾期口径改为 DPD30+ / 过滤测试商户…`;
    input.style.cssText = 'width:100%;min-height:72px;background:#111;color:#ddd;border:1px solid #444;padding:8px;font-size:12px;resize:vertical;font-family:inherit;';
    const foot = document.createElement('div');
    foot.style.cssText = 'font-size:11px;color:rgb(140,140,140);margin-top:6px;line-height:1.5;';
    foot.textContent = '「修正并往下重跑」= 重写这一步并从这一步往下重算整条链；「仅修正」= 只改这一步，不重跑。';
    const body = new widgets_1.Widget();
    body.node.appendChild(hint);
    body.node.appendChild(input);
    body.node.appendChild(foot);
    const dialog = new apputils_1.Dialog({
        title: `修正步骤 ${step.index}`,
        body,
        buttons: [apputils_1.Dialog.cancelButton({ label: '取消' }), apputils_1.Dialog.okButton({ label: '修正并往下重跑' }), apputils_1.Dialog.okButton({ label: '仅修正' })],
    });
    setTimeout(() => input.focus(), 10);
    const dlgResult = await dialog.launch();
    const clicked = dlgResult.button.label;
    if (clicked === '取消')
        return;
    const userRequest = input.value.trim() || '改进这一步的方案';
    const runBelow = clicked === '修正并往下重跑';
    // When re-running downstream, send a manifest of every code cell (id, source,
    // execution_count) so the backend can compute a precise dependency slice —
    // ordering by exec_count makes it robust to a physically reordered notebook.
    let cellsManifest = [];
    if (runBelow) {
        cellsManifest = nb.content.widgets
            .filter((c) => c.model.type === 'code')
            .map((c) => {
            var _a;
            return ({
                id: c.model.id,
                code: c.model.sharedModel.getSource(),
                exec: (_a = c.model.sharedModel.execution_count) !== null && _a !== void 0 ? _a : null,
            });
        });
    }
    const payloadJson = JSON.stringify({
        cellId: step.cell_id, code, output, error: cellError,
        cellType: cell.model.type || 'code', request: userRequest,
        revise: true, auto: runBelow, run_below: runBelow,
        cells: cellsManifest,
    });
    panel._kernel.requestExecute({
        code: `get_ipython().user_ns['_panel_input']('/cell-optimize ' + ${JSON.stringify(payloadJson)})`,
        store_history: false,
    });
    // Revise runs through the agent (backend enters STREAMING) but is dispatched
    // directly via the kernel, bypassing _send — so mark busy ourselves, otherwise
    // the Stop button stays disabled and the user can't interrupt. The backend's
    // `ready` comm on completion clears _busy again.
    panel._busy = true;
    panel._syncActionBar();
    panel._showStepNotice(runBelow
        ? `✏️ 正在按新方案重写步骤 ${step.index} 并往下重跑…`
        : `✏️ 正在按新方案重写步骤 ${step.index}…`);
}
function showStepNotice(panel, msg) {
    if (!msg)
        return;
    const list = panel._outputEl.querySelector('.skillbot-step-list');
    if (!list)
        return;
    list.querySelectorAll('.skillbot-step-notice').forEach((el) => el.remove());
    const notice = document.createElement('div');
    notice.className = 'skillbot-step-notice';
    if (msg.startsWith('✗'))
        notice.classList.add('error');
    notice.textContent = msg;
    const head = list.querySelector('.skillbot-step-head');
    if (head && head.nextSibling)
        list.insertBefore(notice, head.nextSibling);
    else
        list.appendChild(notice);
    setTimeout(() => notice.remove(), 6000);
}
