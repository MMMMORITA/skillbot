// Skills-view UI helpers for AgentPanel.
// Renders the installed-skills catalog with live search, per-category grouping,
// enable/disable toggles, upload / uninstall, and a detail drill-down. Extracted
// from panel.ts; every function takes the panel instance as its first argument
// and accesses its state directly. All instance fields remain declared on the
// AgentPanel class.

import { CC } from './panelStyles';

export function enterSkillsMode(panel: any): void {
  panel._skillsMode = true;
  panel._inputWrapper.style.display = 'none';
  panel._outputEl.querySelectorAll('.skillbot-skill-list').forEach((el: Element) => el.remove());
  panel._renderActionBar();
}

export function exitSkillsMode(panel: any): void {
  panel._skillsMode = false;
  panel._inputWrapper.style.display = '';
  panel._skillRows = [];
  panel._skillSelectedIdx = 0;
  panel._expandedIdx = -1;
  panel._outputEl.querySelectorAll('.skillbot-skill-list').forEach((el: Element) => el.remove());
  panel._renderActionBar();
  panel._inputEl.focus();
  // Reset textarea height (lost during display:none)
  setTimeout(() => panel._resizeInput(), 0);
}

export function renderSkillList(panel: any, skills: Array<{name: string, description: string, enabled: boolean, body?: string, category?: string}>): void {
  panel._skillData = skills.map(s => ({...s, body: s.body || '', category: s.category || ''}));
  panel._skillRows = [];
  panel._skillSelectedIdx = 0;
  panel._expandedIdx = -1;
  panel._fullBodyIdx = -1;

  // Remove old list, rebuild
  panel._outputEl.querySelectorAll('.skillbot-skill-list').forEach((el: Element) => el.remove());

  const wrapper = document.createElement('div');
  wrapper.className = 'skillbot-skill-list';
  wrapper.tabIndex = 0;
  wrapper.style.outline = 'none';

  // Header: title + action buttons (upload / restart)
  const head = document.createElement('div');
  head.style.cssText = `display:flex;align-items:center;gap:6px;margin-bottom:6px;padding:0 4px;`;
  const title = document.createElement('div');
  title.style.cssText = `font-size:13px;font-weight:600;color:${CC.text};margin-right:auto;`;
  title.textContent = `Skills · ${panel._skillData.length}`;
  head.appendChild(title);

  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'skillbot-skill-upload';
  uploadBtn.textContent = '➕ 上传';
  uploadBtn.title = '上传技能 (.zip)';
  uploadBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); promptUploadSkill(panel); });
  head.appendChild(uploadBtn);

  const restartBtn = document.createElement('button');
  restartBtn.className = 'skillbot-skill-restart';
  restartBtn.textContent = '⟳ 重启生效';
  restartBtn.title = '重启 agent 会话，让技能开关生效';
  restartBtn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); restartAgent(panel); });
  head.appendChild(restartBtn);
  wrapper.appendChild(head);

  // Search box — live filter over name + description
  const search = document.createElement('input');
  search.className = 'skillbot-skill-search';
  search.type = 'text';
  search.placeholder = '🔎 搜索技能…';
  search.value = panel._skillFilter;
  search.addEventListener('input', () => {
    panel._skillFilter = search.value;
    refreshSkillRows(panel);
  });
  // Keep search keystrokes from bubbling to the list-nav handler
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); exitSkillsMode(panel); return; }
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

  wrapper.addEventListener('keydown', (e) => onSkillKeydown(panel, e));
  panel._skillListWrapper = wrapper;
  panel._outputEl.appendChild(wrapper);
  panel._scrollBottom();
  refreshSkillRows(panel);
  // Focus wrapper so keyboard nav works (input is hidden in skills mode)
  setTimeout(() => wrapper.focus(), 50);
}

