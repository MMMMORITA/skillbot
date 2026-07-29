import { Widget } from '@lumino/widgets';
import { JupyterFrontEnd, JupyterFrontEndPlugin } from '@jupyterlab/application';
import { showDialog, Dialog } from '@jupyterlab/apputils';
import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';
import { Menu } from '@lumino/widgets';
import { CC, STYLES } from './panelStyles';
import * as R from './panelRenderer';
import * as PC from './panelPlanConfirm';
import * as ST from './panelSteps';
import * as SK from './panelSkills';
import * as SS from './panelSessions';

const TARGET = 'skillbot:tui';
let _panelInstance: AgentPanel | null = null;
// ===========================================================================
// AgentPanel
// ===========================================================================

class AgentPanel extends Widget {
  // Per-notebook conversation buffers and the session registry live in
  // localStorage; keys and all the session-management logic are in
  // panelSessions.ts (SS.*). Instance state (below) stays on this class.
  private _currentPath: string = '';        // notebook path of the buffer currently shown
  private _sessionsCollapsed: boolean = false;  // session list collapsed → compact strip
  private _app: JupyterFrontEnd | null = null;  // for docmanager open/new
  private _sessionBarEl!: HTMLElement;      // session switcher UI
  private _actionBarEl!: HTMLElement;       // agent action buttons (stop / clear / ...)
  private _root: ShadowRoot;
  private _outputEl: HTMLElement;
  private _inputEl: HTMLTextAreaElement;
  private _killRing: string = '';  // for Ctrl+Y yank
  private _lastKill: string = '';   // track consecutive kill type for accumulation
  private _charsPerLine: number = 80;  // computed from textarea width / monospace char width
  private _inputWrapper: HTMLElement;
  private _confirmWrapper: HTMLElement;
  private _statusEl: HTMLElement;
  private _statusTimer: any = null;
  private _execStartTime: number = 0;
  private _statusIcon: string = '○';
  private _statusLabel: string = 'idle';
  private _tracker: INotebookTracker | null = null;
  _kernel: any = null;  // public — accessed by plugin commands
  private _comm: any = null;
  private _history: string[] = [];
  private _historyIdx: number = -1;
  private _historyDraft: string = '';  // saved original input when navigating history

  // spinner
  private _spinnerEl: HTMLElement | null = null;

  // info bar (mode switch messages)
  private _infoEl: HTMLElement;
  private _infoTimer: any = null;
  private _persistTimer: any = null;                // debounce for auto-saving agent-inserted cells

  // mode (cc-haha style: Shift+Tab to cycle)
  private _mode: 'default' | 'plan' | 'auto' = 'default';

  // input marker (❯ / ⏸) — updated per mode
  private _markerEl: HTMLElement;

  // plan confirmation
  private _planConfirmActive = false;
  private _planConfirmOptionIdx: 0 | 1 | 2 = 0;
  private _planConfirmFeedbackMode = false;
  private _planCurrentSummary = '';

  // continue confirmation (plan/default mode loop)
  private _continueConfirmActive = false;
  private _continueOptionIdx: 0 | 1 | 2 = 0;
  private _continueSummary = '';
  private _continueFeedbackMode = false;

  // message block
  private _currentBlock: HTMLElement | null = null;
  private _streaming = false;
  private _responseStarted = false;
  private _textEl: HTMLElement | null = null;  // accumulated text element for streaming
  _thinkingEl: HTMLElement | null = null;      // accumulated thinking element
  _planEl: HTMLElement | null = null;          // plan card wrapper (streaming plan mode)
  _planBodyEl: HTMLElement | null = null;      // plan card body the prose streams into
  private _thinkingCollapsed = true;            // Ctrl+T to toggle collapse
  private _busy = false;                        // agent is working → queue new prompts
  private _promptQueue: Array<{text: string, mode: 'default' | 'plan' | 'auto'}> = [];
  private _skillsMode = false;                   // skills view active → input hidden
  private _stepsMode = false;                     // steps timeline view active → input hidden
  private _stepData: Array<{index: number, title: string, code: string, cell_id: string, status: string}> = [];

