// Output rendering helpers for AgentPanel
// All functions take the panel instance (as any to avoid circular imports)
import { marked } from 'marked';

// Render agent prose as markdown. GitHub-flavoured line breaks, no raw HTML
// passthrough (agent text is escaped by marked, so injected tags are inert).
marked.setOptions({ gfm: true, breaks: true });

// Turn a full raw-text buffer into sanitised HTML. Markdown first (marked
// escapes any literal < > & in the process), then a light ANSI colour pass so
// tool/stream colour codes still render. Any parser hiccup degrades to the
// escaped raw text rather than throwing mid-stream.
function renderMarkdown(panel: any, raw: string): string {
  try {
    const html = marked.parse(raw, { async: false }) as string;
    return ansiSpans(html);
  } catch {
    return panel._esc(raw);
  }
}

// Same ANSI→span mapping panel._ansiToHtml uses, applied post-markdown.
function ansiSpans(s: string): string {
  return s.replace(/\x1b\[32m/g, '<span style="color:#4ade80">')
          .replace(/\x1b\[31m/g, '<span style="color:#f87171">')
          .replace(/\x1b\[90m/g, '<span style="color:#999">')
          .replace(/\x1b\[0m/g, '</span>')
          .replace(/\x1b\[[0-9;]*m/g, '');
}

export function ensureResponsePrefix(panel: any): void {
  if (!panel._responseStarted) {
    panel._responseStarted = true;
    const prefix = document.createElement('div');
    prefix.className = 'skillbot-response-prefix';
    prefix.innerHTML = '  <span style="color:#888">⎿</span> ';
    panel._appendToBlock(prefix);
  }
}

export function renderPrompt(panel: any, text: string): void {
  const div = document.createElement('div');
  div.className = 'skillbot-prompt-line';
  div.innerHTML = `<span class="skillbot-prompt-prefix">❯</span><span class="skillbot-prompt-text">${panel._esc(text)}</span>`;
  panel._appendToBlock(div);
}

export function renderResponseText(panel: any, content: string): void {
  ensureResponsePrefix(panel);
  panel._textEl = null; panel._thinkingEl = null;
  appendTextChunk(panel, content);
}

// Streaming markdown: the agent's prose arrives chunk-by-chunk, but markdown
// (** **, lists, ``` fences) only parses correctly against the WHOLE text — a
// half-arrived `**bold` would render as literal asterisks. So we accumulate the
// raw text on the element and re-render the full buffer each chunk. `content`
// here is RAW text (callers no longer pre-convert to HTML).
export function appendTextChunk(panel: any, content: string): void {
  if (!panel._textEl || !panel._textEl.parentElement) {
    panel._textEl = document.createElement('div');
    panel._textEl.className = 'skillbot-response-text skillbot-markdown';
    panel._textEl._raw = content;
    panel._textEl.innerHTML = renderMarkdown(panel, content);
    panel._appendToBlock(panel._textEl);
  } else {
    panel._textEl._raw = (panel._textEl._raw || '') + content;
    panel._textEl.innerHTML = renderMarkdown(panel, panel._textEl._raw);
  }
}

export function renderTool(panel: any, name: string): void {
  ensureResponsePrefix(panel);
  panel._textEl = null; panel._thinkingEl = null; panel._thinkingEl = null;
  const div = document.createElement('div');
  div.className = 'skillbot-tool-line';
  div.textContent = `⬢ ${name}`;
  panel._appendToBlock(div);
}

export function renderThinking(panel: any, content: string): void {
  ensureResponsePrefix(panel);
  // Accumulate thinking into a single element (each token arrives separately)
  if (!panel._thinkingEl || !panel._thinkingEl.parentElement) {
    panel._textEl = null; panel._thinkingEl = null;
    panel._thinkingEl = document.createElement('div');
    panel._thinkingEl.className = 'skillbot-thinking-line';
    panel._thinkingEl.textContent = `∴ ${content}`;
    panel._appendToBlock(panel._thinkingEl);
  } else {
    // If currently collapsed, restore full text before appending new chunk
    if (panel._thinkingCollapsed && panel._thinkingEl.hasAttribute('data-full')) {
      panel._thinkingEl.textContent = panel._thinkingEl.getAttribute('data-full') || '';
      panel._thinkingEl.removeAttribute('data-full');
    }
    // Add space between chunks (thinking tokens arrive without whitespace)
    const prev = panel._thinkingEl.textContent;
    const needSpace = prev.length > 0 && !prev.endsWith(' ') && !content.startsWith(' ') && !prev.endsWith('\n');
    panel._thinkingEl.textContent += (needSpace ? ' ' : '') + content;
  }
  // Apply collapse if active (Ctrl+T default: collapsed 150 chars)
  if (panel._thinkingCollapsed !== undefined) {
    panel._applyThinkingCollapse();
  }
}

export function renderCodeBlock(panel: any, _language: string, code: string): void {
  ensureResponsePrefix(panel);
  panel._textEl = null; panel._thinkingEl = null;
  const wrapper = document.createElement('div');
  wrapper.className = 'skillbot-code-block';
  wrapper.innerHTML = `<pre><code>${panel._esc(code)}</code></pre>`;
  panel._appendToBlock(wrapper);
}

export function renderPlanBlock(panel: any, text: string): void {
  ensureResponsePrefix(panel);
  panel._textEl = null; panel._thinkingEl = null;
  const wrapper = document.createElement('div');
  wrapper.className = 'skillbot-plan-block';
  wrapper.innerHTML = `<div class="skillbot-plan-header">⏸ Plan</div>${panel._esc(text)}`;
  panel._appendToBlock(wrapper);
}

export function renderResult(panel: any, summary: string): void {
  ensureResponsePrefix(panel);
  panel._textEl = null; panel._thinkingEl = null;
  const div = document.createElement('div');
  div.className = 'skillbot-result-line';
  div.innerHTML = `<span style="color:rgb(78,186,101)">✓</span> ${panel._esc(summary)}`;
  panel._appendToBlock(div);
  panel._stopSpinner();
  panel._setStatus('✓', 'done');
  panel._streaming = false;
  panel._saveState();
}