/** Open the browser file picker and upload the chosen .zip as a skill. */
export function promptUploadSkill(panel: any): void {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = '.zip,application/zip';
  input.style.display = 'none';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // reader.result is a data URL: strip the "data:...;base64," prefix
      const result = String(reader.result || '');
      const b64 = result.includes(',') ? result.split(',', 2)[1] : result;
      const nameArg = JSON.stringify(file.name);
      const b64Arg = JSON.stringify(b64);
      if (panel._kernel) {
        panel._kernel.requestExecute({
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
export function restartAgent(panel: any): void {
  if (panel._kernel) {
    panel._kernel.requestExecute({
      code: `get_ipython().user_ns['_panel_restart_agent']()`,
      store_history: false,
    });
  }
}

export function onSkillKeydown(panel: any, e: KeyboardEvent): void {
  // The list is now driven by direct clicks (toggle switch / name / 🗑 /
  // ➕ upload / ⟳ restart / 🔎 search). Keyboard only needs to close the
  // view and step out of a full-body drill-down.

  // Full body view → Esc backs out to the collapsed row.
  if (panel._fullBodyIdx !== -1) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      panel._fullBodyIdx = -1;
      refreshSkillRows(panel);
      setTimeout(() => panel._skillListWrapper?.focus(), 0);
    }
    return;
  }

  // Expanded detail → Esc collapses it.
  if (panel._expandedIdx !== -1) {
    if (e.key === 'Escape') {
      e.preventDefault(); e.stopPropagation();
      panel._expandedIdx = -1;
      panel._fullBodyIdx = -1;
      refreshSkillRows(panel);
      setTimeout(() => panel._skillListWrapper?.focus(), 0);
    }
    return;
  }

  // Otherwise Esc leaves skills mode entirely.
  if (e.key === 'Escape') {
    e.preventDefault(); e.stopPropagation();
    exitSkillsMode(panel);
  }
}

export function refreshSkillRows(panel: any): void {
  const listEl = panel._skillListWrapper?.querySelector('.skillbot-skill-items') as HTMLElement;
  if (!listEl) return;
  listEl.innerHTML = '';
  panel._skillRows = [];

  // Empty state in list area
  if (panel._skillData.length === 0) {
    const empty = document.createElement('div');
    empty.style.cssText = `padding:12px 4px;font-size:12px;color:rgb(120,120,120);text-align:center;`;
    empty.textContent = '还没有技能，点右上角 ➕ 上传 从 .zip 安装';
    listEl.appendChild(empty);
    updateSkillHint(panel);
    return;
  }

  // Apply live search filter over name + description.
  const q = panel._skillFilter.trim().toLowerCase();
  const matches = (s: {name: string, description: string}) =>
    !q || s.name.toLowerCase().includes(q) || (s.description || '').toLowerCase().includes(q);

  // Group by category, preserving discovery order within each group.
  const groups = new Map<string, Array<{s: any, idx: number}>>();
  panel._skillData.forEach((s: any, idx: number) => {
    if (!matches(s)) return;
    const cat = s.category || 'Uncategorized';
    if (!groups.has(cat)) groups.set(cat, []);
    groups.get(cat)!.push({s, idx});
  });

  if (groups.size === 0) {
    const none = document.createElement('div');
    none.style.cssText = `padding:12px 4px;font-size:12px;color:rgb(120,120,120);text-align:center;`;
    none.textContent = `没有匹配 “${panel._skillFilter}” 的技能`;
    listEl.appendChild(none);
    updateSkillHint(panel);
    return;
  }

  // Sort categories alphabetically, but keep Uncategorized last.
  const cats = Array.from(groups.keys()).sort((a, b) => {
    if (a === 'Uncategorized') return 1;
    if (b === 'Uncategorized') return -1;
    return a.localeCompare(b);
  });

  for (const cat of cats) {
    const items = groups.get(cat)!;
    // When searching, force-expand groups so hits are visible.
    const collapsed = !q && panel._collapsedCats.has(cat);
    const enabledCount = items.filter(it => it.s.enabled).length;

    const catHeader = document.createElement('div');
    catHeader.className = 'skillbot-skill-cat';
    catHeader.style.cursor = 'pointer';
    const chevron = collapsed ? '▸' : '▾';
    catHeader.innerHTML =
      `<span style="color:rgb(150,150,150);font-size:10px;width:10px;display:inline-block;">${chevron}</span>` +
      `<span style="color:${CC.text};font-size:11px;font-weight:600;">${panel._esc(cat)}</span>` +
      `<span style="color:rgb(130,130,130);font-size:10px;margin-left:auto;">${enabledCount}/${items.length}</span>`;
    catHeader.addEventListener('click', () => {
      if (panel._collapsedCats.has(cat)) panel._collapsedCats.delete(cat);
      else panel._collapsedCats.add(cat);
      refreshSkillRows(panel);
    });
    listEl.appendChild(catHeader);

    if (collapsed) continue;

    for (const {s, idx} of items) {
      const selected = idx === panel._skillSelectedIdx;
      const expanded = idx === panel._expandedIdx;
      const row = document.createElement('div');
      row.className = 'skillbot-skill-row';
      if (selected) row.style.background = 'rgba(255,255,255,0.08)';

      const header = document.createElement('div');
      header.style.cssText = `display:flex;align-items:center;gap:8px;`;

      // Real click-toggle switch.
      const sw = document.createElement('span');
      sw.className = 'skillbot-toggle' + (s.enabled ? ' on' : '');
      sw.title = s.enabled ? '已启用 — 点击停用' : '已停用 — 点击启用';
      sw.innerHTML = `<span class="skillbot-toggle-knob"></span>`;
      sw.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        toggleSkill(panel, idx);
      });
      header.appendChild(sw);

      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = `color:${s.enabled ? CC.text : 'rgb(140,140,140)'};font-size:12px;cursor:pointer;flex:1;`;
      nameSpan.textContent = s.name;
      nameSpan.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        panel._skillSelectedIdx = idx;
        panel._expandedIdx = (panel._expandedIdx === idx) ? -1 : idx;
        panel._fullBodyIdx = -1;
        refreshSkillRows(panel);
      });
      header.appendChild(nameSpan);

      const del = document.createElement('span');
      del.textContent = '✕';
      del.title = '卸载技能';
      del.style.cssText = `font-size:12px;cursor:pointer;opacity:0.5;`;
      del.addEventListener('click', (e) => {
        e.preventDefault(); e.stopPropagation();
        uninstallSkill(panel, idx);
      });
      header.appendChild(del);
      row.appendChild(header);

      if (expanded) {
        const showFull = panel._fullBodyIdx === idx;
        const detail = document.createElement('div');
        detail.style.cssText = `margin:6px 0 4px 34px;font-size:11px;color:rgb(180,180,180);line-height:1.5;`;
        detail.innerHTML = `<div style="margin-bottom:4px;">${panel._esc(s.description)}</div>`;
        if (s.body) {
          const bodyText = showFull ? s.body : s.body.slice(0, 1000);
          const maxH = showFull ? 350 : 150;
          detail.innerHTML += `<div style="color:${CC.text};background:rgba(255,255,255,0.03);padding:6px;border-radius:3px;max-height:${maxH}px;overflow-y:auto;white-space:pre-wrap;font-size:11px;">${panel._esc(bodyText)}${(!showFull && s.body.length > 1000) ? '…' : ''}</div>`;
          if (!showFull && s.body.length > 1000) {
            const more = document.createElement('span');
            more.textContent = '展开全文 ▾';
            more.style.cssText = `display:inline-block;margin-top:4px;font-size:10px;color:${CC.accent};cursor:pointer;`;
            more.addEventListener('click', (e) => {
              e.preventDefault(); e.stopPropagation();
              panel._fullBodyIdx = idx;
              refreshSkillRows(panel);
            });
            detail.appendChild(more);
          }
        }
        row.appendChild(detail);
      }
      listEl.appendChild(row);
      panel._skillRows.push(row);
    }
  }
  updateSkillHint(panel);
}

