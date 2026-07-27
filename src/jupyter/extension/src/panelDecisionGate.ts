// Decision gate UI helpers for AgentPanel.
// A decision gate pauses the agent at a point that needs human judgement
// (scope / direction / gain / launch). Each option carries evidence so the
// human can choose without re-deriving the context.

const GATE_LABELS: Record<string, string> = {
  scope: 'Scope / metric definition',
  direction: 'Direction',
  gain: 'Expected gain',
  launch: 'Launch',
};

export function renderDecisionGate(panel: any, gate: any): void {
  const options = Array.isArray(gate?.options) ? gate.options : [];
  panel._gateType = gate?.type || 'direction';
  panel._gateQuestion = gate?.question || '';
  panel._gateOptions = options;
  panel._gateFeedbackMode = false;
  // Preselect the recommended option if the agent flagged one.
  const recIdx = options.findIndex((o: any) => o && o.recommended);
  panel._gateOptionIdx = recIdx >= 0 ? recIdx : 0;
  panel._gateActive = true;
  renderGateOptions(panel);
  panel._inputWrapper.style.display = 'none';
  panel._confirmWrapper.style.display = 'flex';
  panel._confirmWrapper.focus();
}

/** Total selectable rows = gate options + 1 trailing "type an answer" row. */
export function gateRowCount(panel: any): number {
  return (panel._gateOptions?.length || 0) + 1;
}

/** True when the current selection is the trailing "type an answer" row. */
export function isGateAnswerRow(panel: any): boolean {
  return panel._gateOptionIdx === (panel._gateOptions?.length || 0);
}

export function renderGateOptions(panel: any): void {
  // Preserve typed text across re-render (innerHTML drops the textarea).
  const oldTa = panel._confirmWrapper.querySelector('.skillbot-gate-feedback') as HTMLTextAreaElement;
  const saved = oldTa ? oldTa.value : '';

  const options: any[] = panel._gateOptions || [];
  const typeLabel = GATE_LABELS[panel._gateType] || 'Decision';
  const answerIdx = options.length;  // trailing free-text row

  const optionsHtml = options.map((opt: any, i: number) => {
    const active = i === panel._gateOptionIdx;
    const cls = active
      ? 'skillbot-gate-option skillbot-gate-option-active'
      : 'skillbot-gate-option';
    const label = panel._esc(opt?.label || `Option ${i + 1}`);
    const rec = opt?.recommended
      ? ' <span class="skillbot-gate-rec">recommended</span>'
      : '';
    const evidence = opt?.evidence
      ? `<div class="skillbot-gate-evidence">${panel._esc(opt.evidence)}</div>`
      : '';
    return `<div class="${cls}"><div class="skillbot-gate-option-label">${label}${rec}</div>${evidence}</div>`;
  }).join('');

  // Trailing "type your own answer" row — lets the human reply in prose instead
  // of picking a preset option.
  const answerActive = panel._gateOptionIdx === answerIdx;
  const answerCls = answerActive
    ? 'skillbot-gate-option skillbot-gate-option-active'
    : 'skillbot-gate-option';
  const answerRow =
    `<div class="${answerCls}"><div class="skillbot-gate-option-label">✎ Type an answer instead…</div></div>`;

  const fbStyle = panel._gateFeedbackMode ? '' : 'display:none;';
  const hint = panel._gateFeedbackMode
    ? 'Enter send · Esc back to options'
    : '↑↓/Tab select · Enter confirm · Esc cancel';

  panel._confirmWrapper.innerHTML = `
    <div class="skillbot-gate-badge">Decision · ${panel._esc(typeLabel)}</div>
    <div class="skillbot-confirm-label">${panel._esc(panel._gateQuestion)}</div>
    ${optionsHtml}
    ${answerRow}
    <textarea class="skillbot-gate-feedback" style="${fbStyle}"
              placeholder="Answer in your own words, then press Enter..."></textarea>
    <div class="skillbot-confirm-hint">${hint}</div>
  `;

  if (saved) {
    const newTa = panel._confirmWrapper.querySelector('.skillbot-gate-feedback') as HTMLTextAreaElement;
    if (newTa) newTa.value = saved;
  }
  if (panel._gateFeedbackMode) {
    const ta = panel._confirmWrapper.querySelector('.skillbot-gate-feedback') as HTMLTextAreaElement;
    if (ta) ta.focus();
  }
}

export function submitDecisionGate(panel: any): void {
  // Feedback mode: send the typed answer as the human's verbatim decision.
  if (panel._gateFeedbackMode) {
    const ta = panel._confirmWrapper.querySelector('.skillbot-gate-feedback') as HTMLTextAreaElement;
    const answer = ta ? ta.value.trim() : '';
    if (!answer) { panel._gateFeedbackMode = false; renderGateOptions(panel); panel._confirmWrapper.focus(); return; }
    closeDecisionGate(panel);
    sendGateToBackend(panel, `/gate ${answer}`);
    return;
  }
  // Trailing "type an answer" row opens the textarea instead of submitting.
  if (isGateAnswerRow(panel)) {
    panel._gateFeedbackMode = true;
    renderGateOptions(panel);
    return;
  }
  const idx = panel._gateOptionIdx;
  closeDecisionGate(panel);
  sendGateToBackend(panel, `/gate ${idx}`);
}

export function cancelDecisionGate(panel: any): void {
  closeDecisionGate(panel);
  panel._inputEl.focus();
  panel._setStatus('○', 'idle');
  if (panel._kernel) {
    panel._kernel.requestExecute({
      code: `get_ipython().user_ns['_panel_input']('/gate cancel')`,
      store_history: false,
    });
  }
}

export function closeDecisionGate(panel: any): void {
  panel._gateActive = false;
  panel._gateFeedbackMode = false;
  panel._gateOptionIdx = 0;
  panel._gateOptions = [];
  panel._gateQuestion = '';
  panel._gateType = '';
  panel._confirmWrapper.style.display = 'none';
  panel._confirmWrapper.innerHTML = '';
  panel._inputWrapper.style.display = 'flex';
}

function sendGateToBackend(panel: any, cmd: string): void {
  panel._startBlock();
  panel._renderPrompt(cmd);
  panel._startSpinner();
  panel._setStatus('…', 'deciding');
  if (panel._kernel) {
    const code = `get_ipython().user_ns['_panel_input'](${JSON.stringify(cmd)})`;
    const future = panel._kernel.requestExecute({ code, store_history: false });
    let firstStdout = true;
    future.onIOPub = (msg: any) => {
      if (msg.header.msg_type === 'stream' && msg.content?.name === 'stdout') {
        if (firstStdout) {
          panel._renderResponseText(panel._stripAnsi(msg.content.text));
          firstStdout = false;
        } else {
          panel._appendTextChunk(panel._stripAnsi(msg.content.text));
        }
      }
    };
  }
  panel._inputEl.focus();
}
