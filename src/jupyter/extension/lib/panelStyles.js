"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.STYLES = exports.CC = void 0;
// ---------------------------------------------------------------------------
// Claude Code colour palette
// ---------------------------------------------------------------------------
exports.CC = {
    bg: '#171717',
    surface: '#2c2c2c',
    text: '#ececec',
    inactive: 'rgb(175,175,175)',
    subtle: 'rgb(130,130,130)',
    border: '#333',
    accent: 'rgb(0,180,180)', // bright teal for section dividers
    brand: 'rgb(215,119,87)',
    success: 'rgb(78,186,101)',
    error: 'rgb(255,107,128)',
    userBg: 'rgb(55,55,55)',
    pointer: 'rgb(175,175,175)', // matches cc-haha 'subtle' for pointer
};
// All CSS lives inside shadowRoot — completely isolated from JupyterLab
exports.STYLES = `
:host {
  /* Body copy is sans (readable prose, mainstream-AI feel); code/terminal
     output stays mono for that Claude Code terminal identity. */
  --sb-sans: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC',
             'Hiragino Sans GB', 'Microsoft YaHei', Roboto, Helvetica, Arial, sans-serif;
  --sb-mono: 'SF Mono', 'Fira Code', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas, monospace;
  display: flex;
  flex-direction: column;
  min-width: 650px;
  height: 100%;
  background: ${exports.CC.bg};
  color: ${exports.CC.text};
  font-family: var(--sb-sans);
  font-size: 13.5px;
  line-height: 1.6;
  -webkit-font-smoothing: antialiased;
  text-rendering: optimizeLegibility;
}

/* ---- welcome banner ---- */
.skillbot-welcome {
  padding: 10px 16px;
  border-bottom: 2px solid ${exports.CC.accent};
}

/* ---- session switcher (vertical list) ---- */
.skillbot-session-bar {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid ${exports.CC.border};
  background: ${exports.CC.bg};
  max-height: 240px;
}
.skillbot-session-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px 6px 12px;
}
.skillbot-session-titlewrap {
  display: flex;
  align-items: center;
  gap: 5px;
  cursor: pointer;
  min-width: 0;
}
.skillbot-session-chevron {
  font-size: 10px;
  color: ${exports.CC.subtle};
  transition: color 0.12s;
}
.skillbot-session-titlewrap:hover .skillbot-session-chevron,
.skillbot-session-titlewrap:hover .skillbot-session-title {
  color: ${exports.CC.text};
}
.skillbot-session-bar.collapsed {
  max-height: none;
}
.skillbot-session-bar.collapsed .skillbot-session-header {
  padding-bottom: 8px;
}
.skillbot-session-title {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: ${exports.CC.subtle};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skillbot-session-actions {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}
.skillbot-session-btn {
  padding: 3px 10px;
  border-radius: 6px;
  background: ${exports.CC.surface};
  color: ${exports.CC.inactive};
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
  border: 1px solid transparent;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.skillbot-session-btn:hover {
  color: ${exports.CC.text};
  background: #3a3a3a;
}
.skillbot-session-btn-primary {
  color: ${exports.CC.brand};
  border-color: rgba(215,119,87,0.35);
}
.skillbot-session-btn-primary:hover {
  color: #fff;
  background: ${exports.CC.brand};
  border-color: ${exports.CC.brand};
}
.skillbot-session-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 2px 8px 8px 8px;
  overflow-y: auto;
}
.skillbot-session-list::-webkit-scrollbar { width: 5px; }
.skillbot-session-list::-webkit-scrollbar-thumb { background: ${exports.CC.subtle}; border-radius: 3px; }
.skillbot-session-empty {
  padding: 10px 8px;
  font-size: 12px;
  color: ${exports.CC.subtle};
  text-align: center;
}
.skillbot-session-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: 6px;
  cursor: pointer;
  border-left: 2px solid transparent;
  transition: background 0.12s;
}
.skillbot-session-row:hover {
  background: ${exports.CC.surface};
}
.skillbot-session-row.active {
  background: ${exports.CC.userBg};
  border-left-color: ${exports.CC.accent};
}
.skillbot-session-dot {
  flex-shrink: 0;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: ${exports.CC.subtle};
}
.skillbot-session-row.active .skillbot-session-dot {
  background: ${exports.CC.accent};
  box-shadow: 0 0 4px ${exports.CC.accent};
}
.skillbot-session-name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  color: ${exports.CC.inactive};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skillbot-session-row.active .skillbot-session-name {
  color: ${exports.CC.text};
  font-weight: 500;
}
.skillbot-session-edit {
  flex-shrink: 0;
  font-size: 12px;
  color: transparent;
  cursor: pointer;
  padding: 0 2px;
  transition: color 0.12s;
}
.skillbot-session-row:hover .skillbot-session-edit {
  color: ${exports.CC.subtle};
}
.skillbot-session-edit:hover {
  color: ${exports.CC.accent};
}
.skillbot-session-del {
  flex-shrink: 0;
  font-size: 12px;
  color: transparent;
  cursor: pointer;
  padding: 0 2px;
  transition: color 0.12s;
}
.skillbot-session-row:hover .skillbot-session-del {
  color: ${exports.CC.subtle};
}
.skillbot-session-del:hover {
  color: ${exports.CC.error};
}

/* ---- agent action bar ---- */
.skillbot-action-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 6px 12px;
  background: ${exports.CC.bg};
  border-top: 1px solid ${exports.CC.border};
}
.skillbot-action-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  border-radius: 999px;
  background: ${exports.CC.surface};
  color: ${exports.CC.inactive};
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  user-select: none;
  border: 1px solid ${exports.CC.border};
  transition: background 0.12s, color 0.12s, border-color 0.12s, transform 0.08s;
}
.skillbot-action-btn:hover {
  color: ${exports.CC.text};
  background: #3a3a3a;
  border-color: #454545;
}
.skillbot-action-btn:active {
  transform: translateY(1px);
}
.skillbot-action-stop {
  color: ${exports.CC.error};
  border-color: rgba(255,107,128,0.4);
}
.skillbot-action-stop:hover {
  color: #fff;
  background: ${exports.CC.error};
  border-color: ${exports.CC.error};
}
.skillbot-action-skills.active {
  color: ${exports.CC.text};
  background: rgba(0,180,180,0.15);
  border-color: ${exports.CC.accent};
}
.skillbot-action-skills.active:hover {
  background: rgba(0,180,180,0.25);
}
.skillbot-action-plan.active {
  color: ${exports.CC.text};
  background: rgba(0,102,102,0.25);
  border-color: rgb(0,102,102);
}
.skillbot-action-plan.active:hover {
  background: rgba(0,102,102,0.4);
}
.skillbot-action-btn.disabled {
  opacity: 0.4;
  cursor: default;
  pointer-events: none;
}

.skillbot-output {
  flex: 1;
  overflow-y: auto;
  padding: 8px 16px 8px 4px;
  scroll-behavior: smooth;
  color: ${exports.CC.text};
}
.skillbot-output::-webkit-scrollbar { width: 6px; }
.skillbot-output::-webkit-scrollbar-thumb { background: ${exports.CC.subtle}; border-radius: 3px; }
.skillbot-output::-webkit-scrollbar-track { background: transparent; }

/* ---- message block (one prompt+response pair) ---- */
.skillbot-msg-block {
  margin-top: 14px;
  padding-bottom: 14px;
  border-bottom: 1px solid rgba(255,255,255,0.04);
  color: ${exports.CC.text};
}
.skillbot-msg-block:last-child { border-bottom: none; }

/* ---- user prompt ---- */
.skillbot-prompt-line {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: ${exports.CC.userBg};
  padding: 9px 12px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.05);
}
.skillbot-prompt-prefix {
  color: ${exports.CC.accent};
  font-family: var(--sb-mono);
  font-weight: 700;
  user-select: none;
  flex-shrink: 0;
  line-height: 1.6;
}
.skillbot-prompt-text {
  color: ${exports.CC.text};
  white-space: pre-wrap;
  word-break: break-word;
}

/* ---- agent response ---- */
.skillbot-response-prefix {
  color: ${exports.CC.inactive};
  user-select: none;
  flex-shrink: 0;
  margin-top: 6px;
}
.skillbot-response-text {
  color: ${exports.CC.text};
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.65;
  padding: 2px 2px 2px 10px;
}

/* ---- rendered markdown inside agent responses ---- */
.skillbot-markdown {
  white-space: normal;   /* let block elements own their spacing */
}
.skillbot-markdown p { margin: 6px 0; }
.skillbot-markdown p:first-child { margin-top: 0; }
.skillbot-markdown p:last-child { margin-bottom: 0; }
.skillbot-markdown strong { color: #fff; font-weight: 650; }
.skillbot-markdown em { color: ${exports.CC.text}; }
.skillbot-markdown h1,
.skillbot-markdown h2,
.skillbot-markdown h3,
.skillbot-markdown h4 {
  margin: 12px 0 6px;
  font-weight: 650;
  line-height: 1.35;
  color: #fff;
}
.skillbot-markdown h1 { font-size: 17px; }
.skillbot-markdown h2 { font-size: 15.5px; }
.skillbot-markdown h3 { font-size: 14px; }
.skillbot-markdown h4 { font-size: 13.5px; color: ${exports.CC.accent}; }
.skillbot-markdown ul,
.skillbot-markdown ol {
  margin: 6px 0;
  padding-left: 22px;
}
.skillbot-markdown li { margin: 3px 0; }
.skillbot-markdown li::marker { color: ${exports.CC.accent}; }
.skillbot-markdown code {
  font-family: var(--sb-mono);
  font-size: 12px;
  background: rgba(255,255,255,0.08);
  padding: 1px 5px;
  border-radius: 4px;
  color: #f0d9a8;
}
.skillbot-markdown pre {
  background: #1e1e1e;
  border: 1px solid ${exports.CC.border};
  border-radius: 8px;
  padding: 12px 14px;
  overflow-x: auto;
  margin: 8px 0;
}
.skillbot-markdown pre code {
  background: none;
  padding: 0;
  color: ${exports.CC.text};
  font-size: 12px;
}
.skillbot-markdown a {
  color: ${exports.CC.accent};
  text-decoration: none;
}
.skillbot-markdown a:hover { text-decoration: underline; }
.skillbot-markdown blockquote {
  margin: 6px 0;
  padding: 2px 12px;
  border-left: 3px solid ${exports.CC.border};
  color: ${exports.CC.inactive};
}
.skillbot-markdown table {
  border-collapse: collapse;
  margin: 8px 0;
  font-size: 12.5px;
}
.skillbot-markdown th,
.skillbot-markdown td {
  border: 1px solid ${exports.CC.border};
  padding: 5px 9px;
  text-align: left;
}
.skillbot-markdown th { background: rgba(255,255,255,0.04); font-weight: 650; }
.skillbot-markdown hr {
  border: none;
  border-top: 1px solid ${exports.CC.border};
  margin: 12px 0;
}
.skillbot-markdown > *:first-child { margin-top: 0; }
.skillbot-markdown > *:last-child { margin-bottom: 0; }

.skillbot-tool-line {
  color: ${exports.CC.brand};
  font-family: var(--sb-mono);
  font-size: 12px;
  padding-left: 10px;
  margin: 3px 0;
}

/* Collapsible tool output */
.skillbot-response-text details {
  margin-left: 16px;
  padding: 0;
}
.skillbot-response-text details summary {
  color: rgb(150,150,150);
  font-size: 12px;
  cursor: pointer;
  padding: 2px 0;
}
.skillbot-response-text details summary:hover {
  color: rgb(200,200,200);
}

.skillbot-thinking-line {
  color: rgb(180,180,180);
  font-style: italic;
  padding-left: 8px;
  margin: 2px 0;
}

.skillbot-code-block {
  background: #1e1e1e;
  border: 1px solid ${exports.CC.border};
  border-radius: 8px;
  margin: 8px 0 8px 10px;
  padding: 12px 14px;
  overflow-x: auto;
  box-shadow: 0 1px 2px rgba(0,0,0,0.25);
}
.skillbot-code-block pre {
  margin: 0;
  font-family: var(--sb-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: ${exports.CC.text};
}
.skillbot-code-block code {
  color: ${exports.CC.text};
  font-family: var(--sb-mono);
}
.skillbot-code-block::-webkit-scrollbar { height: 4px; }
.skillbot-code-block::-webkit-scrollbar-thumb { background: ${exports.CC.subtle}; border-radius: 2px; }

.skillbot-result-line {
  margin-top: 4px;
  padding-left: 8px;
  color: ${exports.CC.text};
}

/* ---- spinner (cc-haha style) ---- */
@keyframes skillbot-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}
.skillbot-spinner {
  color: ${exports.CC.brand};
  animation: skillbot-pulse 1s ease-in-out infinite;
  user-select: none;
}
.skillbot-spinner-label {
  color: rgb(180,180,180);
  margin-left: 4px;
}

/* ---- info bar (mode switch messages) ---- */
.skillbot-info {
  font-size: 12px;
  font-weight: 500;
  color: rgb(190,190,190);
  padding: 5px 16px;
  border-top: 2px solid ${exports.CC.accent};
  min-height: 20px;
  transition: opacity 0.3s;
}

.skillbot-status {
  font-size: 12px;
  font-weight: 500;
  color: rgb(180,180,180);
  padding: 5px 16px;
  border-top: 2px solid ${exports.CC.accent};
  user-select: none;
  display: flex;
  justify-content: space-between;
}

.skillbot-input-wrapper {
  display: flex;
  align-items: center;
  margin: 8px 12px 12px 12px;
  background: ${exports.CC.surface};
  border: 1px solid ${exports.CC.border};
  border-radius: 12px;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.skillbot-input-wrapper:focus-within {
  border-color: ${exports.CC.accent};
  box-shadow: 0 0 0 3px rgba(0,180,180,0.12);
}
.skillbot-input-marker {
  color: ${exports.CC.accent};
  font-family: var(--sb-mono);
  font-weight: 700;
  padding-left: 14px;
  user-select: none;
  flex-shrink: 0;
}
.skillbot-input {
  flex: 1;
  background: transparent;
  color: ${exports.CC.text};
  border: none;
  padding: 11px 14px 11px 8px;
  font-family: var(--sb-sans);
  font-size: 13.5px;
  line-height: 1.55;
  outline: none;
  resize: none;
  overflow-y: auto;
  max-height: 200px;
  box-sizing: border-box;
}
.skillbot-input::placeholder {
  color: rgb(150,150,150);
  font-weight: 400;
}
.skillbot-input::-webkit-scrollbar { width: 4px; }
.skillbot-input::-webkit-scrollbar-thumb { background: ${exports.CC.subtle}; border-radius: 2px; }

/* ---- plan confirmation (replaces input area) ---- */
.skillbot-confirm-wrapper {
  border-top: 2px solid ${exports.CC.accent};
  padding: 10px 16px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.skillbot-confirm-label {
  color: rgb(200,200,200);
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 4px;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 180px;
  overflow-y: auto;
}
.skillbot-confirm-option {
  padding: 8px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  color: rgb(180,180,180);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.skillbot-confirm-option:hover {
  background: rgba(255,255,255,0.04);
  color: ${exports.CC.text};
}
.skillbot-confirm-option-active {
  background: ${exports.CC.surface};
  color: ${exports.CC.text};
  font-weight: 600;
  border-color: ${exports.CC.accent};
}
.skillbot-confirm-option-active::before {
  content: '❯ ';
  color: ${exports.CC.brand};
  font-family: var(--sb-mono);
}
.skillbot-confirm-hint {
  color: rgb(150,150,150);
  font-size: 12px;
  margin-top: 4px;
}

/* ---- plan block in output area ---- */
.skillbot-plan-block {
  background: #0a2a2a;
  border: 1px solid rgba(0,180,180,0.25);
  border-left: 3px solid ${exports.CC.accent};
  padding: 10px 14px;
  margin: 8px 0 8px 10px;
  border-radius: 8px;
  white-space: pre-wrap;
  line-height: 1.65;
  color: rgb(205,205,205);
}
.skillbot-plan-header {
  font-weight: 600;
  color: ${exports.CC.accent};
  font-size: 11px;
  margin-bottom: 6px;
}

/* ---- plan preview in confirm dialog ---- */
.skillbot-plan-preview {
  background: #0a2a2a;
  border: 1px solid rgba(0,180,180,0.25);
  border-left: 3px solid ${exports.CC.accent};
  padding: 10px 14px;
  margin-bottom: 10px;
  max-height: 200px;
  overflow-y: auto;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  border-radius: 8px;
  color: rgb(205,205,205);
}
.skillbot-plan-preview::-webkit-scrollbar { width: 4px; }
.skillbot-plan-preview::-webkit-scrollbar-thumb { background: ${exports.CC.subtle}; border-radius: 2px; }

/* ---- feedback textarea in confirm ---- */
.skillbot-confirm-feedback,
.skillbot-gate-feedback {
  background: ${exports.CC.bg};
  color: ${exports.CC.text};
  border: 1px solid ${exports.CC.border};
  padding: 8px 10px;
  font-family: var(--sb-sans);
  font-size: 13px;
  line-height: 1.55;
  resize: vertical;
  min-height: 60px;
  outline: none;
  border-radius: 8px;
  box-sizing: border-box;
  transition: border-color 0.15s, box-shadow 0.15s;
}
.skillbot-confirm-feedback:focus,
.skillbot-gate-feedback:focus {
  border-color: ${exports.CC.accent};
  box-shadow: 0 0 0 3px rgba(0,180,180,0.12);
}
.skillbot-confirm-feedback::placeholder,
.skillbot-gate-feedback::placeholder {
  color: rgb(130,130,130);
  font-weight: 400;
}

/* ---- decision gate ---- */
.skillbot-gate-badge {
  display: inline-block;
  align-self: flex-start;
  background: ${exports.CC.surface};
  color: ${exports.CC.brand};
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  padding: 2px 8px;
  border-radius: 3px;
  margin-bottom: 2px;
}
.skillbot-gate-option {
  padding: 10px 12px;
  border-radius: 8px;
  border: 1px solid ${exports.CC.border};
  background: rgba(255,255,255,0.02);
  color: rgb(180,180,180);
  cursor: pointer;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.skillbot-gate-option:hover {
  background: rgba(255,255,255,0.05);
  border-color: #454545;
  color: ${exports.CC.text};
}
.skillbot-gate-option-active {
  background: ${exports.CC.surface};
  border-color: ${exports.CC.accent};
  color: ${exports.CC.text};
  box-shadow: 0 0 0 2px rgba(0,180,180,0.12);
}
.skillbot-gate-option-active .skillbot-gate-option-label::before {
  content: '❯ ';
  color: ${exports.CC.brand};
  font-family: var(--sb-mono);
}
.skillbot-gate-option-label {
  font-weight: 600;
  font-size: 13px;
}
.skillbot-gate-rec {
  font-size: 10px;
  font-weight: 600;
  color: ${exports.CC.brand};
  text-transform: uppercase;
  letter-spacing: 0.5px;
  margin-left: 6px;
}
.skillbot-gate-evidence {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 400;
  line-height: 1.5;
  color: rgb(160,160,160);
  white-space: pre-wrap;
}

/* ---- skills view (upload / search / categories / toggle) ---- */
.skillbot-skill-list {
  margin: 8px 4px 4px 4px;
  padding: 8px;
  background: ${exports.CC.surface};
  border: 1px solid ${exports.CC.border};
  border-radius: 8px;
  outline: none;
}
.skillbot-skill-upload,
.skillbot-skill-restart {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 6px;
  background: ${exports.CC.bg};
  color: ${exports.CC.inactive};
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid ${exports.CC.border};
  transition: background 0.12s, color 0.12s, border-color 0.12s;
}
.skillbot-skill-upload:hover {
  color: ${exports.CC.text};
  background: rgba(0,180,180,0.15);
  border-color: ${exports.CC.accent};
}
.skillbot-skill-restart:hover {
  color: ${exports.CC.text};
  background: #3a3a3a;
}
/* Restart button pulses when a toggle is waiting to take effect. */
.skillbot-skill-restart.pending {
  color: ${exports.CC.brand};
  border-color: ${exports.CC.brand};
  background: rgba(215,119,87,0.12);
  animation: skillbot-restart-pulse 1.6s ease-in-out infinite;
}
@keyframes skillbot-restart-pulse {
  0%, 100% { opacity: 1; }
  50%      { opacity: 0.55; }
}
.skillbot-skill-search {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 6px;
  padding: 5px 8px;
  background: ${exports.CC.bg};
  color: ${exports.CC.text};
  border: 1px solid ${exports.CC.border};
  border-radius: 6px;
  font-size: 12px;
  font-family: inherit;
  outline: none;
}
.skillbot-skill-search:focus {
  border-color: ${exports.CC.accent};
}
.skillbot-skill-search::placeholder {
  color: ${exports.CC.subtle};
}
.skillbot-skill-notice {
  font-size: 11px;
  line-height: 1.4;
  margin: 0 4px 6px 4px;
  min-height: 0;
  white-space: pre-wrap;
}
.skillbot-skill-items {
  max-height: 420px;
  overflow-y: auto;
}
.skillbot-skill-items::-webkit-scrollbar { width: 6px; }
.skillbot-skill-items::-webkit-scrollbar-thumb { background: ${exports.CC.subtle}; border-radius: 3px; }
.skillbot-skill-cat {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 4px;
  margin-top: 4px;
  border-bottom: 1px solid ${exports.CC.border};
  user-select: none;
}
.skillbot-skill-cat:hover {
  background: rgba(255,255,255,0.03);
}
.skillbot-skill-row {
  padding: 5px 6px;
  border-radius: 6px;
  transition: background 0.1s;
}
.skillbot-skill-row:hover {
  background: rgba(255,255,255,0.05);
}
/* iOS-style toggle switch */
.skillbot-toggle {
  position: relative;
  display: inline-block;
  flex: 0 0 auto;
  width: 30px;
  height: 16px;
  border-radius: 8px;
  background: #555;
  cursor: pointer;
  transition: background 0.15s;
}
.skillbot-toggle.on {
  background: ${exports.CC.accent};
}
.skillbot-toggle-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: #fff;
  transition: left 0.15s;
}
.skillbot-toggle.on .skillbot-toggle-knob {
  left: 16px;
}

/* ---- steps timeline view ---- */
.skillbot-step-list {
  padding: 4px 2px 8px;
}
.skillbot-step-head {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
  padding: 0 4px;
}
.skillbot-step-title {
  font-size: 13px;
  font-weight: 600;
  color: ${exports.CC.text};
}
.skillbot-step-empty {
  font-size: 12px;
  line-height: 1.6;
  color: ${exports.CC.subtle};
  padding: 12px 8px;
}
.skillbot-step-notice {
  font-size: 12px;
  color: ${exports.CC.accent};
  padding: 6px 8px;
  margin: 0 4px 6px;
  background: rgba(0,180,180,0.08);
  border-radius: 4px;
}
.skillbot-step-notice.error {
  color: ${exports.CC.error};
  background: rgba(255,107,128,0.08);
}
.skillbot-step-items {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
/* vertical timeline: left rail via border on each card */
.skillbot-step-card {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 10px 10px 14px;
  background: ${exports.CC.surface};
  border-left: 3px solid ${exports.CC.border};
  border-radius: 6px;
}
.skillbot-step-card.running { border-left-color: ${exports.CC.accent}; }
.skillbot-step-card.done    { border-left-color: ${exports.CC.success}; }
.skillbot-step-card.failed  { border-left-color: ${exports.CC.error}; }
.skillbot-step-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.skillbot-step-badge {
  flex: 0 0 auto;
  width: 18px;
  text-align: center;
  font-size: 13px;
}
.skillbot-step-badge.pending { color: ${exports.CC.subtle}; }
.skillbot-step-badge.running { color: ${exports.CC.accent}; animation: skillbot-step-pulse 1.2s ease-in-out infinite; }
.skillbot-step-badge.done    { color: ${exports.CC.success}; }
.skillbot-step-badge.failed  { color: ${exports.CC.error}; }
@keyframes skillbot-step-pulse {
  0%, 100% { opacity: 0.4; }
  50%      { opacity: 1; }
}
.skillbot-step-label {
  flex: 1 1 auto;
  font-size: 12.5px;
  color: ${exports.CC.text};
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.skillbot-step-acts {
  display: flex;
  gap: 6px;
}
.skillbot-step-btn {
  flex: 1 1 0;
  font-size: 11.5px;
  color: ${exports.CC.inactive};
  background: transparent;
  border: 1px solid ${exports.CC.border};
  border-radius: 4px;
  padding: 4px 6px;
  cursor: pointer;
  transition: color 0.12s, border-color 0.12s, background 0.12s;
}
.skillbot-step-btn:hover {
  color: ${exports.CC.accent};
  border-color: ${exports.CC.accent};
  background: rgba(0,180,180,0.08);
}
.skillbot-step-btn.disabled {
  opacity: 0.35;
  cursor: default;
}
.skillbot-step-btn.disabled:hover {
  color: ${exports.CC.inactive};
  border-color: ${exports.CC.border};
  background: transparent;
}
`;