/** Optimistically flip a skill, tell the backend, and note it needs a restart. */
export function toggleSkill(panel: any, idx: number): void {
  const s = panel._skillData[idx];
  if (!s || !panel._kernel) return;
  s.enabled = !s.enabled;
  refreshSkillRows(panel);
  panel._kernel.requestExecute({
    code: `get_ipython().user_ns['_panel_input']('/skills toggle ${s.name}')`,
    store_history: false,
  });
  // Surface the "restart to apply" reality on the restart button.
  const btn = panel._skillListWrapper?.querySelector('.skillbot-skill-restart') as HTMLElement | null;
  if (btn) btn.classList.add('pending');
}

/** Uninstall a skill after an inline confirm click. */
export function uninstallSkill(panel: any, idx: number): void {
  const s = panel._skillData[idx];
  if (!s || !panel._kernel) return;
  if (!confirm(`卸载技能 “${s.name}”？此操作会删除其文件。`)) return;
  panel._kernel.requestExecute({
    code: `get_ipython().user_ns['_panel_input']('/skills uninstall ${s.name}')`,
    store_history: false,
  });
}

export function updateSkillHint(panel: any): void {
  const hintEl = panel._skillListWrapper?.querySelector('.skillbot-skill-hint');
  if (!hintEl) return;
  if (panel._skillData.length === 0) {
    hintEl.textContent = '➕ 上传 从 .zip 安装技能  Esc 关闭';
  } else {
    hintEl.textContent = '🔎 搜索 · 点分类折叠 · 点开关启用/停用 · 点名字看详情 · Esc 关闭';
  }
}