  constructor() {
    super();
    this.id = 'skillbot:tui';
    this.title.label = 'Agent';
    this.title.closable = true;

    try { this._sessionsCollapsed = localStorage.getItem(SS.COLLAPSE_KEY) === '1'; } catch (_) {}

    // Light-DOM min styles (just enough for JupyterLab to lay out the panel)
    this.node.style.display = 'flex';
    this.node.style.flexDirection = 'column';
    this.node.style.minWidth = '300px';
    this.node.style.backgroundColor = CC.bg;
    this.node.style.color = CC.text;

    // Shadow DOM — isolates all CSS from JupyterLab
    this._root = this.node.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = STYLES;
    this._root.appendChild(style);

    // welcome banner
    const welcome = document.createElement('div');
    welcome.className = 'skillbot-welcome';
    welcome.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:${CC.text};margin-bottom:4px;">Agent Panel</div>
      <div style="font-size:12px;font-weight:500;color:rgb(180,180,180);">Enter send · Shift+↵ newline · ↑↓ history · Shift+Tab mode · Ctrl+T thinking · Ctrl+C interrupt · /skills manage · /continue loop · /stop task</div>
    `;
    this._root.appendChild(welcome);

    // session switcher bar — one tab per known notebook conversation
    this._sessionBarEl = document.createElement('div');
    this._sessionBarEl.className = 'skillbot-session-bar';
    this._root.appendChild(this._sessionBarEl);

    // output — click to focus input + keyboard for Ctrl+T
    this._outputEl = document.createElement('div');
    this._outputEl.className = 'skillbot-output';
    this._outputEl.tabIndex = 0;
    this._outputEl.addEventListener('keydown', (e) => {
      if (document.activeElement === this._inputEl) return;
      if (e.ctrlKey && !e.altKey) {
        switch (e.key) {
          case 't': e.preventDefault(); this._toggleThinkingCollapse(); break;
          case 'c': e.preventDefault(); this._kernel?.interrupt(); this._setStatus('⏏', 'interrupted'); break;
        }
      }
      // Esc exits skills mode even when list is not focused
      if (e.key === 'Escape' && this._skillsMode && this._expandedIdx === -1) {
        e.preventDefault();
        this._exitSkillsMode();
      }
      // Esc exits steps timeline view
      if (e.key === 'Escape' && this._stepsMode) {
        e.preventDefault();
        this._exitStepsMode();
      }
      // Esc cancels config pending when output is focused
      if (e.key === 'Escape' && this._configPending) {
        e.preventDefault();
        if (this._kernel) {
          this._kernel.requestExecute({
            code: `get_ipython().user_ns['_panel_input']('/config --no')`,
            store_history: false,
          });
        }
        this._configPending = false;
        this._infoEl.innerHTML = '';
      }
      // Trap Tab within panel when in skills mode
      if (e.key === 'Tab' && this._skillsMode) {
        e.preventDefault();
        this._skillListWrapper?.focus();
      }
    });
    this._outputEl.addEventListener('click', () => {
      // Don't steal focus if user was selecting text (drag, double-click, etc.)
      const sel = document.getSelection();
      if (sel && sel.type !== 'None' && sel.toString().length > 0) return;
      if (this._planConfirmActive) {
        this._confirmWrapper.focus();
      } else if (this._continueConfirmActive) {
        this._confirmWrapper.focus();
      } else {
        this._inputEl.focus();
      }
    });
    this._root.appendChild(this._outputEl);

    // status bar
    this._statusEl = document.createElement('div');
    this._statusEl.className = 'skillbot-status';
    this._statusEl.innerHTML = '<span>○ idle</span><span>skillbot</span>';
    this._root.appendChild(this._statusEl);

    // action bar — visible buttons for common agent controls
    this._actionBarEl = document.createElement('div');
    this._actionBarEl.className = 'skillbot-action-bar';
    this._root.appendChild(this._actionBarEl);

    // input
    this._inputWrapper = document.createElement('div');
    this._inputWrapper.className = 'skillbot-input-wrapper';

    this._markerEl = document.createElement('span');
    this._markerEl.className = 'skillbot-input-marker';
    this._markerEl.textContent = '❯ ';
    this._inputWrapper.appendChild(this._markerEl);

    this._inputEl = document.createElement('textarea');
    this._inputEl.className = 'skillbot-input';
    this._inputEl.placeholder = 'ask the agent...';
    this._inputEl.rows = 1;
    this._inputEl.addEventListener('keydown', (e) => this._onKeydown(e));
    this._inputEl.addEventListener('input', () => { this._resizeInput(); this._updateCommandDropdown(); });
    this._inputEl.addEventListener('blur', () => { setTimeout(() => { this._commandDropdown.style.display = 'none'; }, 200); });
    this._inputWrapper.appendChild(this._inputEl);

    // Command dropdown
    this._commandDropdown = document.createElement('div');
    this._commandDropdown.className = 'skillbot-command-dropdown';
    this._commandDropdown.style.cssText = `display:none;position:absolute;bottom:100%;left:0;right:0;background:${CC.bg};border:1px solid rgba(255,255,255,0.15);border-radius:4px;max-height:180px;overflow-y:auto;z-index:10;margin-bottom:2px;`;
    this._inputWrapper.style.position = 'relative';
    this._inputWrapper.appendChild(this._commandDropdown);
    this._commands = ['/confirm ', '/clear', '/continue ', '/mode ', '/skills ', '/config ', '/snapshot', '/stop'];
    this._commandIdx = -1;

    this._root.appendChild(this._inputWrapper);

    // plan confirm overlay (hidden, replaces input area when active)
    this._confirmWrapper = document.createElement('div');
    this._confirmWrapper.className = 'skillbot-confirm-wrapper';
    this._confirmWrapper.style.display = 'none';
    this._confirmWrapper.tabIndex = 0;
    this._confirmWrapper.addEventListener('keydown', (e) => this._onKeydown(e));
    this._root.appendChild(this._confirmWrapper);

    // info bar (mode switch messages, at bottom)
    this._infoEl = document.createElement('div');
    this._infoEl.className = 'skillbot-info';
    this._root.appendChild(this._infoEl);

    this._restoreState();
    this._renderSessionBar();
    this._renderActionBar();
  }

  // ---- keyboard -----------------------------------------------------------

  private _onKeydown(e: KeyboardEvent): void {
    // continue confirm: Yes/No selection (plan-style overlay)
    if (this._continueConfirmActive) {
      // Feedback mode: let typing flow into the textarea, intercept Enter/Esc.
      if (this._continueFeedbackMode) {
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.altKey && !e.isComposing) {
          e.preventDefault(); e.stopPropagation();
          this._submitContinue();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          this._continueFeedbackMode = false;
          this._renderContinueOptions();
          this._confirmWrapper.focus();
          return;
        }
        // Shift+Enter, arrows, etc. pass through to the textarea natively.
        return;
      }
      const n = 3;  // Yes / No / Type an answer
      if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
        e.preventDefault(); e.stopPropagation();
        this._continueOptionIdx = ((this._continueOptionIdx + n - 1) % n) as 0|1|2;
        this._renderContinueOptions();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'Tab') {
        e.preventDefault(); e.stopPropagation();
        this._continueOptionIdx = ((this._continueOptionIdx + 1) % n) as 0|1|2;
        this._renderContinueOptions();
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault(); e.stopPropagation();
        this._submitContinue();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault(); e.stopPropagation();
        this._continueOptionIdx = 1;
        this._submitContinue();
        return;
      }
      e.preventDefault();
      return;
    }

    // plan confirm mode: intercept navigation and commit keys
    if (this._planConfirmActive) {
      // Feedback mode: let typing pass through to textarea, intercept Enter/Esc
      if (this._planConfirmFeedbackMode) {
        if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.altKey && !e.isComposing) {
          e.preventDefault(); e.stopPropagation();
          this._submitPlanConfirm();
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault(); e.stopPropagation();
          this._planConfirmFeedbackMode = false;
          this._renderConfirmOptions();
          this._confirmWrapper.focus();
          return;
        }
        if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
          e.preventDefault(); e.stopPropagation();
          this._cancelPlanConfirm();
          return;
        }
        // Shift+Enter, Arrow keys, etc. pass through to textarea natively
        return;
      }

      // Option selection mode
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault(); e.stopPropagation();
          this._planConfirmOptionIdx = (this._planConfirmOptionIdx === 0 ? 2 : this._planConfirmOptionIdx - 1) as 0|1|2;
          this._renderConfirmOptions();
          this._confirmWrapper.focus();
          return;
        case 'ArrowDown':
        case 'Tab':
          e.preventDefault(); e.stopPropagation();
          this._planConfirmOptionIdx = ((this._planConfirmOptionIdx + 1) % 3) as 0|1|2;
          this._renderConfirmOptions();
          this._confirmWrapper.focus();
          return;
        case 'Enter':
          e.preventDefault(); e.stopPropagation();
          this._submitPlanConfirm();
          return;
        case 'Escape':
          e.preventDefault(); e.stopPropagation();
          this._cancelPlanConfirm();
          return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
        // Ctrl+L during confirm: clear panel + cancel confirm
        e.preventDefault(); e.stopPropagation();
        this._cancelPlanConfirm();
        this._clear();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
        e.preventDefault(); e.stopPropagation();
        this._cancelPlanConfirm();
        return;
      }
      e.preventDefault();
      return;
    }

    const ctrl = e.ctrlKey;  // Control only — Cmd/Meta passes through for OS shortcuts
    const el = this._inputEl;
    const ss = el.selectionStart;
    const se = el.selectionEnd;
    const v = el.value;

    // Helper: accumulate kills (consecutive same-type kills append, different type overwrites)
    const doKill = (type: string, text: string) => {
      if (this._lastKill === type && this._killRing) {
        this._killRing += text;
      } else {
        this._killRing = text;
      }
      this._lastKill = type;
    };

    // ---- Emacs-style Ctrl shortcuts ----
    if (ctrl && !e.altKey) {
      switch (e.key) {
        case 'a': e.preventDefault(); el.selectionStart = el.selectionEnd = 0; return;
        case 'b': e.preventDefault(); el.selectionStart = el.selectionEnd = Math.max(0, ss - 1); return;
        case 'e': e.preventDefault(); el.selectionStart = el.selectionEnd = v.length; return;
        case 'f': e.preventDefault(); el.selectionStart = el.selectionEnd = Math.min(v.length, ss + 1); return;
        case 'h': e.preventDefault();
          if (ss !== se) { el.value = v.slice(0, ss) + v.slice(se); el.selectionStart = el.selectionEnd = ss; }
          else if (ss > 0) { el.value = v.slice(0, ss - 1) + v.slice(ss); el.selectionStart = el.selectionEnd = ss - 1; }
          this._resizeInput(); return;
        case 'n': if (this._navigateHistory(1)) { e.preventDefault(); } return;
        case 'p': if (this._navigateHistory(-1)) { e.preventDefault(); } return;
        case 'k': {
          e.preventDefault();
          if (ss !== se) { el.value = v.slice(0, ss) + v.slice(se); el.selectionStart = el.selectionEnd = ss; }
          const cur = el.selectionStart;
          const lineEnd = el.value.indexOf('\n', cur);
          if (lineEnd !== -1) {
            // Kill to end of current line (including the newline)
            doKill('k', el.value.slice(cur, lineEnd + 1));
            el.value = el.value.slice(0, cur) + el.value.slice(lineEnd + 1);
          } else if (cur < el.value.length) {
            // Last line, no trailing newline: kill to end of text
            doKill('k', el.value.slice(cur));
            el.value = el.value.slice(0, cur);
          }
          el.selectionStart = el.selectionEnd = cur;
          this._resizeInput();
          return;
        }
        case 'u': {
          e.preventDefault();
          if (ss !== se) { el.value = v.slice(0, ss) + v.slice(se); el.selectionStart = el.selectionEnd = ss; }
          const cur = el.selectionStart;
          if (cur > 0) {
            doKill('u', el.value.slice(0, cur));
            el.value = el.value.slice(cur);
            el.selectionStart = el.selectionEnd = 0;
            this._resizeInput();
          }
          return;
        }
        case 'w': {
          e.preventDefault();
          // Clear selection first
          if (ss !== se) { el.value = v.slice(0, ss) + v.slice(se); el.selectionStart = el.selectionEnd = ss; }
          const cur = el.selectionStart;
          const wordStart = this._prevWordPos(el.value, cur);
          if (wordStart < cur) {
            doKill('w', el.value.slice(wordStart, cur));
            el.value = el.value.slice(0, wordStart) + el.value.slice(cur);
            el.selectionStart = el.selectionEnd = wordStart;
            this._resizeInput();
          }
          return;
        }
        case 'd': {
          e.preventDefault();
          if (ss !== se) {
            el.value = v.slice(0, ss) + v.slice(se);
            el.selectionStart = el.selectionEnd = ss;
            this._resizeInput();
          } else if (v.length === 0) {
            el.value = ''; this._historyIdx = -1; this._historyDraft = ''; this._resizeInput();
          } else if (ss < v.length) {
            el.value = v.slice(0, ss) + v.slice(ss + 1);
            el.selectionStart = el.selectionEnd = ss;
            this._resizeInput();
          }
          return;
        }
        case 'y': {
          e.preventDefault();
          if (this._killRing) {
            // Replace selection if any, then insert yanked text
            if (ss !== se) { el.value = v.slice(0, ss) + v.slice(se); el.selectionStart = el.selectionEnd = ss; }
            const cur = el.selectionStart;
            el.value = el.value.slice(0, cur) + this._killRing + el.value.slice(el.selectionEnd);
            el.selectionStart = el.selectionEnd = cur + this._killRing.length;
            this._resizeInput();
          }
          return;
        }
        case 'c': {
          e.preventDefault();
          if (ss !== se) return;  // has selection → let browser handle copy (Cmd+C)
          if (v.length > 0) {
            // First Ctrl+C: clear input
            el.value = '';
            this._historyIdx = -1;
            this._historyDraft = '';
            this._killRing = ''; this._lastKill = '';
            this._resizeInput();
          } else {
            // Second Ctrl+C (or first on empty input): interrupt agent
            this._kernel?.interrupt();
            this._setStatus('⏏', 'interrupted');
          }
          return;
        }
        case 'l': e.preventDefault(); this._clear(); return;
        case 't': e.preventDefault(); this._toggleThinkingCollapse(); return;
      }
    }

    // ---- Alt shortcuts (word navigation) ----
    if (e.altKey && !ctrl) {
      switch (e.key) {
        case 'b':
        case 'ArrowLeft':
          e.preventDefault();
          el.selectionStart = el.selectionEnd = this._prevWordPos(v, ss);
          return;
        case 'f':
        case 'ArrowRight':
          e.preventDefault();
          el.selectionStart = el.selectionEnd = this._nextWordPos(v, ss);
          return;
        case 'd': {
          e.preventDefault();
          const end = this._nextWordPos(v, ss);
          if (end > ss) {
            doKill('d', v.slice(ss, end));
            el.value = v.slice(0, ss) + v.slice(end);
            el.selectionStart = el.selectionEnd = ss;
            this._resizeInput();
          }
          return;
        }
      }
    }

    // ---- Enter / Shift+Enter / Meta+Enter ----
    if (e.key === 'Enter' && !e.isComposing) {
      this._killRing = ''; this._lastKill = '';
      if (e.shiftKey || e.metaKey || e.altKey) {
        e.preventDefault();
        // Clear selection before inserting newline
        if (ss !== se) { el.value = v.slice(0, ss) + v.slice(se); el.selectionStart = el.selectionEnd = ss; }
        const cur = el.selectionStart;
        el.value = el.value.slice(0, cur) + '\n' + el.value.slice(el.selectionEnd);
        el.selectionStart = el.selectionEnd = cur + 1;
        this._resizeInput();
      } else {
        e.preventDefault();
        this._commandDropdown.style.display = 'none';
        this._sendPrompt();
      }
      return;
    }

    // ---- Command dropdown: arrows to select, Tab/Enter to commit, Esc to close ----
    if (this._commandDropdown.style.display !== 'none') {
      if (e.key === 'ArrowDown') { e.preventDefault(); this._selectCommand(1); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); this._selectCommand(-1); return; }
      if (e.key === 'Enter')     { e.preventDefault(); this._commitCommand(); return; }
      if (e.key === 'Escape')    { e.preventDefault(); this._commandDropdown.style.display = 'none'; this._commandIdx = -1; return; }
    }

    // ---- Arrow keys: history at visual boundaries, line nav otherwise ----
    if (e.key === 'ArrowUp' && !ctrl && !e.altKey) {
      if (this._isOnFirstVisualLine(v, ss) && this._navigateHistory(-1)) {
        e.preventDefault();
        return;
      }
      // Not on first visual line → let textarea handle natively
    }
    if (e.key === 'ArrowDown' && !ctrl && !e.altKey) {
      if (this._isOnLastVisualLine(v, ss) && this._navigateHistory(1)) {
        e.preventDefault();
        return;
      }
    }

    // ---- Escape ----
    if (e.key === 'Escape') {
      if (this._configPending && this._kernel) {
        this._kernel.requestExecute({
          code: `get_ipython().user_ns['_panel_input']('/config --no')`,
          store_history: false,
        });
      }
      this._configPending = false;
      this._infoEl.innerHTML = '';
      el.value = '';
      this._historyIdx = -1;
      this._historyDraft = '';
      this._killRing = ''; this._lastKill = '';
      this._resizeInput();
      return;
    }

    // ---- Tab ----
    if (e.key === 'Tab') {
      this._killRing = ''; this._lastKill = '';
      e.preventDefault();
      if (e.shiftKey) {
        this._cycleMode();
      } else {
        this._tabComplete();
      }
      return;
    }

    // Config confirmation: y/n without Ctrl (skip if IME is composing)
    if (this._configPending && !ctrl && !e.altKey && (e.key === 'y' || e.key === 'n')) {
      e.preventDefault();
      e.stopPropagation();
      const cmd = e.key === 'y' ? '/config --yes' : '/config --no';
      this._configPending = false;
      this._infoEl.innerHTML = '';
      if (this._kernel) {
        const future = this._kernel.requestExecute({
          code: `get_ipython().user_ns['_panel_input']('${cmd}')`,
          store_history: false,
        });
      }
      return;
    }

    // Reset kill ring on printable character input
    if (e.key.length === 1 && !ctrl && !e.altKey) {
      this._killRing = ''; this._lastKill = '';
      // Any other key cancels config pending (send --no to backend)
      if (!e.isComposing && this._configPending && e.key !== 'y' && e.key !== 'n') {
        this._configPending = false;
        this._infoEl.innerHTML = '';
        if (this._kernel) {
          this._kernel.requestExecute({
            code: `get_ipython().user_ns['_panel_input']('/config --no')`,
            store_history: false,
          });
        }
      }
    }
  }

  private _prevWordPos(text: string, pos: number): number {
    // Skip trailing whitespace
    let i = pos - 1;
    while (i >= 0 && /\s/.test(text[i])) i--;
    // Skip the word
    while (i >= 0 && !/\s/.test(text[i])) i--;
    return i + 1;
  }

  private _nextWordPos(text: string, pos: number): number {
    let i = pos;
    // Skip current word
    while (i < text.length && !/\s/.test(text[i])) i++;
    // Skip whitespace
    while (i < text.length && /\s/.test(text[i])) i++;
    return i;
  }

  private _resizeInput(): void {
    const el = this._inputEl;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 200) + 'px';
    this._recalcCharsPerLine();
  }

  private _recalcCharsPerLine(): void {
    const el = this._inputEl;
    if (el.clientWidth <= 0) return;
    try {
      const style = getComputedStyle(el);
      const padL = parseFloat(style.paddingLeft) || 0;
      const padR = parseFloat(style.paddingRight) || 0;
      const cw = el.clientWidth - padL - padR - 2; // -2 for border
      // Measure monospace char width using canvas
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d')!;
      ctx.font = style.font;
      const charW = ctx.measureText('W').width;
      this._charsPerLine = Math.max(1, Math.floor(cw / charW));
    } catch (_) {
      // Fallback: ~7.8px per char at 13px for SF Mono
      this._charsPerLine = Math.max(1, Math.floor((el.clientWidth - 18) / 7.8));
    }
  }

  // Visual line number at text position (accounts for both \n and word-wrap)
  private _visualLineAt(text: string, pos: number): number {
    let line = 0, col = 0;
    const limit = Math.min(pos, text.length);
    for (let i = 0; i < limit; i++) {
      if (text[i] === '\n') { line++; col = 0; }
      else if (++col >= this._charsPerLine) { line++; col = 0; }
    }
    return line;
  }

  private _isOnFirstVisualLine(text: string, pos: number): boolean {
    return this._visualLineAt(text, pos) === 0;
  }

  private _isOnLastVisualLine(text: string, pos: number): boolean {
    const cursorLine = this._visualLineAt(text, pos);
    const lastLine = this._visualLineAt(text, text.length);
    return cursorLine >= lastLine;
  }

  private _navigateHistory(direction: -1 | 1): boolean {
    const v = this._inputEl.value;
    // Save draft on first entry into history
    if (this._historyIdx === -1 && v) {
      this._historyDraft = v;
    }
    this._killRing = ''; this._lastKill = '';
    const newIdx = this._historyIdx - direction;  // direction: -1 = older (↑), 1 = newer (↓)
    if (newIdx >= -1 && newIdx < this._history.length) {
      this._historyIdx = newIdx;
      if (this._historyIdx === -1) {
        this._inputEl.value = this._historyDraft;
        this._historyDraft = '';
      } else {
        this._inputEl.value = this._history[this._history.length - 1 - this._historyIdx];
      }
      // Place cursor at start so next ArrowUp immediately triggers more history
      this._inputEl.selectionStart = this._inputEl.selectionEnd = 0;
      this._resizeInput();
      return true;
    }
    return false;
  }

  private _updateCommandDropdown(): void {
    const val = this._inputEl.value;
    if (!val.startsWith('/') || val.includes(' ')) {
      this._commandDropdown.style.display = 'none';
      this._commandIdx = -1;
      return;
    }
    const matches = this._commands.filter(c => c.startsWith(val) && c !== val);
    if (matches.length === 0) {
      this._commandDropdown.style.display = 'none';
      this._commandIdx = -1;
      return;
    }
    if (this._commandIdx < 0 || this._commandIdx >= matches.length) this._commandIdx = 0;
    this._commandDropdown.innerHTML = '';
    matches.forEach((cmd, i) => {
      const item = document.createElement('div');
      item.style.cssText = `padding:3px 8px;font-size:12px;cursor:pointer;color:${CC.text};${i === this._commandIdx ? 'background:rgba(255,255,255,0.1);' : ''}`;
      item.textContent = cmd;
      item.addEventListener('click', () => { this._inputEl.value = cmd; this._inputEl.focus(); this._commandDropdown.style.display = 'none'; });
      this._commandDropdown.appendChild(item);
    });
    this._commandDropdown.style.display = 'block';
  }

  private _selectCommand(delta: number): void {
    if (this._commandDropdown.style.display === 'none') return;
    const val = this._inputEl.value;
    const matches = this._commands.filter(c => c.startsWith(val) && c !== val);
    if (matches.length === 0) return;
    this._commandIdx = (this._commandIdx + delta + matches.length) % matches.length;
    this._updateCommandDropdown();
  }

  private _commitCommand(): void {
    if (this._commandDropdown.style.display === 'none') return;
    const val = this._inputEl.value;
    const matches = this._commands.filter(c => c.startsWith(val) && c !== val);
    if (matches.length === 0) return;
    const idx = this._commandIdx >= 0 ? this._commandIdx : 0;
    if (idx < matches.length) {
      this._inputEl.value = matches[idx];
      this._inputEl.selectionStart = this._inputEl.selectionEnd = matches[idx].length;
      this._commandDropdown.style.display = 'none';
      this._commandIdx = -1;
      this._resizeInput();
    }
  }

  private _tabComplete(): void {
    // Dropdown visible: commit current selection (or first match if no selection)
    if (this._commandDropdown.style.display !== 'none') {
      this._commitCommand();
      return;
    }
    // Fallback to old behavior for /skills subcommands
    const val = this._inputEl.value;
    if (val.startsWith('/skills ')) {
      const sub = val.slice(8);
      for (const c of ['list', 'info ', 'enable ', 'disable ', 'install ', 'uninstall ']) {
        if (c.startsWith(sub) && c !== sub) {
          this._inputEl.value = '/skills ' + c;
          this._inputEl.selectionStart = this._inputEl.selectionEnd = ('/skills ' + c).length;
          this._resizeInput();
          return;
        }
      }
    }
  }

  // ---- mode cycling (cc-haha: Shift+Tab) ----

  private static MODE_ORDER: Array<'default' | 'plan' | 'auto'> = ['default', 'plan', 'auto'];
  private static MODE_COLOR: Record<string, string> = {
    default: '',
    plan:    'rgb(0,102,102)',   // cyan, cc-haha planMode
    auto:    'rgb(135,0,255)',   // purple, cc-haha autoAccept
  };
  private static MODE_SYMBOL: Record<string, string> = {
    default: '',
    plan:    '⏸',
    auto:    '⏵⏵',
  };

  private static MODE_INFO: Record<string, string[]> = {
    plan:    ['Plan mode — I\'ll explore first, then design a plan for your approval',
              'Plan mode — describe your task, I\'ll research & propose an approach',
              'Plan mode — no code is written until you approve the plan'],
    auto:    ['Auto mode — cells are generated and executed automatically',
              'Auto mode — I\'ll write code and run it without asking'],
    default: ['Default mode — cells are generated but need manual execution',
              'Default mode — I decide whether to plan first or write code directly'],
  };

  private _cycleMode(): void {
    const idx = AgentPanel.MODE_ORDER.indexOf(this._mode);
    this._mode = AgentPanel.MODE_ORDER[(idx + 1) % AgentPanel.MODE_ORDER.length];
    this._updateModeInfo();
    this._renderActionBar();
    this._saveState();
    // notify backend silently — no agent execution
    if (this._kernel) {
      this._kernel.requestExecute({
        code: `get_ipython().user_ns['_panel_set_mode']("${this._mode}")`,
        store_history: false,
      });
    }
  }

  /** Plan button: toggle between plan and default (same sync path as Shift+Tab). */
  private _togglePlanMode(): void {
    this._mode = this._mode === 'plan' ? 'default' : 'plan';
    this._updateModeInfo();
    this._renderActionBar();
    this._saveState();
    if (this._kernel) {
      this._kernel.requestExecute({
        code: `get_ipython().user_ns['_panel_set_mode']("${this._mode}")`,
        store_history: false,
      });
    }
  }

  // info bar + input area: persistent mode indicator
  private _updateModeInfo(): void {
    if (this._infoTimer) clearTimeout(this._infoTimer);
    const color = AgentPanel.MODE_COLOR[this._mode];
    const symbol = AgentPanel.MODE_SYMBOL[this._mode];

    // Update input marker and placeholder
    if (this._markerEl) {
      this._markerEl.textContent = symbol ? `${symbol} ` : '❯ ';
      this._markerEl.style.color = symbol && color ? color : '';
    }
    this._inputEl.placeholder = this._mode === 'plan'
      ? 'describe the task you want to plan...'
      : 'ask the agent...';

    // Update info bar
    if (this._mode === 'default') {
      this._infoEl.innerHTML = '';
    } else {
      const hints = AgentPanel.MODE_INFO[this._mode] || [];
      const hint = hints[Math.floor(Math.random() * hints.length)];
      this._infoEl.innerHTML = `<span style="color:${color}">${symbol} ${hint}</span>`;
      // Fade back to persistent indicator after 4 seconds
      this._infoTimer = setTimeout(() => {
        this._infoEl.innerHTML = `<span style="color:${color}">${symbol} ${this._mode}</span>`;
      }, 4000);
    }
    this._infoEl.style.opacity = '1';
  }

  // ---- prompt -------------------------------------------------------------

  private static DISPLAY_COMMANDS = ['/clear', '/mode', '/skills', '/config', '/continue', '/stop'];

  private _isDisplayCommand(text: string): boolean {
    return AgentPanel.DISPLAY_COMMANDS.some(c => text === c || text.startsWith(c + ' '));
  }

  private _sendPrompt(): void {
    if (this._planConfirmActive) return;
    const text = this._inputEl.value.trim();
    if (!text) return;
    // Defensive: if config was pending and user somehow sent 'y'/'n' as query, ignore
    if ((text === 'y' || text === 'n') && !this._configPending) {
      this._inputEl.value = '';
      this._historyDraft = '';
      this._resizeInput();
      return;
    }

    // Slash commands bypass queue
    const isSlash = text.startsWith('/');
    if (this._busy && !isSlash) {
      this._promptQueue.push({ text, mode: this._mode });
      this._updateStatusDisplay();
      this._inputEl.value = '';
      this._historyDraft = '';
      this._resizeInput();
      return;
    }

    if (this._history.length === 0 || this._history[this._history.length - 1] !== text) {
      this._history.push(text);
    }
    this._historyIdx = -1;

    const isDisplay = this._isDisplayCommand(text);
    if (!isSlash) {
      this._busy = true;
      this._syncActionBar();
    }
    if (isDisplay) {
      // Skills commands enter dedicated view
      if (text === '/skills' || text.startsWith('/skills ')) {
        this._enterSkillsMode();
      }
      // Config outside skills mode — exit if needed
      if ((text === '/config' || text.startsWith('/config ')) && this._skillsMode) {
        this._exitSkillsMode();
      }
    } else {
      this._startBlock();
      this._renderPrompt(text);
      this._startSpinner();
      this._setStatus('…', 'thinking');
    }

    if (this._kernel) {
      // send unexecuted cell content to namespace before the prompt
      if (this._tracker) {
        const nb = this._tracker.currentWidget;
        if (nb) {
          const activeCell = nb.content.activeCell;
          if (activeCell) {
            const src = activeCell.model.sharedModel.getSource();
            if (src.trim()) {
              this._kernel.requestExecute({
                code: `get_ipython().user_ns['_panel_track_cell_edit'](${JSON.stringify(src)})`,
                store_history: false,
              });
            }
          }
        }
      }

      const code = `get_ipython().user_ns['_panel_input'](${JSON.stringify(text)}, mode="${this._mode}")`;
      const future = this._kernel.requestExecute({ code, store_history: false });
      let firstStdout = true;
      future.onIOPub = (msg: any) => {
        if (msg.header.msg_type === 'stream' && msg.content?.name === 'stdout') {
          if (firstStdout) {
            this._renderResponseText(msg.content.text);
            firstStdout = false;
          } else {
            this._appendTextChunk(msg.content.text);
          }
        }
      };
    }

    this._inputEl.value = '';
    this._historyDraft = '';
    this._resizeInput();
  }

  // ---- block management ---------------------------------------------------

  private _startBlock(): void {
    this._currentBlock = document.createElement('div');
    this._currentBlock.className = 'skillbot-msg-block';
    this._outputEl.appendChild(this._currentBlock);
    this._streaming = true;
    this._responseStarted = false;
    this._textEl = null;
    this._thinkingEl = null;
    this._planEl = null;
    this._planBodyEl = null;
  }

  private _appendToBlock(el: HTMLElement): void {
    const target = this._currentBlock || this._outputEl;
    target.appendChild(el);
    this._scrollBottom();
  }

  // ---- renderers ----------------------------------------------------------

  private _ensureResponsePrefix(): void { R.ensureResponsePrefix(this); }
  private _renderPrompt(text: string): void { R.renderPrompt(this, text); }
  private _renderResponseText(content: string): void { R.renderResponseText(this, content); }
  private _appendTextChunk(content: string): void { R.appendTextChunk(this, content); }
  private _renderTool(name: string): void { R.renderTool(this, name); }
  private _renderThinking(content: string): void { R.renderThinking(this, content); }
  private _renderCodeBlock(l: string, c: string): void { R.renderCodeBlock(this, l, c); }
  private _planStreamTarget(): void { R.planStreamTarget(this); }
  private _finalizePlanBlock(text: string): void { R.finalizePlanBlock(this, text); }
  private _renderResult(summary: string): void { R.renderResult(this, summary); }

  // ---- skill rendering ----

  private _skillRows: HTMLElement[] = [];
  private _skillSelectedIdx: number = 0;
  private _skillListWrapper: HTMLElement | null = null;
  private _skillData: Array<{name: string, description: string, enabled: boolean, body: string, category: string}> = [];
  private _expandedIdx: number = -1;   // -1=list, >=0=info view
  private _fullBodyIdx: number = -1;   // -1=not in full body, >=0=full body view
  private _skillFilter = '';           // live search box text
  private _collapsedCats: Set<string> = new Set();  // collapsed category groups
  private _skillNoticeTimer: any = null;            // auto-clear for _showSkillNotice
  private _configPending = false;      // waiting for config confirm (y/n)
  private _commandDropdown: HTMLElement;  // slash command autocomplete
  private _commands: string[];
  private _commandIdx: number = -1;

  // ---- skills view (impl in panelSkills.ts) -------------------------------

  private _enterSkillsMode(): void { SK.enterSkillsMode(this); }
  private _exitSkillsMode(): void { SK.exitSkillsMode(this); }

  // ---- steps timeline view (impl in panelSteps.ts) -------------------------

  private _enterStepsMode(): void { ST.enterStepsMode(this); }
  private _exitStepsMode(): void { ST.exitStepsMode(this); }
  private _renderStepList(steps: Array<{index: number, title: string, code: string, cell_id: string, status: string}>): void { ST.renderStepList(this, steps); }
  private _rerunStep(step: {cell_id: string}): void { ST.rerunStep(this, step); }
  private _rollbackStep(step: {cell_id: string}): void { ST.rollbackStep(this, step); }
  private _reviseStep(step: {cell_id: string, code: string, index: number, title?: string}): Promise<void> { return ST.reviseStep(this, step); }
  private _showStepNotice(msg: string): void { ST.showStepNotice(this, msg); }

  /** Bridge so panelSteps can open the (module-scope) cell-snapshots dialog. */
  private _showCellSnapshots(cell: any, versions: any[]): void { _showCellSnapshotsDialog(cell, versions, this); }


  private _renderSkillList(skills: Array<{name: string, description: string, enabled: boolean, body?: string, category?: string}>): void { SK.renderSkillList(this, skills); }

  /** Flash a short backend message (upload/uninstall result) above the list. */
  private _showSkillNotice(msg: string): void { SK.showSkillNotice(this, msg); }

  // ---- thinking collapse (Ctrl+T) ----

  private _toggleThinkingCollapse(): void {
    this._thinkingCollapsed = !this._thinkingCollapsed;
    this._applyThinkingCollapse();
    const status = this._thinkingCollapsed ? 'collapsed' : 'expanded';
    this._infoEl.innerHTML = `<span style="color:rgb(0,180,180)">thinking ${status} · ctrl+t to toggle</span>`;
    if (this._infoTimer) clearTimeout(this._infoTimer);
    this._infoTimer = setTimeout(() => { this._infoEl.innerHTML = ''; }, 4000);
  }

  private _applyThinkingCollapse(): void {
    // Use live _thinkingEl during streaming, DOM search for Ctrl+T toggle
    const els = (this._thinkingEl && this._thinkingEl.parentElement)
      ? [this._thinkingEl]
      : Array.from(this._outputEl.querySelectorAll('.skillbot-thinking-line') as NodeListOf<HTMLElement>);
    els.forEach((el: HTMLElement) => {
      if (this._thinkingCollapsed) {
        const currentFull = el.getAttribute('data-full') || el.textContent || '';
        el.setAttribute('data-full', currentFull);
        const truncated = currentFull.length > 150 ? currentFull.slice(0, 150) + '...' : currentFull;
        if (el.textContent !== truncated) el.textContent = truncated;
        el.style.cursor = 'pointer';
        el.title = 'ctrl+t to expand';
      } else {
        const fullText = el.getAttribute('data-full');
        if (fullText) {
          el.textContent = fullText;
          el.removeAttribute('data-full');
        }
        el.style.cursor = '';
        el.title = '';
      }
    });
  }

  _clear(): void {
    this._outputEl.innerHTML = '';
    this._currentBlock = null;
    this._textEl = null;
    this._thinkingEl = null;
    this._thinkingCollapsed = true;
    this._streaming = false;
    this._busy = false;
    this._promptQueue = [];
    if (this._configPending) {
      this._configPending = false;
      this._infoEl.innerHTML = '';
      if (this._kernel) {
        this._kernel.requestExecute({
          code: `get_ipython().user_ns['_panel_input']('/config --no')`,
          store_history: false,
        });
      }
    }
    this._stopSpinner();
    this._setStatus('○', 'idle');
    this._closeConfirm();  // ensure confirm UI is dismissed
    this._saveState();
    this._inputEl.value = '';
    this._historyIdx = -1;
    this._historyDraft = '';
    this._resizeInput();
  }

  private _dequeueNext(): void {
    if (this._promptQueue.length === 0) {
      this._updateStatusDisplay();
      return;
    }
    const next = this._promptQueue.shift()!;
    // Cancel any active plan confirm — dequeued prompt takes priority
    if (this._planConfirmActive) {
      this._cancelPlanConfirm();
    }
    // Temporarily switch mode for the queued prompt
    const savedMode = this._mode;
    this._mode = next.mode;
    this._inputEl.value = next.text;
    this._busy = false;
    this._sendPrompt();
    this._mode = savedMode;
  }

  // ---- session persistence + switcher (impl in panelSessions.ts) ----------

  private _storageKey(path?: string): string { return SS.storageKey(this, path); }
  private _saveState(): void { SS.saveState(this); }
  private _restoreState(): void { SS.restoreState(this); }
  private _loadBuffer(path: string): void { SS.loadBuffer(this, path); }
  private _applyBuffer(raw: string): void { SS.applyBuffer(this, raw); }
  private _loadRegistry(): Record<string, string> { return SS.loadRegistry(this); }
  private _saveRegistry(reg: Record<string, string>): void { SS.saveRegistry(this, reg); }
  private _registerSession(path: string): void { SS.registerSession(this, path); }
  private _renderSessionBar(): void { SS.renderSessionBar(this); }

  /** Public: called by the plugin when a notebook file is deleted from disk. */
  onNotebookFileDeleted(path: string): void { SS.onNotebookFileDeleted(this, path); }

  // ---- agent action bar ---------------------------------------------------

  /** Run a slash command from a button without disturbing the user's draft/history. */
  private _dispatchCommand(cmd: string): void {
    const draft = this._inputEl.value;
    const histLen = this._history.length;
    this._inputEl.value = cmd;
    this._sendPrompt();
    // _sendPrompt pushes to history — button-issued commands shouldn't pollute it.
    if (this._history.length > histLen && this._history[this._history.length - 1] === cmd) {
      this._history.pop();
      this._historyIdx = -1;
    }
    // Restore whatever the user was typing (input is hidden in skills mode).
    if (draft && !this._skillsMode) {
      this._inputEl.value = draft;
      this._resizeInput();
    }
  }

  /** Interrupt the running kernel immediately (same as Ctrl+C twice). */
  private _interruptAgent(): void {
    this._kernel?.interrupt();
    this._setStatus('⏏', 'interrupted');
    this._stopSpinner();
    this._busy = false;
    this._promptQueue = [];
    this._updateStatusDisplay();
  }

  /** Render the visible agent controls; enable/disable by busy state. */
  private _renderActionBar(): void {
    if (!this._actionBarEl) return;
    this._actionBarEl.innerHTML = '';

    const mk = (label: string, title: string, cls: string, on: () => void): HTMLElement => {
      const b = document.createElement('span');
      b.className = 'skillbot-action-btn' + (cls ? ' ' + cls : '');
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', (e) => { e.preventDefault(); on(); });
      return b;
    };

    // Stop is prominent while busy, muted otherwise.
    const stop = mk('■ Stop', '停止当前任务 (/stop)', 'skillbot-action-stop', () => {
      if (this._busy) this._interruptAgent();
      this._dispatchCommand('/stop');
    });
    if (!this._busy) stop.classList.add('disabled');
    this._actionBarEl.appendChild(stop);

    // Plan is a toggle: switch into plan mode, or back to default if active.
    const plan = mk('⏸ Plan', 'Plan 模式开关 (Shift+Tab)', 'skillbot-action-plan', () => this._togglePlanMode());
    if (this._mode === 'plan') plan.classList.add('active');
    this._actionBarEl.appendChild(plan);

    this._actionBarEl.appendChild(mk('🗑 Clear', '清空当前会话对话', '', () => this._dispatchCommand('/clear')));

    // Steps is a toggle: open the timeline view, or close it if already open.
    const steps = mk('☰ Steps', '步骤时间线：每步可单独重跑/回退/修正', 'skillbot-action-steps', () => {
      if (this._stepsMode) this._exitStepsMode();
      else this._enterStepsMode();
    });
    if (this._stepsMode) steps.classList.add('active');
    this._actionBarEl.appendChild(steps);

    // Skills is a toggle: open the manager, or close it if already open.
    const skills = mk('≣ Skills', '管理技能 (/skills)', 'skillbot-action-skills', () => {
      if (this._skillsMode) this._exitSkillsMode();
      else this._dispatchCommand('/skills');
    });
    if (this._skillsMode) skills.classList.add('active');
    this._actionBarEl.appendChild(skills);
  }

  /** Called by the plugin when the active notebook changes. Returns true if the
   *  active path actually changed (so the caller can notify the backend). */
  setActivePath(path: string): boolean {
    if (!path || path === this._currentPath) {
      if (path) this._registerSession(path);
      return false;
    }
    this._saveState();
    this._currentPath = path;
    this._loadBuffer(path);
    this._registerSession(path);
    this._renderSessionBar();
    return true;
  }

  /** Notify the backend to give this notebook its own agent conversation. The
   *  AgentMagic session is kernel-wide, so without this a new/other notebook
   *  would inherit the previous notebook's LLM history. Must run after the
   *  kernel for the target notebook is connected. Backend guards against
   *  spurious/duplicate switches and won't reset mid-task. */
  notifyNotebookSwitch(path: string): void {
    if (!path || !this._kernel) return;
    try {
      this._kernel.requestExecute({
        code: `get_ipython().user_ns['_panel_switch_notebook'](${JSON.stringify(path)})`,
        store_history: false,
      });
    } catch (_) {}
  }

  setApp(app: JupyterFrontEnd): void {
    this._app = app;
  }

  // ---- spinner -------------------------------------------------------------

  private _startSpinner(): void {
    if (this._spinnerEl) return;
    const wrapper = document.createElement('span');
    wrapper.style.whiteSpace = 'nowrap';
    this._spinnerEl = document.createElement('span');
    this._spinnerEl.className = 'skillbot-spinner';
    this._spinnerEl.textContent = '✻';
    wrapper.appendChild(this._spinnerEl);
    const label = document.createElement('span');
    label.className = 'skillbot-spinner-label';
    label.textContent = 'Thinking...';
    wrapper.appendChild(label);
    this._appendToBlock(wrapper);
  }

  private _stopSpinner(): void {
    if (this._spinnerEl) {
      const wrapper = this._spinnerEl.parentElement;
      if (wrapper) wrapper.remove();
      this._spinnerEl = null;
    }
  }

  // ---- status bar ----------------------------------------------------------

  private _setStatus(icon: string, label: string): void {
    this._statusIcon = icon;
    this._statusLabel = label;
    // Start timer for running states, stop for idle/done
    if (icon === '…') {
      if (!this._statusTimer) {
        this._execStartTime = Date.now();
        this._statusTimer = setInterval(() => this._updateStatusDisplay(), 1000);
      }
    } else {
      this._stopStatusTimer();
    }
    this._updateStatusDisplay();
  }

  private _stopStatusTimer(): void {
    if (this._statusTimer) {
      clearInterval(this._statusTimer);
      this._statusTimer = null;
    }
  }

  private _updateStatusDisplay(): void {
    const icon = this._statusIcon;
    const label = this._statusLabel;
    const q = this._promptQueue.length > 0
      ? ` <span style="color:rgb(215,119,87)">queued:${this._promptQueue.length}</span>`
      : '';
    if (icon === '…' && this._execStartTime > 0) {
      const elapsed = Math.floor((Date.now() - this._execStartTime) / 1000);
      this._statusEl.innerHTML = `<span>${icon} ${label} (${elapsed}s)${q}</span><span>skillbot</span>`;
    } else {
      this._statusEl.innerHTML = `<span>${icon} ${label}${q}</span><span>skillbot</span>`;
    }
    this._syncActionBar();
  }

  /** Keep the Stop button's enabled/prominent state in sync with busy. */
  private _syncActionBar(): void {
    const stop = this._actionBarEl?.querySelector('.skillbot-action-stop');
    if (!stop) return;
    if (this._busy) stop.classList.remove('disabled');
    else stop.classList.add('disabled');
  }

  // ---- plan confirmation (delegates to panelPlanConfirm) ------------------

  private _renderPlanConfirm(s: string): void { PC.renderPlanConfirm(this, s); }
  private _getConfirmHint(): string { return PC.getConfirmHint(this); }
  private _renderConfirmOptions(): void { PC.renderConfirmOptions(this); }
  private _closeConfirm(): void { PC.closeConfirm(this); }
  private _sendConfirmToBackend(c: string): void { PC.sendConfirmToBackend(this, c); }
  private _submitPlanConfirm(): void { PC.submitPlanConfirm(this); }
  private _cancelPlanConfirm(): void { PC.cancelPlanConfirm(this); }

  // ---- continue confirmation (plan-style overlay) --------------------------

  private _renderContinueButtons(summary: string): void {
    this._continueConfirmActive = true;
    this._continueOptionIdx = 0;
    this._continueFeedbackMode = false;
    this._continueSummary = summary;
    this._renderContinueOptions();
    this._inputWrapper.style.display = 'none';
    this._confirmWrapper.style.display = 'flex';
    this._confirmWrapper.focus();
  }

  private _renderContinueOptions(): void {
    // Preserve any typed answer across re-render (innerHTML drops the textarea).
    const oldTa = this._confirmWrapper.querySelector('.skillbot-confirm-feedback') as HTMLTextAreaElement;
    const saved = oldTa ? oldTa.value : '';

    const summary = this._continueSummary;
    const options = [
      'Yes — generate and execute cells',
      'No — finish here',
      '✎ Type an answer instead…',
    ];
    const optionsHtml = options.map((label, i) => {
      const cls = i === this._continueOptionIdx
        ? 'skillbot-confirm-option skillbot-confirm-option-active'
        : 'skillbot-confirm-option';
      return `<div class="${cls}">${label}</div>`;
    }).join('');

    const fbStyle = this._continueFeedbackMode ? '' : 'display:none;';
    const hint = this._continueFeedbackMode
      ? 'Enter send · Esc back to options'
      : '↑↓ select · Enter confirm · Esc cancel';

    this._confirmWrapper.innerHTML = `
      <div class="skillbot-confirm-label">${this._esc(summary)}</div>
      ${optionsHtml}
      <textarea class="skillbot-confirm-feedback" style="${fbStyle}"
                placeholder="Answer the agent (e.g. the file path), then press Enter..."></textarea>
      <div class="skillbot-confirm-hint">${hint}</div>
    `;

    if (saved) {
      const newTa = this._confirmWrapper.querySelector('.skillbot-confirm-feedback') as HTMLTextAreaElement;
      if (newTa) newTa.value = saved;
    }
    if (this._continueFeedbackMode) {
      const ta = this._confirmWrapper.querySelector('.skillbot-confirm-feedback') as HTMLTextAreaElement;
      if (ta) ta.focus();
    }
  }

  private _submitContinue(): void {
    // Feedback mode: send the typed answer back to the agent as prose.
    if (this._continueFeedbackMode) {
      const ta = this._confirmWrapper.querySelector('.skillbot-confirm-feedback') as HTMLTextAreaElement;
      const answer = ta ? ta.value.trim() : '';
      if (!answer) { this._continueFeedbackMode = false; this._renderContinueOptions(); this._confirmWrapper.focus(); return; }
      this._continueConfirmActive = false;
      this._continueFeedbackMode = false;
      this._confirmWrapper.style.display = 'none';
      this._confirmWrapper.innerHTML = '';
      this._inputWrapper.style.display = '';
      this._sendContinueCmd(`/continue ${answer}`);
      return;
    }
    // Option 2 ("Type an answer instead") opens the textarea rather than submitting.
    if (this._continueOptionIdx === 2) {
      this._continueFeedbackMode = true;
      this._renderContinueOptions();
      return;
    }
    const arg = this._continueOptionIdx === 0 ? 'yes' : 'no';
    this._continueConfirmActive = false;
    this._confirmWrapper.style.display = 'none';
    this._confirmWrapper.innerHTML = '';
    this._inputWrapper.style.display = '';
    this._inputEl.focus();
    this._sendContinueCmd(`/continue ${arg}`);
  }

  /** Send a /continue command; a free-text answer also shows a spinner since
   *  the agent will stream a fresh response. */
  private _sendContinueCmd(cmd: string): void {
    const isAnswer = !/^\/continue (yes|no)$/.test(cmd);
    if (isAnswer) {
      this._startBlock();
      this._startSpinner();
      this._setStatus('…', 'thinking');
    } else {
      this._inputEl.focus();
    }
    if (this._kernel) {
      this._kernel.requestExecute({
        code: `get_ipython().user_ns['_panel_input'](${JSON.stringify(cmd)})`,
        store_history: false,
      });
    }
  }

  // ---- helpers -------------------------------------------------------------

  private _scrollBottom(): void {
    this._outputEl.scrollTop = this._outputEl.scrollHeight;
  }

  private _stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  private _esc(s: string): string {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  setTracker(tracker: INotebookTracker): void {
    this._tracker = tracker;
  }

  /** Re-run exactly the given cell ids, in order — the precise dependency slice. */
  private _runCellsByIds(notebook: any, sessionContext: any, ids: string[]): void {
    const model = notebook.model;
    if (!model) return;
    const cells = model.sharedModel.cells;
    const posById: Record<string, number> = {};
    for (let i = 0; i < cells.length; i++) posById[cells[i].id] = i;
    // Select the target cells (deselecting everything else), then run the selection.
    // NotebookActions.run executes the active cell plus all selected cells in
    // document order, which matches the ordered slice we were given.
    const positions = ids.map(id => posById[id]).filter(p => p !== undefined);
    if (!positions.length) return;
    positions.sort((a, b) => a - b);
    notebook.activeCellIndex = positions[0];
    notebook.deselectAll();
    for (const p of positions) {
      notebook.select(notebook.widgets[p]);
    }
    NotebookActions.run(notebook, sessionContext);
  }

  _handleCellComm(comm: any, msg: any): void {
    try {
      this._handleCellCommImpl(comm, msg);
    } catch (e) {
      console.error('[panel] _handleCellComm failed:', e);
    }
  }

  private _handleCellCommImpl(comm: any, msg: any): void {
    const data = msg.content?.data || {};
    const nb = this._tracker?.currentWidget;
    if (!nb) return;
    const model = nb.model;
    if (!model) return;

    const code: string = data.code || '';
    const auto: boolean = data.auto !== false;
    const cellType: string = data.cell_type || 'code';
    const replaceId: string = data.replace_cell_id || '';
    // run_below: re-run this cell AND every cell below it (step revise → recompute
    // the downstream chain). Implies execution regardless of the `auto` flag.
    const runBelow: boolean = data.run_below === true;
    // run_cell_ids: precise dependency slice — re-run exactly these cells, in order
    // (the changed cell followed by only its true downstream dependents). Takes
    // precedence over runBelow when non-empty.
    const runCellIds: string[] = Array.isArray(data.run_cell_ids) ? data.run_cell_ids : [];
    if (!code) return;

    const notebook = nb.content;

    if (replaceId) {
      const cells = model.sharedModel.cells;
      for (let i = cells.length - 1; i >= 0; i--) {
        if (cells[i].id === replaceId) {
          cells[i].source = code;
          notebook.activeCellIndex = i;
          comm.send({ cell_id: cells[i].id });
          this._persistNotebook();  // flush the edit to disk (survives refresh)
          if (cellType !== 'markdown' && (auto || runBelow || runCellIds.length)) {
            if (runCellIds.length) this._runCellsByIds(notebook, nb.context.sessionContext, runCellIds);
            else if (runBelow) NotebookActions.runAllBelow(notebook, nb.context.sessionContext);
            else NotebookActions.run(notebook, nb.context.sessionContext);
          }
          return;
        }
      }
    }

    // Insert new cell + execute
    const activeIndex = notebook.activeCellIndex;
    model.sharedModel.insertCell(activeIndex + 1, {
      cell_type: cellType as 'code' | 'markdown',
      source: code,
      metadata: {},
    });
    const newCell = model.sharedModel.cells[activeIndex + 1];
    notebook.activeCellIndex = activeIndex + 1;

    comm.send({ cell_id: newCell.id });
    this._persistNotebook();  // flush the new cell to disk (survives refresh)

    if (cellType === 'markdown' || (!auto && !runBelow)) return;
    if (runBelow) NotebookActions.runAllBelow(notebook, nb.context.sessionContext);
    else NotebookActions.run(notebook, nb.context.sessionContext);
  }

  // ---- kernel / comm -------------------------------------------------------

  /**
   * Persist the active notebook document to disk. Agent-generated cells are
   * inserted into the in-memory notebook model only, which marks the document
   * dirty but does NOT write it out. Without this, a browser refresh reloads
   * the last-saved (often empty) file and the generated cells vanish. Debounced
   * so a burst of cell edits collapses into a single save.
   */
  private _persistNotebook(): void {
    const nb = this._tracker?.currentWidget;
    const ctx = nb?.context as any;
    if (!ctx?.save) return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      try { ctx.save(); } catch (e) { console.error('[panel] notebook save failed:', e); }
    }, 400);
  }

  resetComm(): void {
    if (this._comm) {
      try { this._comm.close(); } catch (_) {}
      this._comm = null;
    }
    this._kernel = null;
    this._stopStatusTimer();
  }

  connectKernel(kernel: any): void {
    this._kernel = kernel;

    // Notify kernel of active notebook path for snapshot file isolation.
    // Must happen BEFORE `if (this._comm) return` so it fires on every
    // notebook switch and lazy kernel start (via onKernelChanged).
    const nb = this._tracker?.currentWidget;
    const nbPath = nb?.context?.path || '';
    if (nbPath) {
      kernel.requestExecute({
        code: `from jupyter.magic import _set_active_notebook_path; _set_active_notebook_path(${JSON.stringify(nbPath)})`,
        store_history: false,
      });
    }

    // Re-register cell-execution target (needed on kernel restart)
    try {
      kernel.registerCommTarget('skillbot:execute-cell', (comm: any, msg: any) => {
        this._handleCellComm(comm, msg);
      });
    } catch (e) {
      console.error('[panel] registerCommTarget failed:', e);
    }

    if (this._comm) return;

    try {
      this._comm = kernel.createComm(TARGET);
      this._comm.onMsg = (m: any) => {
        const d = m.content?.data || {};
        switch (d.action) {
          case 'text':
            if (this._skillsMode) {
              // Surface backend upload/uninstall feedback inline in the list.
              this._showSkillNotice(this._stripAnsi(d.content || '').trim());
            } else {
              // Pass RAW text — the renderer parses markdown + ANSI itself.
              const raw = d.content || '';
              // Plan mode: stream prose straight into the plan card (single
              // source of truth) instead of a standalone text block that would
              // later be duplicated by the plan card. Non-plan turns unchanged.
              if (this._mode === 'plan') {
                this._planStreamTarget();
              }
              this._appendTextChunk(raw);
              // Backend sent config confirmation → enable y/n
              if (raw.includes('Press y to apply')) {
                this._configPending = true;
                this._infoEl.innerHTML = '<span style=\"color:rgb(0,180,180)\">Press y to apply  n to cancel</span>';
                if (this._infoTimer) clearTimeout(this._infoTimer);
              }
            }
            break;
          case 'tool':        this._renderTool(d.name || ''); break;
          case 'thinking':    this._renderThinking(d.content || ''); break;
          case 'code_block':  this._renderCodeBlock(d.language || '', d.code || ''); break;
          case 'result':
            this._stopSpinner();
            if (this._planConfirmActive) this._closeConfirm();
            this._renderResult(d.summary || '');
            break;
          case 'plan_confirm':
            if (this._planConfirmActive) this._closeConfirm();
            this._stopSpinner();
            this._streaming = false;
            this._responseStarted = false;
            this._setStatus('⏸', 'plan');
            // Reuse the card the prose already streamed into (plan mode); only
            // falls back to a fresh card when nothing streamed. Avoids the old
            // duplicate where text showed once plain + once in the card.
            this._finalizePlanBlock(d.summary || '');
            this._renderPlanConfirm(d.summary || '');
            this._saveState();
            break;
          case 'skill_list':
            if (!this._skillsMode) this._enterSkillsMode();
            this._renderSkillList(d.skills || []);
            break;
          case 'step_timeline':
            // Keep the model current even when the view is closed, so opening
            // Steps later shows the latest state without a round-trip.
            this._stepData = d.steps || [];
            if (this._stepsMode) this._renderStepList(this._stepData);
            break;
          case 'continue_confirm':
            this._stopSpinner();
            this._busy = false;
            this._dequeueNext();
            this._renderContinueButtons(d.summary || '');
            break;
          case 'ready':
            this._stopSpinner();
            this._busy = false;
            this._dequeueNext();
            this._syncActionBar();
            break;
          case 'clear':       this._clear(); break;
          case 'restore_conversation':
            // Disk copy arrived for a path with no localStorage cache.
            if ((d.path || '') === this._currentPath && d.buffer) {
              this._applyBuffer(d.buffer);
              try { localStorage.setItem(this._storageKey(this._currentPath), d.buffer); } catch (_) {}
            }
            break;
          case 'conversation_list':
            // Merge disk-persisted sessions into the switcher registry.
            if (Array.isArray(d.sessions)) {
              const reg = this._loadRegistry();
              for (const s of d.sessions) {
                if (s.path) reg[s.path] = s.path.split('/').pop() || s.path;
              }
              this._saveRegistry(reg);
              this._renderSessionBar();
            }
            break;
        }
      };
      this._comm.open();
      // Pull disk-persisted sessions into the switcher (covers fresh browsers).
      try {
        this._kernel.requestExecute({
          code: `get_ipython().user_ns['_panel_list_conversations']()`,
          store_history: false,
        });
      } catch (_) {}
    } catch (e) {
      console.error('[panel] createComm failed:', e);
    }
  }
}

// ===========================================================================
// Notebook Snapshot Dialog
// ===========================================================================

function _jpBtn(text: string, kind: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = kind ? `jp-mod-styled jp-mod-${kind}` : 'jp-mod-styled';
  b.style.cssText = 'padding:4px 12px;font-size:12px;';
  return b;
}

function _showSnapshotDialog(snapshots: any[], panel: any, nb: any, cellRestored: boolean, nbPath: string): void {
  const container = document.createElement('div');
  container.style.cssText = 'min-width:520px;max-height:550px;overflow-y:auto;font-size:13px;color:#ddd;background:#1a1a2e;padding:12px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:10px;font-size:14px;';
  const label = nbPath || '(unsaved notebook)';
  title.textContent = `Notebook Snapshots — ${label} (${snapshots.length})`;
  container.appendChild(title);

  if (cellRestored) {
    const warning = document.createElement('div');
    warning.style.cssText = 'padding:6px 8px;margin-bottom:10px;background:rgba(220,120,100,0.15);border-left:2px solid rgb(220,120,100);font-size:12px;color:rgb(220,160,140);';
    warning.textContent = '⚠ Cells have been individually restored in this session. Notebook restore will overwrite those changes.';
    container.appendChild(warning);
  }

  let selectedId = '';
  const previewPanel = document.createElement('div');
  previewPanel.style.cssText = 'background:#111;padding:10px;border-radius:4px;margin-top:10px;max-height:280px;overflow-y:auto;white-space:pre-wrap;font-family:monospace;font-size:12px;color:#ccc;line-height:1.5;';
  previewPanel.textContent = 'Select a snapshot to preview';
  container.appendChild(previewPanel);

  const updateSelection = (s: any, row: HTMLElement) => {
    selectedId = s.id;
    container.querySelectorAll('.snapshot-row').forEach((el: any) => el.style.background = '');
    row.style.background = 'rgba(255,255,255,0.1)';
    // Show preview
    const previews = s.preview || [];
    if (previews.length > 0) {
      previewPanel.textContent = previews.map((p: string, i: number) => `[${i + 1}] ${p}`).join('\n');
    } else {
      previewPanel.textContent = '(no code preview)';
    }
  };

  snapshots.forEach((s: any, i: number) => {
    const row = document.createElement('div');
    row.className = 'snapshot-row';
    row.style.cssText = `padding:5px 10px;cursor:pointer;border-radius:3px;display:flex;justify-content:space-between;${i === 0 ? 'background:rgba(255,255,255,0.08);' : ''}`;
    const ts = new Date((s.timestamp || 0) * 1000).toLocaleString();
    row.innerHTML = `<span style="font-size:13px;"><b>${ts}</b></span><span style="color:#999;font-size:12px;">${s.cells_count} cells</span>`;
    row.addEventListener('click', () => updateSelection(s, row));
    container.appendChild(row);
    if (i === 0) { selectedId = s.id; previewPanel.textContent = (s.preview || []).map((p: string, j: number) => `[${j + 1}] ${p}`).join('\n') || '(no code preview)'; }
  });

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'margin-top:10px;display:flex;gap:8px;';
  const restoreBtn = _jpBtn('Restore Notebook', 'accept');
  restoreBtn.addEventListener('click', () => {
    if (!selectedId || !panel._kernel) return;
    // Fetch snapshot cells, then restore directly via notebook model
    const future = panel._kernel.requestExecute({
      code: `from jupyter.notebook_snapshot import get_snapshot; import json; sid=${JSON.stringify(selectedId)}; np=${JSON.stringify(nbPath)}; print(json.dumps(get_snapshot(sid, nb_path=np).get("cells",[]) if get_snapshot(sid, nb_path=np) else []))`,
      store_history: false,
    });
    let stdout = '';
    future.onIOPub = (msg: any) => {
      if (msg.header.msg_type === 'stream' && msg.content?.name === 'stdout') stdout += msg.content.text;
    };
    future.done.then(() => {
      try {
        const cells = JSON.parse(stdout.trim());
        if (!cells || !cells.length) { restoreBtn.textContent = 'No cells'; return; }
        const model = nb.model;
        if (!model) { restoreBtn.textContent = 'No model'; return; }
        // Clear and repopulate
        const sharedModel = model.sharedModel;
        while (sharedModel.cells.length > 0) {
          sharedModel.deleteCell(0);
        }
        for (const c of cells) {
          sharedModel.insertCell(sharedModel.cells.length, {
            cell_type: 'code',
            source: c.code || '',
            metadata: {},
          });
        }
        restoreBtn.textContent = 'Restored';
        restoreBtn.className = 'jp-mod-styled';
        restoreBtn.style.cssText = 'padding:4px 12px;font-size:12px;background:var(--jp-success-color1, #1a7f37);color:var(--jp-ui-inverse-font-color1, #fff);border:1px solid var(--jp-success-color2, #1a7f37);';
      } catch (e) {
        console.error(e);
        restoreBtn.textContent = 'Failed';
        restoreBtn.className = 'jp-mod-styled jp-mod-warn';
      }
    });
  });
  btnRow.appendChild(restoreBtn);
  container.appendChild(btnRow);

  const bodyWidget = new Widget();
  bodyWidget.node.appendChild(container);
  showDialog({
    title: 'Notebook Snapshots',
    body: bodyWidget,
    buttons: [Dialog.okButton({ label: 'Close' })],
  });
}

// ===========================================================================
// Cell Snapshots Dialog
// ===========================================================================

function _stripHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function _showCellSnapshotsDialog(cell: any, versions: any[], panel: any): void {
  if (!versions || versions.length === 0) {
    alert('No version history for this cell.');
    return;
  }

  const container = document.createElement('div');
  container.style.cssText = 'min-width:520px;max-height:550px;overflow-y:auto;font-size:13px;color:#ddd;background:#1a1a2e;padding:12px;';

  const title = document.createElement('div');
  title.style.cssText = 'font-weight:600;margin-bottom:10px;font-size:14px;';
  title.textContent = `Cell Snapshots (${versions.length})`;
  container.appendChild(title);

  let selectedIdx = 0;
  const preview = document.createElement('div');
  preview.style.cssText = 'background:#111;padding:10px;border-radius:4px;margin-top:10px;max-height:300px;overflow-y:auto;white-space:pre-wrap;font-family:monospace;font-size:12px;color:#ccc;line-height:1.5;';
  container.appendChild(preview);

  const updatePreview = (idx: number) => {
    const v = versions[idx];
    if (!v) return;
    preview.textContent = `[${v.version}] ${new Date((v.timestamp || 0) * 1000).toLocaleString()}\n\nCode:\n${v.code || ''}\n\nOutput:\n${v.output || '(none)'}`;
  };
  updatePreview(0);

  versions.forEach((v: any, i: number) => {
    const row = document.createElement('div');
    row.style.cssText = `padding:5px 10px;cursor:pointer;border-radius:3px;display:flex;justify-content:space-between;${i === 0 ? 'background:rgba(255,255,255,0.1);' : ''}`;
    const ts = new Date((v.timestamp || 0) * 1000).toLocaleString();
    const code = (v.code || '').replace(/\n/g, ' ').substring(0, 80);
    row.innerHTML = `<span style="font-size:13px;"><b>${v.version}</b> ${ts}</span><span style="color:#999;font-size:12px;">${_stripHtml(code)}</span>`;
    row.addEventListener('click', () => {
      selectedIdx = i;
      container.querySelectorAll('div[style]').forEach((el: any) => el.style.background = '');
      row.style.background = 'rgba(255,255,255,0.1)';
      updatePreview(i);
    });
    container.appendChild(row);
  });

  const btnRow = document.createElement('div');
  btnRow.style.cssText = 'margin-top:10px;display:flex;gap:8px;';
  const restoreBtn = _jpBtn('Restore Selected', 'accept');
  restoreBtn.addEventListener('click', () => {
    const v = versions[selectedIdx];
    if (!v || !panel._kernel) return;
    const future = panel._kernel.requestExecute({
      code: `get_ipython().user_ns['_panel_input']('/cell-snapshot-restore ${cell.model.id} ${v.version}')`,
      store_history: false,
    });
    future.done.then((reply: any) => {
      if (reply.content.status === 'ok') {
        restoreBtn.textContent = 'Restored';
        restoreBtn.className = 'jp-mod-styled';
        restoreBtn.style.cssText = 'padding:4px 12px;font-size:12px;background:var(--jp-success-color1, #1a7f37);color:var(--jp-ui-inverse-font-color1, #fff);border:1px solid var(--jp-success-color2, #1a7f37);';
        setTimeout(() => {
          // Close dialog
          const dlg = document.querySelector('.jp-Dialog');
          if (dlg) (dlg as any).remove?.();
        }, 500);
      } else {
        restoreBtn.textContent = 'Failed';
        restoreBtn.className = 'jp-mod-styled jp-mod-warn';
      }
    });
  });
  btnRow.appendChild(restoreBtn);
  container.appendChild(btnRow);

  const bodyWidget = new Widget();
  bodyWidget.node.appendChild(container);
  showDialog({
    title: 'Cell History',
    body: bodyWidget,
    buttons: [Dialog.okButton({ label: 'Close' })],
  });
}

// ===========================================================================
// Plugin
// ===========================================================================

export const panelPlugin: JupyterFrontEndPlugin<void> = {
  id: 'skillbot:tui',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (_app: JupyterFrontEnd, tracker: INotebookTracker) => {
    const panel = new AgentPanel();
    panel.setTracker(tracker);
    panel.setApp(_app);
    _app.shell.add(panel, 'right', { rank: 100 });
    _panelInstance = panel;
    let _panelOpened = false;

    let _currentCtx: any = null;
    let _cellsChangedModel: any = null;
    const onKernelChanged = (_sender: any, args: any) => {
      if (args.oldValue) {
        panel.resetComm();
        panel._clear();
      }
      if (args.newValue) panel.connectKernel(args.newValue);
    };

    const register = () => {
      const nb = tracker.currentWidget;
      if (!nb) return;
      const ctx = nb.context.sessionContext;
      if (!ctx) return;

      // Swap the panel's conversation buffer to match the active notebook.
      // This is what makes each notebook its own session.
      const pathChanged = panel.setActivePath(nb.context.path || '');

      // wire kernel restart handler when context changes
      if (ctx !== _currentCtx) {
        if (_currentCtx) _currentCtx.kernelChanged.disconnect(onKernelChanged);
        _currentCtx = ctx;
        ctx.kernelChanged.connect(onKernelChanged);
      }

      const kernel = ctx.session?.kernel;
      if (kernel) {
        // register cell-execution target directly (not through connectKernel)
        try {
          kernel.registerCommTarget('skillbot:execute-cell', (comm: any, msg: any) => {
            panel._handleCellComm(comm, msg);
          });
        } catch (e) {
          console.error('[panel] registerCommTarget failed:', e);
        }
        panel.connectKernel(kernel);
        // Now that the target notebook's kernel is connected, tell the backend
        // to start a fresh agent conversation for it (only on a real switch).
        if (pathChanged) panel.notifyNotebookSwitch(nb.context.path || '');
      }

      // Wire cell deletion tracking (disconnect old on notebook change)
      const model = nb.model;
      if (model && model.sharedModel !== _cellsChangedModel) {
        _cellsChangedModel = model.sharedModel;
        (model.sharedModel as any).cellsChanged.connect((_sender: any, args: any) => {
          if (args.type === 'remove' && args.oldValues) {
            for (const cell of args.oldValues) {
              const src = cell.source || cell.getSource?.() || '';
              if (src.trim()) {
                kernel?.requestExecute({
                  code: `get_ipython().user_ns['_panel_track_cell_delete'](${JSON.stringify(src)})`,
                  store_history: false,
                });
              }
            }
          }
        });
      }

      // open panel once, after layout restore settles (avoid flash-close)
      if (!_panelOpened) {
        _panelOpened = true;
        setTimeout(() => _app.shell.activateById(panel.id), 300);
      }
    };

    // Cell optimization — right-click → agent improve
    _app.commands.addCommand('skillbot:cell-optimize', {
      label: 'Optimize with Agent',
      execute: async () => {
        const nb = tracker.currentWidget;
        if (!nb || !panel._kernel) return;
        const cell = nb.content.activeCell;
        if (!cell) return;

        const cellId = cell.model.id;
        const cellType = cell.model.type || 'code';
        if (cellType === 'markdown') { alert('Cell optimization only works for code cells.'); return; }
        const code = cell.model.sharedModel.getSource();
        if (!code.trim()) { alert('Cell is empty.'); return; }

        let selectionStart = 0, selectionEnd = 0, selectedText = '';
        try {
          const editor = (cell as any).editor;
          if (editor && editor.selection) {
            const sel = editor.selection;
            if (sel.start && sel.end) {
              selectionStart = sel.start.offset;
              selectionEnd = sel.end.offset;
              if (selectionStart !== selectionEnd) {
                selectedText = code.substring(selectionStart, selectionEnd);
              }
            }
          }
        } catch (_) {}

        let output = '';
        let cellError = '';
        try {
          const outputs = (cell.model as any).outputs;
          if (outputs?.length > 0) {
            const last = outputs.get(outputs.length - 1);
            if (last?.output_type === 'error') {
              cellError = `${last.ename || 'Error'}: ${last.evalue || ''}`;
            } else {
              output = (last?.data?.['text/plain'] as string) || '';
            }
          }
        } catch (_) {}

        const input = document.createElement('textarea');
        input.placeholder = selectedText ? 'e.g. optimize this selected code, fix bug...' : 'e.g. optimize query, fix bug, improve readability...';
        input.style.cssText = 'width:100%;min-height:60px;background:#111;color:#ddd;border:1px solid #444;padding:8px;font-size:12px;resize:vertical;font-family:inherit;';

        const hint = document.createElement('div');
        hint.style.cssText = 'font-size:11px;color:rgb(140,140,140);margin-top:4px;';
        hint.textContent = 'Enter → Optimize    Shift+Enter → Optimize & Run';

        const body = new Widget();
        body.node.appendChild(input);
        body.node.appendChild(hint);

        let autoRun = false;
        const dialog = new Dialog({
          title: selectedText ? 'Optimize Selected Code' : 'Cell Optimization',
          body,
          buttons: [
            Dialog.cancelButton(),
            Dialog.okButton({ label: 'Optimize & Run' }),
            Dialog.okButton({ label: 'Optimize' }),
          ],
        });
        dialog.node.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key !== 'Enter' || e.isComposing) return;
          if (document.activeElement?.tagName === 'TEXTAREA') {
            e.preventDefault();
            e.stopPropagation();
            autoRun = e.shiftKey;
            const btns = dialog.node.querySelectorAll('.jp-Dialog-button');
            const btn = e.shiftKey
              ? (btns[btns.length - 2] as HTMLElement)
              : (btns[btns.length - 1] as HTMLElement);
            btn?.click();
          }
        }, true);
        setTimeout(() => input.focus(), 10);
        const dlgResult = await dialog.launch();

        const clicked = dlgResult.button.label;
        if (clicked === 'Cancel') return;
        const userRequest = input.value.trim() || (selectedText ? 'improve this selected code' : 'improve this code');
        const autoExec = autoRun || clicked === 'Optimize & Run';

        const payloadJson = JSON.stringify({
          cellId, code, output,
          error: cellError,
          cellType,
          request: userRequest,
          auto: autoExec,
          selection: selectedText ? { start: selectionStart, end: selectionEnd, text: selectedText } : null,
        });
        panel._kernel.requestExecute({
          code: `get_ipython().user_ns['_panel_input']('/cell-optimize ' + ${JSON.stringify(payloadJson)})`,
          store_history: false,
        });
      },
    });

    // Unified "History" submenu on cell right-click
    _app.commands.addCommand('skillbot:cell-history', {
      label: 'Cell Snapshots',
      execute: async () => {
        const nb = tracker.currentWidget;
        if (!nb) return;
        const cell = nb.content.activeCell;
        if (!cell) return;
        const cellId = cell.model.id;
        if (!panel._kernel) return;
        const nbPath = nb.context.path || nb.context.localPath || '';
        const future = panel._kernel.requestExecute({
          code: `from jupyter.cell_snapshot import list_versions; import json; d={"versions":list_versions(${JSON.stringify(cellId)}, nb_path=${JSON.stringify(nbPath)}),"cell_id":${JSON.stringify(cellId)}}; print(json.dumps(d))`,
          store_history: false,
        });
        let stdout = '';
        future.onIOPub = (msg: any) => {
          if (msg.header.msg_type === 'stream' && msg.content?.name === 'stdout') stdout += msg.content.text;
        };
        future.done.then(() => {
          try {
            const text = stdout.trim();
            const data = JSON.parse(text);
            const versions = data.versions || [];
            if (!versions.length) {
              alert('No cell snapshots yet. Execute cells first.');
              return;
            }
            _showCellSnapshotsDialog(cell, versions, panel);
          } catch (e) { console.error(e); alert('Failed to load cell snapshots.'); }
        });
      },
    });

    _app.commands.addCommand('skillbot:notebook-snapshots', {
      label: 'Notebook Snapshots',
      execute: async () => {
        const nb = tracker.currentWidget;
        if (!nb) return;
        if (!panel._kernel) return;
        const nbPath = nb.context.path || nb.context.localPath || '';
        const future = panel._kernel.requestExecute({
          code: `from jupyter.notebook_snapshot import list_snapshots_for; from jupyter.magic import _get_magic; import json; inst=_get_magic(); d={"snapshots":list_snapshots_for(${JSON.stringify(nbPath)}),"cell_restored":inst._cell_restored if inst else False}; print(json.dumps(d))`,
          store_history: false,
        });
        let stdout = '';
        future.onIOPub = (msg: any) => {
          if (msg.header.msg_type === 'stream' && msg.content?.name === 'stdout') stdout += msg.content.text;
        };
        future.done.then(() => {
          try {
            const text = stdout.trim();
            const data = JSON.parse(text);
            const snapshots = data.snapshots || [];
            if (!snapshots.length) {
              alert('No notebook snapshots yet. Execute cells first.');
              return;
            }
            _showSnapshotDialog(snapshots, panel, nb, data.cell_restored || false, nbPath);
          } catch (e) { console.error(e); alert('Failed to load snapshots.'); }
        });
      },
    });

    // Submenu on both .jp-Cell and .jp-Notebook
    const historyMenu = new Menu({ commands: _app.commands });
    historyMenu.title.label = 'Agent';
    historyMenu.addItem({ command: 'skillbot:cell-optimize' });
    historyMenu.addItem({ type: 'separator' } as any);
    historyMenu.addItem({ command: 'skillbot:cell-history' });
    historyMenu.addItem({ command: 'skillbot:notebook-snapshots' });

    _app.contextMenu.addItem({
      selector: '.jp-Notebook',
      type: 'submenu' as any,
      submenu: historyMenu,
      rank: 50,
    });

    tracker.currentChanged.connect(() => register());
    setTimeout(register, 500);

    // When a notebook file is deleted from the file browser, purge its
    // conversation record so stale sessions don't linger in the switcher.
    try {
      const contents = (_app.serviceManager as any)?.contents;
      contents?.fileChanged?.connect((_sender: any, change: any) => {
        if (change?.type === 'delete') {
          const p = change.oldValue?.path || '';
          if (p && /\.ipynb$/.test(p)) panel.onNotebookFileDeleted(p);
        }
      });
    } catch (e) {
      console.error('[panel] fileChanged wiring failed:', e);
    }
  },
};
