"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.panelPlugin = void 0;
const widgets_1 = require("@lumino/widgets");
const apputils_1 = require("@jupyterlab/apputils");
const notebook_1 = require("@jupyterlab/notebook");
const widgets_2 = require("@lumino/widgets");
const panelStyles_1 = require("./panelStyles");
const R = __importStar(require("./panelRenderer"));
const PC = __importStar(require("./panelPlanConfirm"));
const DG = __importStar(require("./panelDecisionGate"));
const TARGET = 'skillbot:tui';
let _panelInstance = null;
// ===========================================================================
// AgentPanel
// ===========================================================================
class AgentPanel extends widgets_1.Widget {
    constructor() {
        super();
        this._currentPath = ''; // notebook path of the buffer currently shown
        this._sessionsCollapsed = false; // session list collapsed → compact strip
        this._app = null; // for docmanager open/new
        this._killRing = ''; // for Ctrl+Y yank
        this._lastKill = ''; // track consecutive kill type for accumulation
        this._charsPerLine = 80; // computed from textarea width / monospace char width
        this._statusTimer = null;
        this._execStartTime = 0;
        this._statusIcon = '○';
        this._statusLabel = 'idle';
        this._tracker = null;
        this._kernel = null; // public — accessed by plugin commands
        this._comm = null;
        this._history = [];
        this._historyIdx = -1;
        this._historyDraft = ''; // saved original input when navigating history
        // spinner
        this._spinnerEl = null;
        this._infoTimer = null;
        this._persistTimer = null; // debounce for auto-saving agent-inserted cells
        // mode (cc-haha style: Shift+Tab to cycle)
        this._mode = 'default';
        // plan confirmation
        this._planConfirmActive = false;
        this._planConfirmOptionIdx = 0;
        this._planConfirmFeedbackMode = false;
        this._planCurrentSummary = '';
        // continue confirmation (plan/default mode loop)
        this._continueConfirmActive = false;
        this._continueOptionIdx = 0;
        this._continueSummary = '';
        this._continueFeedbackMode = false;
        // decision gate (scope/direction/gain/launch — dynamic 2-4 options)
        this._gateActive = false;
        this._gateOptionIdx = 0;
        this._gateOptions = [];
        this._gateQuestion = '';
        this._gateFeedbackMode = false;
        this._gateType = '';
        // message block
        this._currentBlock = null;
        this._streaming = false;
        this._responseStarted = false;
        this._textEl = null; // accumulated text element for streaming
        this._thinkingEl = null; // accumulated thinking element
        this._thinkingCollapsed = true; // Ctrl+T to toggle collapse
        this._busy = false; // agent is working → queue new prompts
        this._promptQueue = [];
        this._skillsMode = false; // skills view active → input hidden
        this._stepsMode = false; // steps timeline view active → input hidden
        this._stepData = [];
        // ---- skill rendering ----
        this._skillRows = [];
        this._skillSelectedIdx = 0;
        this._skillListWrapper = null;
        this._skillData = [];
        this._expandedIdx = -1; // -1=list, >=0=info view
        this._fullBodyIdx = -1; // -1=not in full body, >=0=full body view
        this._skillFilter = ''; // live search box text
        this._collapsedCats = new Set(); // collapsed category groups
        this._skillNoticeTimer = null; // auto-clear for _showSkillNotice
        this._configPending = false; // waiting for config confirm (y/n)
        this._commandIdx = -1;
        this.id = 'skillbot:tui';
        this.title.label = 'Agent';
        this.title.closable = true;
        try {
            this._sessionsCollapsed = localStorage.getItem(AgentPanel.COLLAPSE_KEY) === '1';
        }
        catch (_) { }
        // Light-DOM min styles (just enough for JupyterLab to lay out the panel)
        this.node.style.display = 'flex';
        this.node.style.flexDirection = 'column';
        this.node.style.minWidth = '300px';
        this.node.style.backgroundColor = panelStyles_1.CC.bg;
        this.node.style.color = panelStyles_1.CC.text;
        // Shadow DOM — isolates all CSS from JupyterLab
        this._root = this.node.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = panelStyles_1.STYLES;
        this._root.appendChild(style);
        // welcome banner
        const welcome = document.createElement('div');
        welcome.className = 'skillbot-welcome';
        welcome.innerHTML = `
      <div style="font-size:14px;font-weight:600;color:${panelStyles_1.CC.text};margin-bottom:4px;">Agent Panel</div>
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
            var _a, _b;
            if (document.activeElement === this._inputEl)
                return;
            if (e.ctrlKey && !e.altKey) {
                switch (e.key) {
                    case 't':
                        e.preventDefault();
                        this._toggleThinkingCollapse();
                        break;
                    case 'c':
                        e.preventDefault();
                        (_a = this._kernel) === null || _a === void 0 ? void 0 : _a.interrupt();
                        this._setStatus('⏏', 'interrupted');
                        break;
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
                (_b = this._skillListWrapper) === null || _b === void 0 ? void 0 : _b.focus();
            }
        });
        this._outputEl.addEventListener('click', () => {
            // Don't steal focus if user was selecting text (drag, double-click, etc.)
            const sel = document.getSelection();
            if (sel && sel.type !== 'None' && sel.toString().length > 0)
                return;
            if (this._planConfirmActive) {
                this._confirmWrapper.focus();
            }
            else if (this._gateActive || this._continueConfirmActive) {
                this._confirmWrapper.focus();
            }
            else {
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
        this._commandDropdown.style.cssText = `display:none;position:absolute;bottom:100%;left:0;right:0;background:${panelStyles_1.CC.bg};border:1px solid rgba(255,255,255,0.15);border-radius:4px;max-height:180px;overflow-y:auto;z-index:10;margin-bottom:2px;`;
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
    _onKeydown(e) {
        var _a;
        // decision gate: dynamic option selection (2-4 options + "type an answer")
        if (this._gateActive) {
            // Feedback mode: typing flows into the textarea; intercept Enter/Esc.
            if (this._gateFeedbackMode) {
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.altKey && !e.isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                    this._submitDecisionGate();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this._gateFeedbackMode = false;
                    this._renderGateOptions();
                    this._confirmWrapper.focus();
                    return;
                }
                return; // Shift+Enter, arrows, etc. pass through natively
            }
            const n = (this._gateOptions.length || 0) + 1; // +1 trailing "type an answer"
            if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault();
                e.stopPropagation();
                this._gateOptionIdx = (this._gateOptionIdx - 1 + n) % n;
                this._renderGateOptions();
                this._confirmWrapper.focus();
                return;
            }
            if (e.key === 'ArrowDown' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                this._gateOptionIdx = (this._gateOptionIdx + 1) % n;
                this._renderGateOptions();
                this._confirmWrapper.focus();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                this._submitDecisionGate();
                return;
            }
            if (e.key === 'Escape' || ((e.ctrlKey || e.metaKey) && e.key === 'c')) {
                e.preventDefault();
                e.stopPropagation();
                this._cancelDecisionGate();
                return;
            }
            e.preventDefault();
            return;
        }
        // continue confirm: Yes/No selection (plan-style overlay)
        if (this._continueConfirmActive) {
            // Feedback mode: let typing flow into the textarea, intercept Enter/Esc.
            if (this._continueFeedbackMode) {
                if (e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.altKey && !e.isComposing) {
                    e.preventDefault();
                    e.stopPropagation();
                    this._submitContinue();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this._continueFeedbackMode = false;
                    this._renderContinueOptions();
                    this._confirmWrapper.focus();
                    return;
                }
                // Shift+Enter, arrows, etc. pass through to the textarea natively.
                return;
            }
            const n = 3; // Yes / No / Type an answer
            if (e.key === 'ArrowUp' || (e.key === 'Tab' && e.shiftKey)) {
                e.preventDefault();
                e.stopPropagation();
                this._continueOptionIdx = ((this._continueOptionIdx + n - 1) % n);
                this._renderContinueOptions();
                return;
            }
            if (e.key === 'ArrowDown' || e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                this._continueOptionIdx = ((this._continueOptionIdx + 1) % n);
                this._renderContinueOptions();
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                this._submitContinue();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
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
                    e.preventDefault();
                    e.stopPropagation();
                    this._submitPlanConfirm();
                    return;
                }
                if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    this._planConfirmFeedbackMode = false;
                    this._renderConfirmOptions();
                    this._confirmWrapper.focus();
                    return;
                }
                if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                    e.preventDefault();
                    e.stopPropagation();
                    this._cancelPlanConfirm();
                    return;
                }
                // Shift+Enter, Arrow keys, etc. pass through to textarea natively
                return;
            }
            // Option selection mode
            switch (e.key) {
                case 'ArrowUp':
                    e.preventDefault();
                    e.stopPropagation();
                    this._planConfirmOptionIdx = (this._planConfirmOptionIdx === 0 ? 2 : this._planConfirmOptionIdx - 1);
                    this._renderConfirmOptions();
                    this._confirmWrapper.focus();
                    return;
                case 'ArrowDown':
                case 'Tab':
                    e.preventDefault();
                    e.stopPropagation();
                    this._planConfirmOptionIdx = ((this._planConfirmOptionIdx + 1) % 3);
                    this._renderConfirmOptions();
                    this._confirmWrapper.focus();
                    return;
                case 'Enter':
                    e.preventDefault();
                    e.stopPropagation();
                    this._submitPlanConfirm();
                    return;
                case 'Escape':
                    e.preventDefault();
                    e.stopPropagation();
                    this._cancelPlanConfirm();
                    return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'l') {
                // Ctrl+L during confirm: clear panel + cancel confirm
                e.preventDefault();
                e.stopPropagation();
                this._cancelPlanConfirm();
                this._clear();
                return;
            }
            if ((e.ctrlKey || e.metaKey) && e.key === 'c') {
                e.preventDefault();
                e.stopPropagation();
                this._cancelPlanConfirm();
                return;
            }
            e.preventDefault();
            return;
        }
        const ctrl = e.ctrlKey; // Control only — Cmd/Meta passes through for OS shortcuts
        const el = this._inputEl;
        const ss = el.selectionStart;
        const se = el.selectionEnd;
        const v = el.value;
        // Helper: accumulate kills (consecutive same-type kills append, different type overwrites)
        const doKill = (type, text) => {
            if (this._lastKill === type && this._killRing) {
                this._killRing += text;
            }
            else {
                this._killRing = text;
            }
            this._lastKill = type;
        };
        // ---- Emacs-style Ctrl shortcuts ----
        if (ctrl && !e.altKey) {
            switch (e.key) {
                case 'a':
                    e.preventDefault();
                    el.selectionStart = el.selectionEnd = 0;
                    return;
                case 'b':
                    e.preventDefault();
                    el.selectionStart = el.selectionEnd = Math.max(0, ss - 1);
                    return;
                case 'e':
                    e.preventDefault();
                    el.selectionStart = el.selectionEnd = v.length;
                    return;
                case 'f':
                    e.preventDefault();
                    el.selectionStart = el.selectionEnd = Math.min(v.length, ss + 1);
                    return;
                case 'h':
                    e.preventDefault();
                    if (ss !== se) {
                        el.value = v.slice(0, ss) + v.slice(se);
                        el.selectionStart = el.selectionEnd = ss;
                    }
                    else if (ss > 0) {
                        el.value = v.slice(0, ss - 1) + v.slice(ss);
                        el.selectionStart = el.selectionEnd = ss - 1;
                    }
                    this._resizeInput();
                    return;
                case 'n':
                    if (this._navigateHistory(1)) {
                        e.preventDefault();
                    }
                    return;
                case 'p':
                    if (this._navigateHistory(-1)) {
                        e.preventDefault();
                    }
                    return;
                case 'k': {
                    e.preventDefault();
                    if (ss !== se) {
                        el.value = v.slice(0, ss) + v.slice(se);
                        el.selectionStart = el.selectionEnd = ss;
                    }
                    const cur = el.selectionStart;
                    const lineEnd = el.value.indexOf('\n', cur);
                    if (lineEnd !== -1) {
                        // Kill to end of current line (including the newline)
                        doKill('k', el.value.slice(cur, lineEnd + 1));
                        el.value = el.value.slice(0, cur) + el.value.slice(lineEnd + 1);
                    }
                    else if (cur < el.value.length) {
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
                    if (ss !== se) {
                        el.value = v.slice(0, ss) + v.slice(se);
                        el.selectionStart = el.selectionEnd = ss;
                    }
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
                    if (ss !== se) {
                        el.value = v.slice(0, ss) + v.slice(se);
                        el.selectionStart = el.selectionEnd = ss;
                    }
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
                    }
                    else if (v.length === 0) {
                        el.value = '';
                        this._historyIdx = -1;
                        this._historyDraft = '';
                        this._resizeInput();
                    }
                    else if (ss < v.length) {
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
                        if (ss !== se) {
                            el.value = v.slice(0, ss) + v.slice(se);
                            el.selectionStart = el.selectionEnd = ss;
                        }
                        const cur = el.selectionStart;
                        el.value = el.value.slice(0, cur) + this._killRing + el.value.slice(el.selectionEnd);
                        el.selectionStart = el.selectionEnd = cur + this._killRing.length;
                        this._resizeInput();
                    }
                    return;
                }
                case 'c': {
                    e.preventDefault();
                    if (ss !== se)
                        return; // has selection → let browser handle copy (Cmd+C)
                    if (v.length > 0) {
                        // First Ctrl+C: clear input
                        el.value = '';
                        this._historyIdx = -1;
                        this._historyDraft = '';
                        this._killRing = '';
                        this._lastKill = '';
                        this._resizeInput();
                    }
                    else {
                        // Second Ctrl+C (or first on empty input): interrupt agent
                        (_a = this._kernel) === null || _a === void 0 ? void 0 : _a.interrupt();
                        this._setStatus('⏏', 'interrupted');
                    }
                    return;
                }
                case 'l':
                    e.preventDefault();
                    this._clear();
                    return;
                case 't':
                    e.preventDefault();
                    this._toggleThinkingCollapse();
                    return;
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
            this._killRing = '';
            this._lastKill = '';
            if (e.shiftKey || e.metaKey || e.altKey) {
                e.preventDefault();
                // Clear selection before inserting newline
                if (ss !== se) {
                    el.value = v.slice(0, ss) + v.slice(se);
                    el.selectionStart = el.selectionEnd = ss;
                }
                const cur = el.selectionStart;
                el.value = el.value.slice(0, cur) + '\n' + el.value.slice(el.selectionEnd);
                el.selectionStart = el.selectionEnd = cur + 1;
                this._resizeInput();
            }
            else {
                e.preventDefault();
                this._commandDropdown.style.display = 'none';
                this._sendPrompt();
            }
            return;
        }
        // ---- Command dropdown: arrows to select, Tab/Enter to commit, Esc to close ----
        if (this._commandDropdown.style.display !== 'none') {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this._selectCommand(1);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this._selectCommand(-1);
                return;
            }
            if (e.key === 'Enter') {
                e.preventDefault();
                this._commitCommand();
                return;
            }
            if (e.key === 'Escape') {
                e.preventDefault();
                this._commandDropdown.style.display = 'none';
                this._commandIdx = -1;
                return;
            }
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
            this._killRing = '';
            this._lastKill = '';
            this._resizeInput();
            return;
        }
        // ---- Tab ----
        if (e.key === 'Tab') {
            this._killRing = '';
            this._lastKill = '';
            e.preventDefault();
            if (e.shiftKey) {
                this._cycleMode();
            }
            else {
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
            this._killRing = '';
            this._lastKill = '';
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
    _prevWordPos(text, pos) {
        // Skip trailing whitespace
        let i = pos - 1;
        while (i >= 0 && /\s/.test(text[i]))
            i--;
        // Skip the word
        while (i >= 0 && !/\s/.test(text[i]))
            i--;
        return i + 1;
    }
    _nextWordPos(text, pos) {
        let i = pos;
        // Skip current word
        while (i < text.length && !/\s/.test(text[i]))
            i++;
        // Skip whitespace
        while (i < text.length && /\s/.test(text[i]))
            i++;
        return i;
    }
    _resizeInput() {
        const el = this._inputEl;
        el.style.height = 'auto';
        el.style.height = Math.min(el.scrollHeight, 200) + 'px';
        this._recalcCharsPerLine();
    }
    _recalcCharsPerLine() {
        const el = this._inputEl;
        if (el.clientWidth <= 0)
            return;
        try {
            const style = getComputedStyle(el);
            const padL = parseFloat(style.paddingLeft) || 0;
            const padR = parseFloat(style.paddingRight) || 0;
            const cw = el.clientWidth - padL - padR - 2; // -2 for border
            // Measure monospace char width using canvas
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            ctx.font = style.font;
            const charW = ctx.measureText('W').width;
            this._charsPerLine = Math.max(1, Math.floor(cw / charW));
        }
        catch (_) {
            // Fallback: ~7.8px per char at 13px for SF Mono
            this._charsPerLine = Math.max(1, Math.floor((el.clientWidth - 18) / 7.8));
        }
    }
    // Visual line number at text position (accounts for both \n and word-wrap)
    _visualLineAt(text, pos) {
        let line = 0, col = 0;
        const limit = Math.min(pos, text.length);
        for (let i = 0; i < limit; i++) {
            if (text[i] === '\n') {
                line++;
                col = 0;
            }
            else if (++col >= this._charsPerLine) {
                line++;
                col = 0;
            }
        }
        return line;
    }
    _isOnFirstVisualLine(text, pos) {
        return this._visualLineAt(text, pos) === 0;
    }
    _isOnLastVisualLine(text, pos) {
        const cursorLine = this._visualLineAt(text, pos);
        const lastLine = this._visualLineAt(text, text.length);
        return cursorLine >= lastLine;
    }
    _navigateHistory(direction) {
        const v = this._inputEl.value;
        // Save draft on first entry into history
        if (this._historyIdx === -1 && v) {
            this._historyDraft = v;
        }
        this._killRing = '';
        this._lastKill = '';
        const newIdx = this._historyIdx - direction; // direction: -1 = older (↑), 1 = newer (↓)
        if (newIdx >= -1 && newIdx < this._history.length) {
            this._historyIdx = newIdx;
            if (this._historyIdx === -1) {
                this._inputEl.value = this._historyDraft;
                this._historyDraft = '';
            }
            else {
                this._inputEl.value = this._history[this._history.length - 1 - this._historyIdx];
            }
            // Place cursor at start so next ArrowUp immediately triggers more history
            this._inputEl.selectionStart = this._inputEl.selectionEnd = 0;
            this._resizeInput();
            return true;
        }
        return false;
    }
    _updateCommandDropdown() {
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
        if (this._commandIdx < 0 || this._commandIdx >= matches.length)
            this._commandIdx = 0;
        this._commandDropdown.innerHTML = '';
        matches.forEach((cmd, i) => {
            const item = document.createElement('div');
            item.style.cssText = `padding:3px 8px;font-size:12px;cursor:pointer;color:${panelStyles_1.CC.text};${i === this._commandIdx ? 'background:rgba(255,255,255,0.1);' : ''}`;
            item.textContent = cmd;
            item.addEventListener('click', () => { this._inputEl.value = cmd; this._inputEl.focus(); this._commandDropdown.style.display = 'none'; });
            this._commandDropdown.appendChild(item);
        });
        this._commandDropdown.style.display = 'block';
    }
    _selectCommand(delta) {
        if (this._commandDropdown.style.display === 'none')
            return;
        const val = this._inputEl.value;
        const matches = this._commands.filter(c => c.startsWith(val) && c !== val);
        if (matches.length === 0)
            return;
        this._commandIdx = (this._commandIdx + delta + matches.length) % matches.length;
        this._updateCommandDropdown();
    }
    _commitCommand() {
        if (this._commandDropdown.style.display === 'none')
            return;
        const val = this._inputEl.value;
        const matches = this._commands.filter(c => c.startsWith(val) && c !== val);
        if (matches.length === 0)
            return;
        const idx = this._commandIdx >= 0 ? this._commandIdx : 0;
        if (idx < matches.length) {
            this._inputEl.value = matches[idx];
            this._inputEl.selectionStart = this._inputEl.selectionEnd = matches[idx].length;
            this._commandDropdown.style.display = 'none';
            this._commandIdx = -1;
            this._resizeInput();
        }
    }
    _tabComplete() {
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
    _cycleMode() {
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
    _togglePlanMode() {
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
    _updateModeInfo() {
        if (this._infoTimer)
            clearTimeout(this._infoTimer);
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
        }
        else {
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
    _isDisplayCommand(text) {
        return AgentPanel.DISPLAY_COMMANDS.some(c => text === c || text.startsWith(c + ' '));
    }
    _sendPrompt() {
        if (this._planConfirmActive)
            return;
        const text = this._inputEl.value.trim();
        if (!text)
            return;
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
        }
        else {
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
            future.onIOPub = (msg) => {
                var _a;
                if (msg.header.msg_type === 'stream' && ((_a = msg.content) === null || _a === void 0 ? void 0 : _a.name) === 'stdout') {
                    if (firstStdout) {
                        this._renderResponseText(msg.content.text);
                        firstStdout = false;
                    }
                    else {
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
    _startBlock() {
        this._currentBlock = document.createElement('div');
        this._currentBlock.className = 'skillbot-msg-block';
        this._outputEl.appendChild(this._currentBlock);
        this._streaming = true;
        this._responseStarted = false;
        this._textEl = null;
        this._thinkingEl = null;
    }
    _appendToBlock(el) {
        const target = this._currentBlock || this._outputEl;
        target.appendChild(el);
        this._scrollBottom();
    }
    // ---- renderers ----------------------------------------------------------
    _ensureResponsePrefix() { R.ensureResponsePrefix(this); }
    _renderPrompt(text) { R.renderPrompt(this, text); }
    _renderResponseText(content) { R.renderResponseText(this, content); }
    _appendTextChunk(content) { R.appendTextChunk(this, content); }
    _renderTool(name) { R.renderTool(this, name); }
    _renderThinking(content) { R.renderThinking(this, content); }
    _renderCodeBlock(l, c) { R.renderCodeBlock(this, l, c); }
    _renderPlanBlock(text) { R.renderPlanBlock(this, text); }
    _renderResult(summary) { R.renderResult(this, summary); }
    _enterSkillsMode() {
        this._skillsMode = true;
        this._inputWrapper.style.display = 'none';
        this._outputEl.querySelectorAll('.skillbot-skill-list').forEach(el => el.remove());
        this._renderActionBar();
    }
    _exitSkillsMode() {
        this._skillsMode = false;
        this._inputWrapper.style.display = '';
        this._skillRows = [];
        this._skillSelectedIdx = 0;
        this._expandedIdx = -1;
        this._outputEl.querySelectorAll('.skillbot-skill-list').forEach(el => el.remove());
        this._renderActionBar();
        this._inputEl.focus();
        // Reset textarea height (lost during display:none)
        setTimeout(() => this._resizeInput(), 0);
    }
    // ---- steps timeline view -------------------------------------------------
    _enterStepsMode() {
        if (this._skillsMode)
            this._exitSkillsMode();
        this._stepsMode = true;
        this._inputWrapper.style.display = 'none';
        this._renderActionBar();
        // Pull the current timeline from the backend.
        if (this._kernel) {
            try {
                this._kernel.requestExecute({
                    code: `get_ipython().user_ns['_panel_input']('/steps')`,
                    store_history: false,
                });
            }
            catch (_) { }
        }
        this._renderStepList(this._stepData);
    }
    _exitStepsMode() {
        this._stepsMode = false;
        this._inputWrapper.style.display = '';
        this._outputEl.querySelectorAll('.skillbot-step-list').forEach(el => el.remove());
        this._renderActionBar();
        this._inputEl.focus();
        setTimeout(() => this._resizeInput(), 0);
    }
    _renderStepList(steps) {
        this._stepData = steps;
        this._outputEl.querySelectorAll('.skillbot-step-list').forEach(el => el.remove());
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
            this._outputEl.appendChild(wrapper);
            this._scrollBottom();
            return;
        }
        const items = document.createElement('div');
        items.className = 'skillbot-step-items';
        for (const step of steps) {
            items.appendChild(this._renderStepCard(step));
        }
        wrapper.appendChild(items);
        this._outputEl.appendChild(wrapper);
        this._scrollBottom();
    }
    _renderStepCard(step) {
        const card = document.createElement('div');
        card.className = 'skillbot-step-card ' + (step.status || 'pending');
        // Row 1: badge + index + title
        const row = document.createElement('div');
        row.className = 'skillbot-step-row';
        const badgeMeta = AgentPanel.STEP_BADGE[step.status] || AgentPanel.STEP_BADGE.pending;
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
        acts.appendChild(mk('▶ 重跑', bound ? '仅重跑这一步（不重跑全链路）' : '该步尚未生成 cell', () => this._rerunStep(step), !bound));
        acts.appendChild(mk('⟲ 回退', bound ? '回退这一步到历史版本' : '该步尚未生成 cell', () => this._rollbackStep(step), !bound));
        acts.appendChild(mk('✏️ 修正', bound ? '改这一步的方案/口径，AI 重写并可从这步往下重跑' : '该步尚未生成 cell', () => this._reviseStep(step), !bound));
        card.appendChild(acts);
        return card;
    }
    /** ▶ Re-run just this step's cell in place (no full-chain re-run). */
    _rerunStep(step) {
        var _a;
        const nb = (_a = this._tracker) === null || _a === void 0 ? void 0 : _a.currentWidget;
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
                this._showStepNotice(`▶ 重跑步骤 ${step.index || ''}`);
                return;
            }
        }
        this._showStepNotice('✗ 找不到对应的 cell（可能已被删除）');
    }
    /** ⟲ Roll this step's cell back to a previous snapshot version. */
    _rollbackStep(step) {
        var _a;
        const nb = (_a = this._tracker) === null || _a === void 0 ? void 0 : _a.currentWidget;
        if (!nb || !step.cell_id || !this._kernel)
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
            this._showStepNotice('✗ 找不到对应的 cell');
            return;
        }
        const nbPath = nb.context.path || nb.context.localPath || '';
        const future = this._kernel.requestExecute({
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
                    this._showStepNotice('该步暂无历史版本');
                    return;
                }
                _showCellSnapshotsDialog(cell, versions, this);
            }
            catch (e) {
                console.error(e);
                this._showStepNotice('✗ 读取历史版本失败');
            }
        });
    }
    /** ✏️ Revise just this step — describe the change, agent rewrites this cell only. */
    async _reviseStep(step) {
        var _a, _b;
        const nb = (_a = this._tracker) === null || _a === void 0 ? void 0 : _a.currentWidget;
        if (!nb || !step.cell_id || !this._kernel)
            return;
        let cell = null;
        for (const c of nb.content.widgets) {
            if (c.model.id === step.cell_id) {
                cell = c;
                break;
            }
        }
        if (!cell) {
            this._showStepNotice('✗ 找不到对应的 cell');
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
        this._kernel.requestExecute({
            code: `get_ipython().user_ns['_panel_input']('/cell-optimize ' + ${JSON.stringify(payloadJson)})`,
            store_history: false,
        });
        // Revise runs through the agent (backend enters STREAMING) but is dispatched
        // directly via the kernel, bypassing _send — so mark busy ourselves, otherwise
        // the Stop button stays disabled and the user can't interrupt. The backend's
        // `ready` comm on completion clears _busy again.
        this._busy = true;
        this._syncActionBar();
        this._showStepNotice(runBelow
            ? `✏️ 正在按新方案重写步骤 ${step.index} 并往下重跑…`
            : `✏️ 正在按新方案重写步骤 ${step.index}…`);
    }
    _showStepNotice(msg) {
        if (!msg)
            return;
        const list = this._outputEl.querySelector('.skillbot-step-list');
        if (!list)
            return;
        list.querySelectorAll('.skillbot-step-notice').forEach(el => el.remove());
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
    _renderSkillList(skills) {
        this._skillData = skills.map(s => ({ ...s, body: s.body || '', category: s.category || '' }));
        this._skillRows = [];
        this._skillSelectedIdx = 0;
        this._expandedIdx = -1;
        this._fullBodyIdx = -1;
        // Remove old list, rebuild
        this._outputEl.querySelectorAll('.skillbot-skill-list').forEach(el => el.remove());
        const wrapper = document.createElement('div');
        wrapper.className = 'skillbot-skill-list';
        wrapper.tabIndex = 0;
        wrapper.style.outline = 'none';
        // Header: title + action buttons (upload / restart)
        const head = document.createElement('div');
        head.style.cssText = `display:flex;align-items:center;gap:6px;margin-bottom:6px;padding:0 4px;`;
        const title = document.createElement('div');
        title.style.cssText = `font-size:13px;font-weight:600;color:${panelStyles_1.CC.text};margin-right:auto;`;
        title.textContent = `Skills · ${this._skillData.length}`;
        head.appendChild(title);
        const uploadBtn = document.createElement('button');
        uploadBtn.className = 'skillbot-skill-upload';
        uploadBtn.textContent = '➕ 上传';
        uploadBtn.title = '上传技能 (.zip)';
        uploadBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this._promptUploadSkill(); });
        head.appendChild(uploadBtn);
        const restartBtn = document.createElement('button');
        restartBtn.className = 'skillbot-skill-restart';
        restartBtn.textContent = '⟳ 重启生效';
        restartBtn.title = '重启 agent 会话，让技能开关生效';
        restartBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); this._restartAgent(); });
        head.appendChild(restartBtn);
        wrapper.appendChild(head);
        // Search box — live filter over name + description
        const search = document.createElement('input');
        search.className = 'skillbot-skill-search';
        search.type = 'text';
        search.placeholder = '🔎 搜索技能…';
        search.value = this._skillFilter;
        search.addEventListener('input', () => {
            this._skillFilter = search.value;
            this._refreshSkillRows();
        });
        // Keep search keystrokes from bubbling to the list-nav handler
        search.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this._exitSkillsMode();
                return;
            }
            e.stopPropagation();
        });
        wrapper.appendChild(search);
        const listEl = document.createElement('div');
        listEl.className = 'skillbot-skill-items';
        wrapper.appendChild(listEl);
        const hint = document.createElement('div');
        hint.className = 'skillbot-skill-hint';
        hint.style.cssText = `font-size:10px;color:rgb(120,120,120);margin-top:4px;padding:0 4px;`;
        hint.textContent = skills.length === 0
            ? '➕ 上传 从 .zip 安装技能  Esc 关闭'
            : '🔎 搜索 · 点分类折叠 · 点开关启用/停用 · Enter 详情 · Esc 关闭';
        wrapper.appendChild(hint);
        wrapper.addEventListener('keydown', (e) => this._onSkillKeydown(e));
        this._skillListWrapper = wrapper;
        this._outputEl.appendChild(wrapper);
        this._scrollBottom();
        this._refreshSkillRows();
        // Focus wrapper so keyboard nav works (input is hidden in skills mode)
        setTimeout(() => wrapper.focus(), 50);
    }
    /** Open the browser file picker and upload the chosen .zip as a skill. */
    _promptUploadSkill() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zip,application/zip';
        input.style.display = 'none';
        input.addEventListener('change', () => {
            const file = input.files && input.files[0];
            if (!file)
                return;
            const reader = new FileReader();
            reader.onload = () => {
                // reader.result is a data URL: strip the "data:...;base64," prefix
                const result = String(reader.result || '');
                const b64 = result.includes(',') ? result.split(',', 2)[1] : result;
                const nameArg = JSON.stringify(file.name);
                const b64Arg = JSON.stringify(b64);
                if (this._kernel) {
                    this._kernel.requestExecute({
                        code: `get_ipython().user_ns['_panel_upload_skill'](${nameArg}, ${b64Arg})`,
                        store_history: false,
                    });
                }
            };
            reader.readAsDataURL(file);
        });
        document.body.appendChild(input);
        input.click();
        setTimeout(() => input.remove(), 1000);
    }
    /** Restart the agent session so enable/disable changes take effect. */
    _restartAgent() {
        if (this._kernel) {
            this._kernel.requestExecute({
                code: `get_ipython().user_ns['_panel_restart_agent']()`,
                store_history: false,
            });
        }
    }
    _onSkillKeydown(e) {
        // The list is now driven by direct clicks (toggle switch / name / 🗑 /
        // ➕ upload / ⟳ restart / 🔎 search). Keyboard only needs to close the
        // view and step out of a full-body drill-down.
        // Full body view → Esc backs out to the collapsed row.
        if (this._fullBodyIdx !== -1) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this._fullBodyIdx = -1;
                this._refreshSkillRows();
                setTimeout(() => { var _a; return (_a = this._skillListWrapper) === null || _a === void 0 ? void 0 : _a.focus(); }, 0);
            }
            return;
        }
        // Expanded detail → Esc collapses it.
        if (this._expandedIdx !== -1) {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                this._expandedIdx = -1;
                this._fullBodyIdx = -1;
                this._refreshSkillRows();
                setTimeout(() => { var _a; return (_a = this._skillListWrapper) === null || _a === void 0 ? void 0 : _a.focus(); }, 0);
            }
            return;
        }
        // Otherwise Esc leaves skills mode entirely.
        if (e.key === 'Escape') {
            e.preventDefault();
            e.stopPropagation();
            this._exitSkillsMode();
        }
    }
    _refreshSkillRows() {
        var _a;
        const listEl = (_a = this._skillListWrapper) === null || _a === void 0 ? void 0 : _a.querySelector('.skillbot-skill-items');
        if (!listEl)
            return;
        listEl.innerHTML = '';
        this._skillRows = [];
        // Empty state in list area
        if (this._skillData.length === 0) {
            const empty = document.createElement('div');
            empty.style.cssText = `padding:12px 4px;font-size:12px;color:rgb(120,120,120);text-align:center;`;
            empty.textContent = '还没有技能，点右上角 ➕ 上传 从 .zip 安装';
            listEl.appendChild(empty);
            this._updateSkillHint();
            return;
        }
        // Apply live search filter over name + description.
        const q = this._skillFilter.trim().toLowerCase();
        const matches = (s) => !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);
        // Group by category, preserving discovery order within each group.
        const groups = new Map();
        this._skillData.forEach((s, idx) => {
            if (!matches(s))
                return;
            const cat = s.category || 'Uncategorized';
            if (!groups.has(cat))
                groups.set(cat, []);
            groups.get(cat).push({ s, idx });
        });
        if (groups.size === 0) {
            const none = document.createElement('div');
            none.style.cssText = `padding:12px 4px;font-size:12px;color:rgb(120,120,120);text-align:center;`;
            none.textContent = `没有匹配 “${this._skillFilter}” 的技能`;
            listEl.appendChild(none);
            this._updateSkillHint();
            return;
        }
        // Sort categories alphabetically, but keep Uncategorized last.
        const cats = Array.from(groups.keys()).sort((a, b) => {
            if (a === 'Uncategorized')
                return 1;
            if (b === 'Uncategorized')
                return -1;
            return a.localeCompare(b);
        });
        for (const cat of cats) {
            const items = groups.get(cat);
            // When searching, force-expand groups so hits are visible.
            const collapsed = !q && this._collapsedCats.has(cat);
            const enabledCount = items.filter(it => it.s.enabled).length;
            const catHeader = document.createElement('div');
            catHeader.className = 'skillbot-skill-cat';
            catHeader.style.cursor = 'pointer';
            const chevron = collapsed ? '▸' : '▾';
            catHeader.innerHTML =
                `<span style="color:rgb(150,150,150);font-size:10px;width:10px;display:inline-block;">${chevron}</span>` +
                    `<span style="color:${panelStyles_1.CC.text};font-size:11px;font-weight:600;">${this._esc(cat)}</span>` +
                    `<span style="color:rgb(130,130,130);font-size:10px;margin-left:auto;">${enabledCount}/${items.length}</span>`;
            catHeader.addEventListener('click', () => {
                if (this._collapsedCats.has(cat))
                    this._collapsedCats.delete(cat);
                else
                    this._collapsedCats.add(cat);
                this._refreshSkillRows();
            });
            listEl.appendChild(catHeader);
            if (collapsed)
                continue;
            for (const { s, idx } of items) {
                const selected = idx === this._skillSelectedIdx;
                const expanded = idx === this._expandedIdx;
                const row = document.createElement('div');
                row.className = 'skillbot-skill-row';
                if (selected)
                    row.style.background = 'rgba(255,255,255,0.08)';
                const header = document.createElement('div');
                header.style.cssText = `display:flex;align-items:center;gap:8px;`;
                // Real click-toggle switch.
                const sw = document.createElement('span');
                sw.className = 'skillbot-toggle' + (s.enabled ? ' on' : '');
                sw.title = s.enabled ? '已启用 — 点击停用' : '已停用 — 点击启用';
                sw.innerHTML = `<span class="skillbot-toggle-knob"></span>`;
                sw.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._toggleSkill(idx);
                });
                header.appendChild(sw);
                const nameSpan = document.createElement('span');
                nameSpan.style.cssText = `color:${s.enabled ? panelStyles_1.CC.text : 'rgb(140,140,140)'};font-size:12px;cursor:pointer;flex:1;`;
                nameSpan.textContent = s.name;
                nameSpan.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._skillSelectedIdx = idx;
                    this._expandedIdx = (this._expandedIdx === idx) ? -1 : idx;
                    this._fullBodyIdx = -1;
                    this._refreshSkillRows();
                });
                header.appendChild(nameSpan);
                const del = document.createElement('span');
                del.textContent = '✕';
                del.title = '卸载技能';
                del.style.cssText = `font-size:12px;cursor:pointer;opacity:0.5;`;
                del.addEventListener('click', (e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    this._uninstallSkill(idx);
                });
                header.appendChild(del);
                row.appendChild(header);
                if (expanded) {
                    const showFull = this._fullBodyIdx === idx;
                    const detail = document.createElement('div');
                    detail.style.cssText = `margin:6px 0 4px 34px;font-size:11px;color:rgb(180,180,180);line-height:1.5;`;
                    detail.innerHTML = `<div style="margin-bottom:4px;">${this._esc(s.description)}</div>`;
                    if (s.body) {
                        const bodyText = showFull ? s.body : s.body.slice(0, 1000);
                        const maxH = showFull ? 350 : 150;
                        detail.innerHTML += `<div style="color:${panelStyles_1.CC.text};background:rgba(255,255,255,0.03);padding:6px;border-radius:3px;max-height:${maxH}px;overflow-y:auto;white-space:pre-wrap;font-size:11px;">${this._esc(bodyText)}${(!showFull && s.body.length > 1000) ? '…' : ''}</div>`;
                        if (!showFull && s.body.length > 1000) {
                            const more = document.createElement('span');
                            more.textContent = '展开全文 ▾';
                            more.style.cssText = `display:inline-block;margin-top:4px;font-size:10px;color:${panelStyles_1.CC.accent};cursor:pointer;`;
                            more.addEventListener('click', (e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                this._fullBodyIdx = idx;
                                this._refreshSkillRows();
                            });
                            detail.appendChild(more);
                        }
                    }
                    row.appendChild(detail);
                }
                listEl.appendChild(row);
                this._skillRows.push(row);
            }
        }
        this._updateSkillHint();
    }
    /** Optimistically flip a skill, tell the backend, and note it needs a restart. */
    _toggleSkill(idx) {
        var _a;
        const s = this._skillData[idx];
        if (!s || !this._kernel)
            return;
        s.enabled = !s.enabled;
        this._refreshSkillRows();
        this._kernel.requestExecute({
            code: `get_ipython().user_ns['_panel_input']('/skills toggle ${s.name}')`,
            store_history: false,
        });
        // Surface the "restart to apply" reality on the restart button.
        const btn = (_a = this._skillListWrapper) === null || _a === void 0 ? void 0 : _a.querySelector('.skillbot-skill-restart');
        if (btn)
            btn.classList.add('pending');
    }
    /** Uninstall a skill after an inline confirm click. */
    _uninstallSkill(idx) {
        const s = this._skillData[idx];
        if (!s || !this._kernel)
            return;
        if (!confirm(`卸载技能 “${s.name}”？此操作会删除其文件。`))
            return;
        this._kernel.requestExecute({
            code: `get_ipython().user_ns['_panel_input']('/skills uninstall ${s.name}')`,
            store_history: false,
        });
    }
    _updateSkillHint() {
        var _a;
        const hintEl = (_a = this._skillListWrapper) === null || _a === void 0 ? void 0 : _a.querySelector('.skillbot-skill-hint');
        if (!hintEl)
            return;
        if (this._skillData.length === 0) {
            hintEl.textContent = '➕ 上传 从 .zip 安装技能  Esc 关闭';
        }
        else {
            hintEl.textContent = '🔎 搜索 · 点分类折叠 · 点开关启用/停用 · 点名字看详情 · Esc 关闭';
        }
    }
    /** Flash a short backend message (upload/uninstall result) above the list. */
    _showSkillNotice(msg) {
        if (!msg || !this._skillListWrapper)
            return;
        let el = this._skillListWrapper.querySelector('.skillbot-skill-notice');
        if (!el) {
            el = document.createElement('div');
            el.className = 'skillbot-skill-notice';
            // Sits right under the search box, above the items.
            const items = this._skillListWrapper.querySelector('.skillbot-skill-items');
            this._skillListWrapper.insertBefore(el, items);
        }
        const ok = !msg.includes('✗');
        el.style.color = ok ? panelStyles_1.CC.accent : 'rgb(220,120,100)';
        el.textContent = msg;
        if (this._skillNoticeTimer)
            clearTimeout(this._skillNoticeTimer);
        this._skillNoticeTimer = setTimeout(() => { if (el)
            el.textContent = ''; }, 6000);
    }
    _renderSkillInfo(skill) {
        const wrapper = document.createElement('div');
        wrapper.className = 'skillbot-skill-info';
        const dot = skill.enabled
            ? `<span style="color:rgb(100,200,100);font-size:16px;">●</span>`
            : `<span style="color:rgb(200,100,100);font-size:16px;">●</span>`;
        const header = document.createElement('div');
        header.style.cssText = `font-size:14px;font-weight:600;color:${panelStyles_1.CC.text};margin-bottom:4px;`;
        header.innerHTML = `${dot} ${this._esc(skill.name)}`;
        const meta = document.createElement('div');
        meta.style.cssText = `font-size:12px;color:rgb(180,180,180);margin-bottom:8px;line-height:1.5;`;
        meta.innerHTML = `
      ${this._esc(skill.description)}<br>
      <span style="color:rgb(140,140,140);">Status:</span> ${skill.enabled ? 'enabled' : 'disabled'}<br>
      <span style="color:rgb(140,140,140);">Path:</span> ${this._esc(skill.path)}
    `;
        const bodyText = (skill.body || '').slice(0, 1500);
        const bodyWrap = document.createElement('div');
        bodyWrap.style.cssText = `font-size:12px;color:${panelStyles_1.CC.text};background:rgba(255,255,255,0.04);padding:8px;border-radius:4px;max-height:200px;overflow-y:auto;white-space:pre-wrap;line-height:1.4;`;
        bodyWrap.textContent = bodyText;
        if ((skill.body || '').length > 1500) {
            bodyWrap.textContent += '\n\n... (truncated)';
        }
        wrapper.appendChild(header);
        wrapper.appendChild(meta);
        wrapper.appendChild(bodyWrap);
        this._appendToBlock(wrapper);
    }
    // ---- thinking collapse (Ctrl+T) ----
    _toggleThinkingCollapse() {
        this._thinkingCollapsed = !this._thinkingCollapsed;
        this._applyThinkingCollapse();
        const status = this._thinkingCollapsed ? 'collapsed' : 'expanded';
        this._infoEl.innerHTML = `<span style="color:rgb(0,180,180)">thinking ${status} · ctrl+t to toggle</span>`;
        if (this._infoTimer)
            clearTimeout(this._infoTimer);
        this._infoTimer = setTimeout(() => { this._infoEl.innerHTML = ''; }, 4000);
    }
    _applyThinkingCollapse() {
        // Use live _thinkingEl during streaming, DOM search for Ctrl+T toggle
        const els = (this._thinkingEl && this._thinkingEl.parentElement)
            ? [this._thinkingEl]
            : Array.from(this._outputEl.querySelectorAll('.skillbot-thinking-line'));
        els.forEach((el) => {
            if (this._thinkingCollapsed) {
                const currentFull = el.getAttribute('data-full') || el.textContent || '';
                el.setAttribute('data-full', currentFull);
                const truncated = currentFull.length > 150 ? currentFull.slice(0, 150) + '...' : currentFull;
                if (el.textContent !== truncated)
                    el.textContent = truncated;
                el.style.cursor = 'pointer';
                el.title = 'ctrl+t to expand';
            }
            else {
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
    _clear() {
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
        this._closeConfirm(); // ensure confirm UI is dismissed
        this._saveState();
        this._inputEl.value = '';
        this._historyIdx = -1;
        this._historyDraft = '';
        this._resizeInput();
    }
    _dequeueNext() {
        if (this._promptQueue.length === 0) {
            this._updateStatusDisplay();
            return;
        }
        const next = this._promptQueue.shift();
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
    // ---- persistence (localStorage, keyed per notebook) ----
    _storageKey(path) {
        const p = path !== undefined ? path : this._currentPath;
        return AgentPanel.STORAGE_PREFIX + (p || '__default__');
    }
    _saveState() {
        let payload = '';
        try {
            payload = JSON.stringify({
                output: this._outputEl.innerHTML,
                history: this._history,
                mode: this._mode,
                status: this._statusEl.innerHTML,
            });
            localStorage.setItem(this._storageKey(), payload);
        }
        catch (_) { }
        // Mirror to disk so the conversation survives restarts / machine changes.
        if (payload && this._currentPath && this._kernel) {
            try {
                this._kernel.requestExecute({
                    code: `get_ipython().user_ns['_panel_save_conversation'](${JSON.stringify(this._currentPath)}, ${JSON.stringify(payload)})`,
                    store_history: false,
                });
            }
            catch (_) { }
        }
    }
    _restoreState() {
        this._loadBuffer(this._currentPath);
    }
    /** Load the conversation buffer for a notebook path into the visible panel. */
    _loadBuffer(path) {
        // reset visible transient state before painting the target buffer
        this._outputEl.innerHTML = '';
        this._history = [];
        this._currentBlock = null;
        this._textEl = null;
        this._thinkingEl = null;
        this._streaming = false;
        let found = false;
        try {
            const raw = localStorage.getItem(this._storageKey(path));
            if (raw) {
                this._applyBuffer(raw);
                found = true;
            }
        }
        catch (_) { }
        // Nothing cached locally (new browser / machine) — ask backend for the
        // disk copy, which arrives async via the 'restore_conversation' action.
        if (!found && path && this._kernel) {
            try {
                this._kernel.requestExecute({
                    code: `get_ipython().user_ns['_panel_load_conversation'](${JSON.stringify(path)})`,
                    store_history: false,
                });
            }
            catch (_) { }
        }
    }
    /** Paint a serialized buffer (JSON string) into the visible panel. */
    _applyBuffer(raw) {
        try {
            const s = JSON.parse(raw);
            if (s.output) {
                this._outputEl.innerHTML = s.output;
                this._scrollBottom();
            }
            if (s.history)
                this._history = s.history;
            if (s.mode) {
                this._mode = s.mode;
                this._updateModeInfo();
                this._renderActionBar();
            }
            if (s.status)
                this._statusEl.innerHTML = s.status;
        }
        catch (_) { }
    }
    // ---- session registry / switcher ----------------------------------------
    /** Map of notebook path → display label, persisted across reloads. */
    _loadRegistry() {
        try {
            const raw = localStorage.getItem(AgentPanel.REGISTRY_KEY);
            if (raw)
                return JSON.parse(raw);
        }
        catch (_) { }
        return {};
    }
    _saveRegistry(reg) {
        try {
            localStorage.setItem(AgentPanel.REGISTRY_KEY, JSON.stringify(reg));
        }
        catch (_) { }
    }
    /** Register (or refresh) a notebook path as a known session. */
    _registerSession(path) {
        if (!path)
            return;
        const reg = this._loadRegistry();
        reg[path] = path.split('/').pop() || path;
        this._saveRegistry(reg);
        this._renderSessionBar();
    }
    /**
     * Switch the panel to a notebook's conversation. Saves the current buffer,
     * loads the target buffer, and (if it differs from the active notebook) opens
     * the corresponding .ipynb via docmanager.
     */
    _switchToSession(path) {
        if (path === this._currentPath) {
            this._openNotebook(path);
            return;
        }
        this._saveState(); // persist the buffer we're leaving
        this._currentPath = path;
        this._loadBuffer(path);
        this._renderSessionBar();
        this._openNotebook(path);
    }
    /** Open an existing notebook file in the main area. */
    _openNotebook(path) {
        if (!this._app || !path)
            return;
        try {
            this._app.commands.execute('docmanager:open', { path });
        }
        catch (e) {
            console.error('[panel] docmanager:open failed:', e);
        }
    }
    /** Create a fresh Untitled.ipynb, open it, and switch the session to it. */
    async _newSession() {
        var _a, _b, _c, _d;
        if (!this._app)
            return;
        try {
            const cwd = ((_d = (_c = (_b = (_a = this._tracker) === null || _a === void 0 ? void 0 : _a.currentWidget) === null || _b === void 0 ? void 0 : _b.context) === null || _c === void 0 ? void 0 : _c.path) === null || _d === void 0 ? void 0 : _d.split('/').slice(0, -1).join('/')) || '';
            const model = await this._app.serviceManager.contents.newUntitled({
                path: cwd,
                type: 'notebook',
            });
            await this._app.commands.execute('docmanager:open', { path: model.path });
            this._registerSession(model.path);
            this._switchToSession(model.path);
        }
        catch (e) {
            console.error('[panel] newSession failed:', e);
        }
    }
    /** Rename a session's display label (persists to registry). */
    _renameSession(path) {
        const reg = this._loadRegistry();
        const current = reg[path] || path.split('/').pop() || path;
        const next = window.prompt('会话名称', current);
        if (next && next.trim()) {
            reg[path] = next.trim();
            this._saveRegistry(reg);
            this._renderSessionBar();
        }
    }
    /** Delete a session record after user confirmation (from the 🗑 button). */
    _deleteSession(path) {
        const reg = this._loadRegistry();
        const label = reg[path] || path.split('/').pop() || path;
        if (!window.confirm(`删除会话「${label}」的对话记录？\n（不会删除 notebook 文件本身）`))
            return;
        this._purgeSession(path);
        this._flashInfo('会话记录已删除');
    }
    /**
     * Remove all traces of a session: registry entry, localStorage buffer, and
     * the on-disk conversation file. If it's the session currently shown, clear
     * the panel too. Shared by the 🗑 button and the notebook-file-deletion
     * listener. Does NOT touch the .ipynb file itself.
     */
    _purgeSession(path) {
        if (!path)
            return;
        const reg = this._loadRegistry();
        delete reg[path];
        this._saveRegistry(reg);
        try {
            localStorage.removeItem(this._storageKey(path));
        }
        catch (_) { }
        // Mirror the delete to disk via the backend bridge.
        if (this._kernel) {
            try {
                this._kernel.requestExecute({
                    code: `get_ipython().user_ns['_panel_delete_conversation'](${JSON.stringify(path)})`,
                    store_history: false,
                });
            }
            catch (_) { }
        }
        // If we just deleted the active session's record, blank the panel view.
        if (path === this._currentPath) {
            this._currentPath = '';
            this._outputEl.innerHTML = '';
            this._history = [];
            this._currentBlock = null;
            this._textEl = null;
            this._thinkingEl = null;
            this._streaming = false;
            this._busy = false;
        }
        this._renderSessionBar();
    }
    /** Public: called by the plugin when a notebook file is deleted from disk.
     *  Silently purges the matching session record (no confirm — the file is
     *  already gone). No-op if we have no record for that path. */
    onNotebookFileDeleted(path) {
        if (!path)
            return;
        const reg = this._loadRegistry();
        const hasRecord = path in reg;
        let hasBuffer = false;
        try {
            hasBuffer = localStorage.getItem(this._storageKey(path)) != null;
        }
        catch (_) { }
        if (!hasRecord && !hasBuffer)
            return; // nothing to clean up
        this._purgeSession(path);
        this._flashInfo(`已随 notebook 删除会话记录`);
    }
    /** Briefly show a message in the info bar. */
    _flashInfo(msg) {
        if (!this._infoEl)
            return;
        this._infoEl.innerHTML = `<span style="color:${panelStyles_1.CC.success}">✓ ${msg}</span>`;
        if (this._infoTimer)
            clearTimeout(this._infoTimer);
        this._infoTimer = setTimeout(() => { this._infoEl.innerHTML = ''; }, 1800);
    }
    _toggleSessionsCollapsed() {
        this._sessionsCollapsed = !this._sessionsCollapsed;
        try {
            localStorage.setItem(AgentPanel.COLLAPSE_KEY, this._sessionsCollapsed ? '1' : '0');
        }
        catch (_) { }
        this._renderSessionBar();
    }
    _renderSessionBar() {
        if (!this._sessionBarEl)
            return;
        const reg = this._loadRegistry();
        const paths = Object.keys(reg);
        this._sessionBarEl.className = 'skillbot-session-bar' + (this._sessionsCollapsed ? ' collapsed' : '');
        this._sessionBarEl.innerHTML = '';
        // header: collapse chevron + title + actions
        const header = document.createElement('div');
        header.className = 'skillbot-session-header';
        const titleWrap = document.createElement('span');
        titleWrap.className = 'skillbot-session-titlewrap';
        titleWrap.addEventListener('click', () => this._toggleSessionsCollapsed());
        const chevron = document.createElement('span');
        chevron.className = 'skillbot-session-chevron';
        chevron.textContent = this._sessionsCollapsed ? '▸' : '▾';
        titleWrap.appendChild(chevron);
        const title = document.createElement('span');
        title.className = 'skillbot-session-title';
        // When collapsed, show the current session's name inline for context.
        const curLabel = this._currentPath ? (reg[this._currentPath] || this._currentPath.split('/').pop()) : '';
        title.textContent = this._sessionsCollapsed && curLabel
            ? `会话 · ${curLabel}`
            : `会话 · ${paths.length}`;
        titleWrap.appendChild(title);
        header.appendChild(titleWrap);
        const actions = document.createElement('span');
        actions.className = 'skillbot-session-actions';
        const add = document.createElement('span');
        add.className = 'skillbot-session-btn skillbot-session-btn-primary';
        add.textContent = '＋ 新建';
        add.title = '新会话（新建 notebook）';
        add.addEventListener('click', () => { void this._newSession(); });
        actions.appendChild(add);
        header.appendChild(actions);
        this._sessionBarEl.appendChild(header);
        // collapsed → header only (compact strip)
        if (this._sessionsCollapsed)
            return;
        // vertical list of sessions
        const list = document.createElement('div');
        list.className = 'skillbot-session-list';
        if (paths.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'skillbot-session-empty';
            empty.textContent = '暂无会话，点「＋ 新建」开始';
            list.appendChild(empty);
        }
        for (const p of paths) {
            const active = p === this._currentPath;
            const row = document.createElement('div');
            row.className = 'skillbot-session-row' + (active ? ' active' : '');
            row.title = p;
            row.addEventListener('click', () => this._switchToSession(p));
            const dot = document.createElement('span');
            dot.className = 'skillbot-session-dot';
            row.appendChild(dot);
            const name = document.createElement('span');
            name.className = 'skillbot-session-name';
            name.textContent = reg[p];
            row.appendChild(name);
            const edit = document.createElement('span');
            edit.className = 'skillbot-session-edit';
            edit.textContent = '✎';
            edit.title = '重命名';
            edit.addEventListener('click', (e) => { e.stopPropagation(); this._renameSession(p); });
            row.appendChild(edit);
            const del = document.createElement('span');
            del.className = 'skillbot-session-del';
            del.textContent = '✕';
            del.title = '删除此会话记录';
            del.addEventListener('click', (e) => { e.stopPropagation(); this._deleteSession(p); });
            row.appendChild(del);
            list.appendChild(row);
        }
        this._sessionBarEl.appendChild(list);
    }
    // ---- agent action bar ---------------------------------------------------
    /** Run a slash command from a button without disturbing the user's draft/history. */
    _dispatchCommand(cmd) {
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
    _interruptAgent() {
        var _a;
        (_a = this._kernel) === null || _a === void 0 ? void 0 : _a.interrupt();
        this._setStatus('⏏', 'interrupted');
        this._stopSpinner();
        this._busy = false;
        this._promptQueue = [];
        this._updateStatusDisplay();
    }
    /** Render the visible agent controls; enable/disable by busy state. */
    _renderActionBar() {
        if (!this._actionBarEl)
            return;
        this._actionBarEl.innerHTML = '';
        const mk = (label, title, cls, on) => {
            const b = document.createElement('span');
            b.className = 'skillbot-action-btn' + (cls ? ' ' + cls : '');
            b.textContent = label;
            b.title = title;
            b.addEventListener('click', (e) => { e.preventDefault(); on(); });
            return b;
        };
        // Stop is prominent while busy, muted otherwise.
        const stop = mk('■ Stop', '停止当前任务 (/stop)', 'skillbot-action-stop', () => {
            if (this._busy)
                this._interruptAgent();
            this._dispatchCommand('/stop');
        });
        if (!this._busy)
            stop.classList.add('disabled');
        this._actionBarEl.appendChild(stop);
        // Plan is a toggle: switch into plan mode, or back to default if active.
        const plan = mk('⏸ Plan', 'Plan 模式开关 (Shift+Tab)', 'skillbot-action-plan', () => this._togglePlanMode());
        if (this._mode === 'plan')
            plan.classList.add('active');
        this._actionBarEl.appendChild(plan);
        this._actionBarEl.appendChild(mk('🗑 Clear', '清空当前会话对话', '', () => this._dispatchCommand('/clear')));
        // Steps is a toggle: open the timeline view, or close it if already open.
        const steps = mk('☰ Steps', '步骤时间线：每步可单独重跑/回退/修正', 'skillbot-action-steps', () => {
            if (this._stepsMode)
                this._exitStepsMode();
            else
                this._enterStepsMode();
        });
        if (this._stepsMode)
            steps.classList.add('active');
        this._actionBarEl.appendChild(steps);
        // Skills is a toggle: open the manager, or close it if already open.
        const skills = mk('≣ Skills', '管理技能 (/skills)', 'skillbot-action-skills', () => {
            if (this._skillsMode)
                this._exitSkillsMode();
            else
                this._dispatchCommand('/skills');
        });
        if (this._skillsMode)
            skills.classList.add('active');
        this._actionBarEl.appendChild(skills);
    }
    /** Called by the plugin when the active notebook changes. Returns true if the
     *  active path actually changed (so the caller can notify the backend). */
    setActivePath(path) {
        if (!path || path === this._currentPath) {
            if (path)
                this._registerSession(path);
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
    notifyNotebookSwitch(path) {
        if (!path || !this._kernel)
            return;
        try {
            this._kernel.requestExecute({
                code: `get_ipython().user_ns['_panel_switch_notebook'](${JSON.stringify(path)})`,
                store_history: false,
            });
        }
        catch (_) { }
    }
    setApp(app) {
        this._app = app;
    }
    // ---- spinner -------------------------------------------------------------
    _startSpinner() {
        if (this._spinnerEl)
            return;
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
    _stopSpinner() {
        if (this._spinnerEl) {
            const wrapper = this._spinnerEl.parentElement;
            if (wrapper)
                wrapper.remove();
            this._spinnerEl = null;
        }
    }
    // ---- status bar ----------------------------------------------------------
    _setStatus(icon, label) {
        this._statusIcon = icon;
        this._statusLabel = label;
        // Start timer for running states, stop for idle/done
        if (icon === '…') {
            if (!this._statusTimer) {
                this._execStartTime = Date.now();
                this._statusTimer = setInterval(() => this._updateStatusDisplay(), 1000);
            }
        }
        else {
            this._stopStatusTimer();
        }
        this._updateStatusDisplay();
    }
    _stopStatusTimer() {
        if (this._statusTimer) {
            clearInterval(this._statusTimer);
            this._statusTimer = null;
        }
    }
    _updateStatusDisplay() {
        const icon = this._statusIcon;
        const label = this._statusLabel;
        const q = this._promptQueue.length > 0
            ? ` <span style="color:rgb(215,119,87)">queued:${this._promptQueue.length}</span>`
            : '';
        if (icon === '…' && this._execStartTime > 0) {
            const elapsed = Math.floor((Date.now() - this._execStartTime) / 1000);
            this._statusEl.innerHTML = `<span>${icon} ${label} (${elapsed}s)${q}</span><span>skillbot</span>`;
        }
        else {
            this._statusEl.innerHTML = `<span>${icon} ${label}${q}</span><span>skillbot</span>`;
        }
        this._syncActionBar();
    }
    /** Keep the Stop button's enabled/prominent state in sync with busy. */
    _syncActionBar() {
        var _a;
        const stop = (_a = this._actionBarEl) === null || _a === void 0 ? void 0 : _a.querySelector('.skillbot-action-stop');
        if (!stop)
            return;
        if (this._busy)
            stop.classList.remove('disabled');
        else
            stop.classList.add('disabled');
    }
    // ---- plan confirmation (delegates to panelPlanConfirm) ------------------
    _renderPlanConfirm(s) { PC.renderPlanConfirm(this, s); }
    _getConfirmHint() { return PC.getConfirmHint(this); }
    _renderConfirmOptions() { PC.renderConfirmOptions(this); }
    _closeConfirm() { PC.closeConfirm(this); }
    _sendConfirmToBackend(c) { PC.sendConfirmToBackend(this, c); }
    _submitPlanConfirm() { PC.submitPlanConfirm(this); }
    _cancelPlanConfirm() { PC.cancelPlanConfirm(this); }
    // ---- decision gate (delegates to panelDecisionGate) ---------------------
    _renderDecisionGate(gate) { DG.renderDecisionGate(this, gate); }
    _renderGateOptions() { DG.renderGateOptions(this); }
    _submitDecisionGate() { DG.submitDecisionGate(this); }
    _cancelDecisionGate() { DG.cancelDecisionGate(this); }
    // ---- continue confirmation (plan-style overlay) --------------------------
    _renderContinueButtons(summary) {
        this._continueConfirmActive = true;
        this._continueOptionIdx = 0;
        this._continueFeedbackMode = false;
        this._continueSummary = summary;
        this._renderContinueOptions();
        this._inputWrapper.style.display = 'none';
        this._confirmWrapper.style.display = 'flex';
        this._confirmWrapper.focus();
    }
    _renderContinueOptions() {
        // Preserve any typed answer across re-render (innerHTML drops the textarea).
        const oldTa = this._confirmWrapper.querySelector('.skillbot-confirm-feedback');
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
            const newTa = this._confirmWrapper.querySelector('.skillbot-confirm-feedback');
            if (newTa)
                newTa.value = saved;
        }
        if (this._continueFeedbackMode) {
            const ta = this._confirmWrapper.querySelector('.skillbot-confirm-feedback');
            if (ta)
                ta.focus();
        }
    }
    _submitContinue() {
        // Feedback mode: send the typed answer back to the agent as prose.
        if (this._continueFeedbackMode) {
            const ta = this._confirmWrapper.querySelector('.skillbot-confirm-feedback');
            const answer = ta ? ta.value.trim() : '';
            if (!answer) {
                this._continueFeedbackMode = false;
                this._renderContinueOptions();
                this._confirmWrapper.focus();
                return;
            }
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
    _sendContinueCmd(cmd) {
        const isAnswer = !/^\/continue (yes|no)$/.test(cmd);
        if (isAnswer) {
            this._startBlock();
            this._startSpinner();
            this._setStatus('…', 'thinking');
        }
        else {
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
    _scrollBottom() {
        this._outputEl.scrollTop = this._outputEl.scrollHeight;
    }
    _stripAnsi(s) {
        return s.replace(/\x1b\[[0-9;]*m/g, '');
    }
    _esc(s) {
        const d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }
    setTracker(tracker) {
        this._tracker = tracker;
    }
    /** Re-run exactly the given cell ids, in order — the precise dependency slice. */
    _runCellsByIds(notebook, sessionContext, ids) {
        const model = notebook.model;
        if (!model)
            return;
        const cells = model.sharedModel.cells;
        const posById = {};
        for (let i = 0; i < cells.length; i++)
            posById[cells[i].id] = i;
        // Select the target cells (deselecting everything else), then run the selection.
        // NotebookActions.run executes the active cell plus all selected cells in
        // document order, which matches the ordered slice we were given.
        const positions = ids.map(id => posById[id]).filter(p => p !== undefined);
        if (!positions.length)
            return;
        positions.sort((a, b) => a - b);
        notebook.activeCellIndex = positions[0];
        notebook.deselectAll();
        for (const p of positions) {
            notebook.select(notebook.widgets[p]);
        }
        notebook_1.NotebookActions.run(notebook, sessionContext);
    }
    _handleCellComm(comm, msg) {
        try {
            this._handleCellCommImpl(comm, msg);
        }
        catch (e) {
            console.error('[panel] _handleCellComm failed:', e);
        }
    }
    _handleCellCommImpl(comm, msg) {
        var _a, _b;
        const data = ((_a = msg.content) === null || _a === void 0 ? void 0 : _a.data) || {};
        const nb = (_b = this._tracker) === null || _b === void 0 ? void 0 : _b.currentWidget;
        if (!nb)
            return;
        const model = nb.model;
        if (!model)
            return;
        const code = data.code || '';
        const auto = data.auto !== false;
        const cellType = data.cell_type || 'code';
        const replaceId = data.replace_cell_id || '';
        // run_below: re-run this cell AND every cell below it (step revise → recompute
        // the downstream chain). Implies execution regardless of the `auto` flag.
        const runBelow = data.run_below === true;
        // run_cell_ids: precise dependency slice — re-run exactly these cells, in order
        // (the changed cell followed by only its true downstream dependents). Takes
        // precedence over runBelow when non-empty.
        const runCellIds = Array.isArray(data.run_cell_ids) ? data.run_cell_ids : [];
        if (!code)
            return;
        const notebook = nb.content;
        if (replaceId) {
            const cells = model.sharedModel.cells;
            for (let i = cells.length - 1; i >= 0; i--) {
                if (cells[i].id === replaceId) {
                    cells[i].source = code;
                    notebook.activeCellIndex = i;
                    comm.send({ cell_id: cells[i].id });
                    this._persistNotebook(); // flush the edit to disk (survives refresh)
                    if (cellType !== 'markdown' && (auto || runBelow || runCellIds.length)) {
                        if (runCellIds.length)
                            this._runCellsByIds(notebook, nb.context.sessionContext, runCellIds);
                        else if (runBelow)
                            notebook_1.NotebookActions.runAllBelow(notebook, nb.context.sessionContext);
                        else
                            notebook_1.NotebookActions.run(notebook, nb.context.sessionContext);
                    }
                    return;
                }
            }
        }
        // Insert new cell + execute
        const activeIndex = notebook.activeCellIndex;
        model.sharedModel.insertCell(activeIndex + 1, {
            cell_type: cellType,
            source: code,
            metadata: {},
        });
        const newCell = model.sharedModel.cells[activeIndex + 1];
        notebook.activeCellIndex = activeIndex + 1;
        comm.send({ cell_id: newCell.id });
        this._persistNotebook(); // flush the new cell to disk (survives refresh)
        if (cellType === 'markdown' || (!auto && !runBelow))
            return;
        if (runBelow)
            notebook_1.NotebookActions.runAllBelow(notebook, nb.context.sessionContext);
        else
            notebook_1.NotebookActions.run(notebook, nb.context.sessionContext);
    }
    // ---- kernel / comm -------------------------------------------------------
    /**
     * Persist the active notebook document to disk. Agent-generated cells are
     * inserted into the in-memory notebook model only, which marks the document
     * dirty but does NOT write it out. Without this, a browser refresh reloads
     * the last-saved (often empty) file and the generated cells vanish. Debounced
     * so a burst of cell edits collapses into a single save.
     */
    _persistNotebook() {
        var _a;
        const nb = (_a = this._tracker) === null || _a === void 0 ? void 0 : _a.currentWidget;
        const ctx = nb === null || nb === void 0 ? void 0 : nb.context;
        if (!(ctx === null || ctx === void 0 ? void 0 : ctx.save))
            return;
        if (this._persistTimer)
            clearTimeout(this._persistTimer);
        this._persistTimer = setTimeout(() => {
            this._persistTimer = null;
            try {
                ctx.save();
            }
            catch (e) {
                console.error('[panel] notebook save failed:', e);
            }
        }, 400);
    }
    resetComm() {
        if (this._comm) {
            try {
                this._comm.close();
            }
            catch (_) { }
            this._comm = null;
        }
        this._kernel = null;
        this._stopStatusTimer();
    }
    connectKernel(kernel) {
        var _a, _b;
        this._kernel = kernel;
        // Notify kernel of active notebook path for snapshot file isolation.
        // Must happen BEFORE `if (this._comm) return` so it fires on every
        // notebook switch and lazy kernel start (via onKernelChanged).
        const nb = (_a = this._tracker) === null || _a === void 0 ? void 0 : _a.currentWidget;
        const nbPath = ((_b = nb === null || nb === void 0 ? void 0 : nb.context) === null || _b === void 0 ? void 0 : _b.path) || '';
        if (nbPath) {
            kernel.requestExecute({
                code: `from jupyter.magic import _set_active_notebook_path; _set_active_notebook_path(${JSON.stringify(nbPath)})`,
                store_history: false,
            });
        }
        // Re-register cell-execution target (needed on kernel restart)
        try {
            kernel.registerCommTarget('skillbot:execute-cell', (comm, msg) => {
                this._handleCellComm(comm, msg);
            });
        }
        catch (e) {
            console.error('[panel] registerCommTarget failed:', e);
        }
        if (this._comm)
            return;
        try {
            this._comm = kernel.createComm(TARGET);
            this._comm.onMsg = (m) => {
                var _a;
                const d = ((_a = m.content) === null || _a === void 0 ? void 0 : _a.data) || {};
                switch (d.action) {
                    case 'text':
                        if (this._skillsMode) {
                            // Surface backend upload/uninstall feedback inline in the list.
                            this._showSkillNotice(this._stripAnsi(d.content || '').trim());
                        }
                        else {
                            // Pass RAW text — the renderer parses markdown + ANSI itself.
                            const raw = d.content || '';
                            this._appendTextChunk(raw);
                            // Backend sent config confirmation → enable y/n
                            if (raw.includes('Press y to apply')) {
                                this._configPending = true;
                                this._infoEl.innerHTML = '<span style=\"color:rgb(0,180,180)\">Press y to apply  n to cancel</span>';
                                if (this._infoTimer)
                                    clearTimeout(this._infoTimer);
                            }
                        }
                        break;
                    case 'tool':
                        this._renderTool(d.name || '');
                        break;
                    case 'thinking':
                        this._renderThinking(d.content || '');
                        break;
                    case 'code_block':
                        this._renderCodeBlock(d.language || '', d.code || '');
                        break;
                    case 'result':
                        this._stopSpinner();
                        if (this._planConfirmActive)
                            this._closeConfirm();
                        this._renderResult(d.summary || '');
                        break;
                    case 'plan_confirm':
                        if (this._planConfirmActive)
                            this._closeConfirm();
                        this._stopSpinner();
                        this._streaming = false;
                        this._responseStarted = false;
                        this._setStatus('⏸', 'plan');
                        this._renderPlanBlock(d.summary || '');
                        this._renderPlanConfirm(d.summary || '');
                        this._saveState();
                        break;
                    case 'skill_list':
                        if (!this._skillsMode)
                            this._enterSkillsMode();
                        this._renderSkillList(d.skills || []);
                        break;
                    case 'step_timeline':
                        // Keep the model current even when the view is closed, so opening
                        // Steps later shows the latest state without a round-trip.
                        this._stepData = d.steps || [];
                        if (this._stepsMode)
                            this._renderStepList(this._stepData);
                        break;
                    case 'continue_confirm':
                        this._stopSpinner();
                        this._busy = false;
                        this._dequeueNext();
                        this._renderContinueButtons(d.summary || '');
                        break;
                    case 'decision_gate':
                        if (this._planConfirmActive)
                            this._closeConfirm();
                        this._stopSpinner();
                        this._streaming = false;
                        this._responseStarted = false;
                        this._busy = false;
                        this._dequeueNext();
                        this._setStatus('⏸', 'decision');
                        this._renderDecisionGate(d.gate || {});
                        this._saveState();
                        break;
                    case 'ready':
                        this._stopSpinner();
                        this._busy = false;
                        this._dequeueNext();
                        this._syncActionBar();
                        break;
                    case 'clear':
                        this._clear();
                        break;
                    case 'restore_conversation':
                        // Disk copy arrived for a path with no localStorage cache.
                        if ((d.path || '') === this._currentPath && d.buffer) {
                            this._applyBuffer(d.buffer);
                            try {
                                localStorage.setItem(this._storageKey(this._currentPath), d.buffer);
                            }
                            catch (_) { }
                        }
                        break;
                    case 'conversation_list':
                        // Merge disk-persisted sessions into the switcher registry.
                        if (Array.isArray(d.sessions)) {
                            const reg = this._loadRegistry();
                            for (const s of d.sessions) {
                                if (s.path)
                                    reg[s.path] = s.path.split('/').pop() || s.path;
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
            }
            catch (_) { }
        }
        catch (e) {
            console.error('[panel] createComm failed:', e);
        }
    }
}
// Per-notebook conversation buffers are stored under keys derived from the
// notebook path (see _storageKey). A separate registry key tracks the set of
// known sessions so we can render the session switcher across reloads.
AgentPanel.STORAGE_PREFIX = 'skillbot-panel:';
AgentPanel.REGISTRY_KEY = 'skillbot-sessions';
AgentPanel.COLLAPSE_KEY = 'skillbot-sessions-collapsed';
// ---- mode cycling (cc-haha: Shift+Tab) ----
AgentPanel.MODE_ORDER = ['default', 'plan', 'auto'];
AgentPanel.MODE_COLOR = {
    default: '',
    plan: 'rgb(0,102,102)', // cyan, cc-haha planMode
    auto: 'rgb(135,0,255)', // purple, cc-haha autoAccept
};
AgentPanel.MODE_SYMBOL = {
    default: '',
    plan: '⏸',
    auto: '⏵⏵',
};
AgentPanel.MODE_INFO = {
    plan: ['Plan mode — I\'ll explore first, then design a plan for your approval',
        'Plan mode — describe your task, I\'ll research & propose an approach',
        'Plan mode — no code is written until you approve the plan'],
    auto: ['Auto mode — cells are generated and executed automatically',
        'Auto mode — I\'ll write code and run it without asking'],
    default: ['Default mode — cells are generated but need manual execution',
        'Default mode — I decide whether to plan first or write code directly'],
};
// ---- prompt -------------------------------------------------------------
AgentPanel.DISPLAY_COMMANDS = ['/clear', '/mode', '/skills', '/config', '/continue', '/stop'];
AgentPanel.STEP_BADGE = {
    pending: { icon: '○', cls: 'pending' },
    running: { icon: '◐', cls: 'running' },
    done: { icon: '✓', cls: 'done' },
    failed: { icon: '⚠', cls: 'failed' },
};
// ===========================================================================
// Notebook Snapshot Dialog
// ===========================================================================
function _jpBtn(text, kind) {
    const b = document.createElement('button');
    b.textContent = text;
    b.className = kind ? `jp-mod-styled jp-mod-${kind}` : 'jp-mod-styled';
    b.style.cssText = 'padding:4px 12px;font-size:12px;';
    return b;
}
function _showSnapshotDialog(snapshots, panel, nb, cellRestored, nbPath) {
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
    const updateSelection = (s, row) => {
        selectedId = s.id;
        container.querySelectorAll('.snapshot-row').forEach((el) => el.style.background = '');
        row.style.background = 'rgba(255,255,255,0.1)';
        // Show preview
        const previews = s.preview || [];
        if (previews.length > 0) {
            previewPanel.textContent = previews.map((p, i) => `[${i + 1}] ${p}`).join('\n');
        }
        else {
            previewPanel.textContent = '(no code preview)';
        }
    };
    snapshots.forEach((s, i) => {
        const row = document.createElement('div');
        row.className = 'snapshot-row';
        row.style.cssText = `padding:5px 10px;cursor:pointer;border-radius:3px;display:flex;justify-content:space-between;${i === 0 ? 'background:rgba(255,255,255,0.08);' : ''}`;
        const ts = new Date((s.timestamp || 0) * 1000).toLocaleString();
        row.innerHTML = `<span style="font-size:13px;"><b>${ts}</b></span><span style="color:#999;font-size:12px;">${s.cells_count} cells</span>`;
        row.addEventListener('click', () => updateSelection(s, row));
        container.appendChild(row);
        if (i === 0) {
            selectedId = s.id;
            previewPanel.textContent = (s.preview || []).map((p, j) => `[${j + 1}] ${p}`).join('\n') || '(no code preview)';
        }
    });
    const btnRow = document.createElement('div');
    btnRow.style.cssText = 'margin-top:10px;display:flex;gap:8px;';
    const restoreBtn = _jpBtn('Restore Notebook', 'accept');
    restoreBtn.addEventListener('click', () => {
        if (!selectedId || !panel._kernel)
            return;
        // Fetch snapshot cells, then restore directly via notebook model
        const future = panel._kernel.requestExecute({
            code: `from jupyter.notebook_snapshot import get_snapshot; import json; sid=${JSON.stringify(selectedId)}; np=${JSON.stringify(nbPath)}; print(json.dumps(get_snapshot(sid, nb_path=np).get("cells",[]) if get_snapshot(sid, nb_path=np) else []))`,
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
                const cells = JSON.parse(stdout.trim());
                if (!cells || !cells.length) {
                    restoreBtn.textContent = 'No cells';
                    return;
                }
                const model = nb.model;
                if (!model) {
                    restoreBtn.textContent = 'No model';
                    return;
                }
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
            }
            catch (e) {
                console.error(e);
                restoreBtn.textContent = 'Failed';
                restoreBtn.className = 'jp-mod-styled jp-mod-warn';
            }
        });
    });
    btnRow.appendChild(restoreBtn);
    container.appendChild(btnRow);
    const bodyWidget = new widgets_1.Widget();
    bodyWidget.node.appendChild(container);
    (0, apputils_1.showDialog)({
        title: 'Notebook Snapshots',
        body: bodyWidget,
        buttons: [apputils_1.Dialog.okButton({ label: 'Close' })],
    });
}
// ===========================================================================
// Cell Snapshots Dialog
// ===========================================================================
function _stripHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
}
function _showCellSnapshotsDialog(cell, versions, panel) {
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
    const updatePreview = (idx) => {
        const v = versions[idx];
        if (!v)
            return;
        preview.textContent = `[${v.version}] ${new Date((v.timestamp || 0) * 1000).toLocaleString()}\n\nCode:\n${v.code || ''}\n\nOutput:\n${v.output || '(none)'}`;
    };
    updatePreview(0);
    versions.forEach((v, i) => {
        const row = document.createElement('div');
        row.style.cssText = `padding:5px 10px;cursor:pointer;border-radius:3px;display:flex;justify-content:space-between;${i === 0 ? 'background:rgba(255,255,255,0.1);' : ''}`;
        const ts = new Date((v.timestamp || 0) * 1000).toLocaleString();
        const code = (v.code || '').replace(/\n/g, ' ').substring(0, 80);
        row.innerHTML = `<span style="font-size:13px;"><b>${v.version}</b> ${ts}</span><span style="color:#999;font-size:12px;">${_stripHtml(code)}</span>`;
        row.addEventListener('click', () => {
            selectedIdx = i;
            container.querySelectorAll('div[style]').forEach((el) => el.style.background = '');
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
        if (!v || !panel._kernel)
            return;
        const future = panel._kernel.requestExecute({
            code: `get_ipython().user_ns['_panel_input']('/cell-snapshot-restore ${cell.model.id} ${v.version}')`,
            store_history: false,
        });
        future.done.then((reply) => {
            if (reply.content.status === 'ok') {
                restoreBtn.textContent = 'Restored';
                restoreBtn.className = 'jp-mod-styled';
                restoreBtn.style.cssText = 'padding:4px 12px;font-size:12px;background:var(--jp-success-color1, #1a7f37);color:var(--jp-ui-inverse-font-color1, #fff);border:1px solid var(--jp-success-color2, #1a7f37);';
                setTimeout(() => {
                    var _a, _b;
                    // Close dialog
                    const dlg = document.querySelector('.jp-Dialog');
                    if (dlg)
                        (_b = (_a = dlg).remove) === null || _b === void 0 ? void 0 : _b.call(_a);
                }, 500);
            }
            else {
                restoreBtn.textContent = 'Failed';
                restoreBtn.className = 'jp-mod-styled jp-mod-warn';
            }
        });
    });
    btnRow.appendChild(restoreBtn);
    container.appendChild(btnRow);
    const bodyWidget = new widgets_1.Widget();
    bodyWidget.node.appendChild(container);
    (0, apputils_1.showDialog)({
        title: 'Cell History',
        body: bodyWidget,
        buttons: [apputils_1.Dialog.okButton({ label: 'Close' })],
    });
}
// ===========================================================================
// Plugin
// ===========================================================================
exports.panelPlugin = {
    id: 'skillbot:tui',
    autoStart: true,
    requires: [notebook_1.INotebookTracker],
    activate: (_app, tracker) => {
        var _a, _b;
        const panel = new AgentPanel();
        panel.setTracker(tracker);
        panel.setApp(_app);
        _app.shell.add(panel, 'right', { rank: 100 });
        _panelInstance = panel;
        let _panelOpened = false;
        let _currentCtx = null;
        let _cellsChangedModel = null;
        const onKernelChanged = (_sender, args) => {
            if (args.oldValue) {
                panel.resetComm();
                panel._clear();
            }
            if (args.newValue)
                panel.connectKernel(args.newValue);
        };
        const register = () => {
            var _a;
            const nb = tracker.currentWidget;
            if (!nb)
                return;
            const ctx = nb.context.sessionContext;
            if (!ctx)
                return;
            // Swap the panel's conversation buffer to match the active notebook.
            // This is what makes each notebook its own session.
            const pathChanged = panel.setActivePath(nb.context.path || '');
            // wire kernel restart handler when context changes
            if (ctx !== _currentCtx) {
                if (_currentCtx)
                    _currentCtx.kernelChanged.disconnect(onKernelChanged);
                _currentCtx = ctx;
                ctx.kernelChanged.connect(onKernelChanged);
            }
            const kernel = (_a = ctx.session) === null || _a === void 0 ? void 0 : _a.kernel;
            if (kernel) {
                // register cell-execution target directly (not through connectKernel)
                try {
                    kernel.registerCommTarget('skillbot:execute-cell', (comm, msg) => {
                        panel._handleCellComm(comm, msg);
                    });
                }
                catch (e) {
                    console.error('[panel] registerCommTarget failed:', e);
                }
                panel.connectKernel(kernel);
                // Now that the target notebook's kernel is connected, tell the backend
                // to start a fresh agent conversation for it (only on a real switch).
                if (pathChanged)
                    panel.notifyNotebookSwitch(nb.context.path || '');
            }
            // Wire cell deletion tracking (disconnect old on notebook change)
            const model = nb.model;
            if (model && model.sharedModel !== _cellsChangedModel) {
                _cellsChangedModel = model.sharedModel;
                model.sharedModel.cellsChanged.connect((_sender, args) => {
                    var _a;
                    if (args.type === 'remove' && args.oldValues) {
                        for (const cell of args.oldValues) {
                            const src = cell.source || ((_a = cell.getSource) === null || _a === void 0 ? void 0 : _a.call(cell)) || '';
                            if (src.trim()) {
                                kernel === null || kernel === void 0 ? void 0 : kernel.requestExecute({
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
                var _a;
                const nb = tracker.currentWidget;
                if (!nb || !panel._kernel)
                    return;
                const cell = nb.content.activeCell;
                if (!cell)
                    return;
                const cellId = cell.model.id;
                const cellType = cell.model.type || 'code';
                if (cellType === 'markdown') {
                    alert('Cell optimization only works for code cells.');
                    return;
                }
                const code = cell.model.sharedModel.getSource();
                if (!code.trim()) {
                    alert('Cell is empty.');
                    return;
                }
                let selectionStart = 0, selectionEnd = 0, selectedText = '';
                try {
                    const editor = cell.editor;
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
                }
                catch (_) { }
                let output = '';
                let cellError = '';
                try {
                    const outputs = cell.model.outputs;
                    if ((outputs === null || outputs === void 0 ? void 0 : outputs.length) > 0) {
                        const last = outputs.get(outputs.length - 1);
                        if ((last === null || last === void 0 ? void 0 : last.output_type) === 'error') {
                            cellError = `${last.ename || 'Error'}: ${last.evalue || ''}`;
                        }
                        else {
                            output = ((_a = last === null || last === void 0 ? void 0 : last.data) === null || _a === void 0 ? void 0 : _a['text/plain']) || '';
                        }
                    }
                }
                catch (_) { }
                const input = document.createElement('textarea');
                input.placeholder = selectedText ? 'e.g. optimize this selected code, fix bug...' : 'e.g. optimize query, fix bug, improve readability...';
                input.style.cssText = 'width:100%;min-height:60px;background:#111;color:#ddd;border:1px solid #444;padding:8px;font-size:12px;resize:vertical;font-family:inherit;';
                const hint = document.createElement('div');
                hint.style.cssText = 'font-size:11px;color:rgb(140,140,140);margin-top:4px;';
                hint.textContent = 'Enter → Optimize    Shift+Enter → Optimize & Run';
                const body = new widgets_1.Widget();
                body.node.appendChild(input);
                body.node.appendChild(hint);
                let autoRun = false;
                const dialog = new apputils_1.Dialog({
                    title: selectedText ? 'Optimize Selected Code' : 'Cell Optimization',
                    body,
                    buttons: [
                        apputils_1.Dialog.cancelButton(),
                        apputils_1.Dialog.okButton({ label: 'Optimize & Run' }),
                        apputils_1.Dialog.okButton({ label: 'Optimize' }),
                    ],
                });
                dialog.node.addEventListener('keydown', (e) => {
                    var _a;
                    if (e.key !== 'Enter' || e.isComposing)
                        return;
                    if (((_a = document.activeElement) === null || _a === void 0 ? void 0 : _a.tagName) === 'TEXTAREA') {
                        e.preventDefault();
                        e.stopPropagation();
                        autoRun = e.shiftKey;
                        const btns = dialog.node.querySelectorAll('.jp-Dialog-button');
                        const btn = e.shiftKey
                            ? btns[btns.length - 2]
                            : btns[btns.length - 1];
                        btn === null || btn === void 0 ? void 0 : btn.click();
                    }
                }, true);
                setTimeout(() => input.focus(), 10);
                const dlgResult = await dialog.launch();
                const clicked = dlgResult.button.label;
                if (clicked === 'Cancel')
                    return;
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
                if (!nb)
                    return;
                const cell = nb.content.activeCell;
                if (!cell)
                    return;
                const cellId = cell.model.id;
                if (!panel._kernel)
                    return;
                const nbPath = nb.context.path || nb.context.localPath || '';
                const future = panel._kernel.requestExecute({
                    code: `from jupyter.cell_snapshot import list_versions; import json; d={"versions":list_versions(${JSON.stringify(cellId)}, nb_path=${JSON.stringify(nbPath)}),"cell_id":${JSON.stringify(cellId)}}; print(json.dumps(d))`,
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
                        const text = stdout.trim();
                        const data = JSON.parse(text);
                        const versions = data.versions || [];
                        if (!versions.length) {
                            alert('No cell snapshots yet. Execute cells first.');
                            return;
                        }
                        _showCellSnapshotsDialog(cell, versions, panel);
                    }
                    catch (e) {
                        console.error(e);
                        alert('Failed to load cell snapshots.');
                    }
                });
            },
        });
        _app.commands.addCommand('skillbot:notebook-snapshots', {
            label: 'Notebook Snapshots',
            execute: async () => {
                const nb = tracker.currentWidget;
                if (!nb)
                    return;
                if (!panel._kernel)
                    return;
                const nbPath = nb.context.path || nb.context.localPath || '';
                const future = panel._kernel.requestExecute({
                    code: `from jupyter.notebook_snapshot import list_snapshots_for; from jupyter.magic import _get_magic; import json; inst=_get_magic(); d={"snapshots":list_snapshots_for(${JSON.stringify(nbPath)}),"cell_restored":inst._cell_restored if inst else False}; print(json.dumps(d))`,
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
                        const text = stdout.trim();
                        const data = JSON.parse(text);
                        const snapshots = data.snapshots || [];
                        if (!snapshots.length) {
                            alert('No notebook snapshots yet. Execute cells first.');
                            return;
                        }
                        _showSnapshotDialog(snapshots, panel, nb, data.cell_restored || false, nbPath);
                    }
                    catch (e) {
                        console.error(e);
                        alert('Failed to load snapshots.');
                    }
                });
            },
        });
        // Submenu on both .jp-Cell and .jp-Notebook
        const historyMenu = new widgets_2.Menu({ commands: _app.commands });
        historyMenu.title.label = 'Agent';
        historyMenu.addItem({ command: 'skillbot:cell-optimize' });
        historyMenu.addItem({ type: 'separator' });
        historyMenu.addItem({ command: 'skillbot:cell-history' });
        historyMenu.addItem({ command: 'skillbot:notebook-snapshots' });
        _app.contextMenu.addItem({
            selector: '.jp-Notebook',
            type: 'submenu',
            submenu: historyMenu,
            rank: 50,
        });
        tracker.currentChanged.connect(() => register());
        setTimeout(register, 500);
        // When a notebook file is deleted from the file browser, purge its
        // conversation record so stale sessions don't linger in the switcher.
        try {
            const contents = (_a = _app.serviceManager) === null || _a === void 0 ? void 0 : _a.contents;
            (_b = contents === null || contents === void 0 ? void 0 : contents.fileChanged) === null || _b === void 0 ? void 0 : _b.connect((_sender, change) => {
                var _a;
                if ((change === null || change === void 0 ? void 0 : change.type) === 'delete') {
                    const p = ((_a = change.oldValue) === null || _a === void 0 ? void 0 : _a.path) || '';
                    if (p && /\.ipynb$/.test(p))
                        panel.onNotebookFileDeleted(p);
                }
            });
        }
        catch (e) {
            console.error('[panel] fileChanged wiring failed:', e);
        }
    },
};