/** Flash a short backend message (upload/uninstall result) above the list. */
export function showSkillNotice(panel: any, msg: string): void {
  if (!msg || !panel._skillListWrapper) return;
  let el = panel._skillListWrapper.querySelector('.skillbot-skill-notice') as HTMLElement | null;
  if (!el) {
    el = document.createElement('div');
    el.className = 'skillbot-skill-notice';
    // Sits right under the search box, above the items.
    const items = panel._skillListWrapper.querySelector('.skillbot-skill-items');
    panel._skillListWrapper.insertBefore(el, items);
  }
  const ok = !msg.includes('✗');
  el.style.color = ok ? CC.accent : 'rgb(220,120,100)';
  el.textContent = msg;
  if (panel._skillNoticeTimer) clearTimeout(panel._skillNoticeTimer);
  panel._skillNoticeTimer = setTimeout(() => { if (el) el.textContent = ''; }, 6000);
}

export function renderSkillInfo(panel: any, skill: {name: string, description: string, enabled: boolean, body: string, path: string}): void {
  const wrapper = document.createElement('div');
  wrapper.className = 'skillbot-skill-info';

  const dot = skill.enabled
    ? `<span style="color:rgb(100,200,100);font-size:16px;">●</span>`
    : `<span style="color:rgb(200,100,100);font-size:16px;">●</span>`;

  const header = document.createElement('div');
  header.style.cssText = `font-size:14px;font-weight:600;color:${CC.text};margin-bottom:4px;`;
  header.innerHTML = `${dot} ${panel._esc(skill.name)}`;

  const meta = document.createElement('div');
  meta.style.cssText = `font-size:12px;color:rgb(180,180,180);margin-bottom:8px;line-height:1.5;`;
  meta.innerHTML = `
    ${panel._esc(skill.description)}<br>
    <span style="color:rgb(140,140,140);">Status:</span> ${skill.enabled ? 'enabled' : 'disabled'}<br>
    <span style="color:rgb(140,140,140);">Path:</span> ${panel._esc(skill.path)}
  `;

  const bodyText = (skill.body || '').slice(0, 1500);
  const bodyWrap = document.createElement('div');
  bodyWrap.style.cssText = `font-size:12px;color:${CC.text};background:rgba(255,255,255,0.04);padding:8px;border-radius:4px;max-height:200px;overflow-y:auto;white-space:pre-wrap;line-height:1.4;`;
  bodyWrap.textContent = bodyText;
  if ((skill.body || '').length > 1500) {
    bodyWrap.textContent += '\n\n... (truncated)';
  }

  wrapper.appendChild(header);
  wrapper.appendChild(meta);
  wrapper.appendChild(bodyWrap);
  panel._appendToBlock(wrapper);
}
