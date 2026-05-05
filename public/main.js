const messagesEl = document.querySelector('#messages');
const form = document.querySelector('#composer');
const input = document.querySelector('#input');
const clear = document.querySelector('#clear');
const newThread = document.querySelector('#new-thread');
const threadList = document.querySelector('#thread-list');
const template = document.querySelector('#message-template');
const studioLanguage = document.querySelector('#studio-language');
const studioCode = document.querySelector('#studio-code');
const runStudio = document.querySelector('#run-studio');
const saveArtifact = document.querySelector('#save-artifact');
const studioStatus = document.querySelector('#studio-status');
const studioPreview = document.querySelector('#studio-preview');
const workspacePath = document.querySelector('#workspace-path');
const artifactList = document.querySelector('#artifact-list');

const STORAGE_KEY = 'grok-tooling-ui:threads:v1';
const DEFAULT_ASSISTANT_MESSAGE = '我會先用 planner 檢查前提、時效與工具需求，再回答。';
const DEFAULT_STUDIO_CODE = `<main>
  <h1>Studio preview</h1>
  <p>Edit HTML, CSS, or JavaScript and run it in the isolated frontend sandbox.</p>
  <button id="action">Click</button>
</main>
<style>
  body { margin: 0; font-family: system-ui, sans-serif; background: #111827; color: #f9fafb; }
  main { min-height: 100vh; display: grid; place-content: center; gap: 12px; text-align: center; }
  button { border: 0; border-radius: 8px; padding: 10px 14px; font-weight: 700; }
</style>
<script>
  document.querySelector('#action').addEventListener('click', () => {
    document.body.style.background = '#14532d';
  });
<\/script>`;

let threads = loadThreads();
let currentThreadId = threads[0]?.id || createThread().id;

function createThread() {
  const now = new Date().toISOString();
  const thread = {
    id: crypto.randomUUID(),
    title: 'New chat',
    createdAt: now,
    updatedAt: now,
    messages: [
      {
        role: 'assistant',
        content: DEFAULT_ASSISTANT_MESSAGE
      }
    ],
    studio: {
      language: 'html',
      code: DEFAULT_STUDIO_CODE,
      artifacts: []
    }
  };
  threads.unshift(thread);
  saveThreads();
  return thread;
}

function loadThreads() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveThreads() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(threads));
}

function getCurrentThread() {
  return threads.find((thread) => thread.id === currentThreadId) || threads[0] || createThread();
}

function getMessages() {
  return getCurrentThread().messages;
}

function setMessages(messages) {
  const thread = getCurrentThread();
  thread.messages = messages;
  thread.updatedAt = new Date().toISOString();
  updateThreadTitle(thread);
  saveThreads();
}

function updateThreadTitle(thread) {
  const firstUserMessage = thread.messages.find((message) => message.role === 'user')?.content;
  thread.title = firstUserMessage ? firstUserMessage.slice(0, 42) : 'New chat';
}

function getWorkspacePath(thread = getCurrentThread()) {
  return `/workspace/${thread.id}/artifacts`;
}

function render() {
  renderThreads();
  renderMessages();
  renderStudio();
}

function renderThreads() {
  threadList.innerHTML = '';
  for (const thread of threads) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `thread-item${thread.id === currentThreadId ? ' active' : ''}`;
    button.innerHTML = `
      <strong>${escapeHtml(thread.title)}</strong>
      <span>${escapeHtml(new Date(thread.updatedAt).toLocaleString())}</span>
    `;
    button.addEventListener('click', () => {
      currentThreadId = thread.id;
      render();
    });
    threadList.appendChild(button);
  }
}

function renderMessages() {
  messagesEl.innerHTML = '';
  for (const message of getMessages()) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add(message.role);
    node.querySelector('.role').textContent = message.role;
    node.querySelector('.content').innerHTML = renderMarkdown(message.content);
    if (message.trace) {
      node.appendChild(createReasoningTracePanel(message.trace));
    }
    messagesEl.appendChild(node);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function renderStudio() {
  const thread = getCurrentThread();
  workspacePath.textContent = getWorkspacePath(thread);
  if (document.activeElement !== studioCode) {
    studioCode.value = thread.studio.code;
  }
  studioLanguage.value = thread.studio.language;
  renderArtifacts();
}

function renderArtifacts() {
  const artifacts = getCurrentThread().studio.artifacts;
  artifactList.innerHTML = '';

  if (artifacts.length === 0) {
    artifactList.innerHTML = '<p class="trace-muted">No persistent files yet.</p>';
    return;
  }

  for (const artifact of artifacts) {
    const row = document.createElement('div');
    row.className = 'artifact-item';

    const name = document.createElement('span');
    name.textContent = artifact.path;

    const download = document.createElement('button');
    download.type = 'button';
    download.textContent = 'Download';
    download.addEventListener('click', () => downloadArtifact(artifact));

    row.append(name, download);
    artifactList.appendChild(row);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function renderInlineMarkdown(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, (_match, label, url) => {
      const safeUrl = escapeHtml(url);
      return `<a href="${safeUrl}" target="_blank" rel="noreferrer">${label}</a>`;
    });
}

function flushList(html, listItems) {
  if (listItems.length === 0) return;
  html.push(`<ul>${listItems.map((item) => `<li>${item}</li>`).join('')}</ul>`);
  listItems.length = 0;
}

function renderMarkdown(markdown) {
  const html = [];
  const listItems = [];
  const lines = String(markdown).split('\n');
  let inCodeBlock = false;
  let codeLines = [];

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCodeBlock) {
        html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
        codeLines = [];
        inCodeBlock = false;
      } else {
        flushList(html, listItems);
        inCodeBlock = true;
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    const trimmed = line.trim();
    if (!trimmed) {
      flushList(html, listItems);
      continue;
    }

    const heading = trimmed.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      flushList(html, listItems);
      const level = heading[1].length + 1;
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }

    const listItem = trimmed.match(/^[-*]\s+(.+)$/);
    if (listItem) {
      listItems.push(renderInlineMarkdown(listItem[1]));
      continue;
    }

    flushList(html, listItems);
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }

  if (inCodeBlock) {
    html.push(`<pre><code>${escapeHtml(codeLines.join('\n'))}</code></pre>`);
  }
  flushList(html, listItems);

  return html.join('');
}

function renderTraceList(items, emptyText) {
  if (!Array.isArray(items) || items.length === 0) {
    return `<p class="trace-muted">${escapeHtml(emptyText)}</p>`;
  }

  return `<ul>${items.map((item) => `<li>${renderInlineMarkdown(String(item))}</li>`).join('')}</ul>`;
}

function getClientContext() {
  const now = new Date();
  return {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    locale: navigator.language,
    local_time: now.toISOString(),
    local_time_display: now.toString(),
    utc_offset_minutes: -now.getTimezoneOffset()
  };
}

function renderWorkPlan(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '<p class="trace-muted">No work plan was returned.</p>';
  }

  return `<ol class="work-plan">${items.map((item) => `
    <li class="${String(item.status || 'pending') === 'checked' ? 'checked' : 'pending'}">
      <strong>${renderInlineMarkdown(String(item.step || 'Untitled step'))}</strong>
      ${item.note ? `<span>${renderInlineMarkdown(String(item.note))}</span>` : ''}
    </li>
  `).join('')}</ol>`;
}

function createReasoningTracePanel(trace) {
  const planner = trace.planner || {};
  const reasoningTrace = planner.reasoning_trace || {};
  const skills = Array.isArray(planner.selected_skills) ? planner.selected_skills : [];
  const toolResults = Array.isArray(trace.toolResults) ? trace.toolResults : [];
  const clientContext = trace.clientContext || {};

  const details = document.createElement('details');
  details.className = 'trace reasoning-trace';
  details.open = true;

  const skillsHtml = skills.length
    ? skills.map((skill) => `
        <li>
          <strong>${escapeHtml(String(skill.name || 'Unknown skill'))}</strong>
          <span>${renderInlineMarkdown(String(skill.reason || 'Selected by planner.'))}</span>
          ${skill.sop ? `<details class="skill-sop"><summary>SOP</summary>${renderMarkdown(String(skill.sop))}</details>` : ''}
        </li>
      `).join('')
    : '<li><strong>Planner fallback</strong><span>No explicit skill selection was returned.</span></li>';

  const toolSummary = toolResults.length
    ? toolResults.map((result) => `<li><strong>${escapeHtml(String(result.tool))}</strong><span>${renderInlineMarkdown(String(result.output || '').slice(0, 280))}</span></li>`).join('')
    : '<li><strong>No tools run</strong><span>The planner chose to answer without local or built-in tool output.</span></li>';

  details.innerHTML = `
    <summary>Reasoning trace</summary>
    <div class="trace-grid">
      <section>
        <h3>Detected task type</h3>
        <p>${renderInlineMarkdown(String(planner.task_type || 'general'))}</p>
      </section>
      <section>
        <h3>Reasoning mode</h3>
        <p>${renderInlineMarkdown(String(planner.reasoning_mode || 'normal'))}</p>
      </section>
      <section>
        <h3>Client time context</h3>
        <p>${renderInlineMarkdown(String(clientContext.local_time_display || clientContext.local_time || 'Not provided'))}</p>
        <p class="trace-muted">${renderInlineMarkdown(String(clientContext.timezone || 'unknown timezone'))}</p>
      </section>
      <section>
        <h3>Checked work plan</h3>
        ${renderWorkPlan(planner.reasoning_work_plan)}
      </section>
      <section>
        <h3>Selected thinking skills</h3>
        <ul class="skill-list">${skillsHtml}</ul>
      </section>
      <section>
        <h3>Method note</h3>
        <p>${renderInlineMarkdown(String(reasoningTrace.summary || 'No user-facing method note was returned.'))}</p>
      </section>
      <section>
        <h3>Evidence policy</h3>
        <p>${renderInlineMarkdown(String(reasoningTrace.evidence_policy || 'Prefer stronger sources when available.'))}</p>
      </section>
      <section>
        <h3>Tools considered</h3>
        ${renderTraceList(reasoningTrace.tools_considered, 'No tools were explicitly considered.')}
      </section>
      <section>
        <h3>Sources / evidence hierarchy</h3>
        ${renderTraceList(reasoningTrace.source_types, 'No source types were explicitly classified.')}
      </section>
      <section>
        <h3>Confidence and uncertainty</h3>
        <p>${renderInlineMarkdown(String(reasoningTrace.uncertainty || 'Uncertainty was not explicitly classified.'))}</p>
      </section>
      <section>
        <h3>Tool calls</h3>
        <ul class="skill-list">${toolSummary}</ul>
      </section>
    </div>
    <details class="raw-trace">
      <summary>Raw tool / verifier trace</summary>
      <pre>${escapeHtml(JSON.stringify(trace, null, 2))}</pre>
    </details>
  `;

  return details;
}

function validateStudioCode(language, code) {
  const blockedPatterns = [
    /\b(fetch|XMLHttpRequest|WebSocket|EventSource)\b/i,
    /\b(localStorage|sessionStorage|indexedDB|caches|serviceWorker)\b/i,
    /\b(require|process|child_process|fs|net|http|https|Deno|Bun)\b/i,
    /\b(express|fastify|koa|listen\s*\(|createServer)\b/i,
    /\b(importScripts|Worker|SharedWorker)\b/i,
    /<\s*(iframe|object|embed|base|form|meta)\b/i
  ];
  const backendLanguages = /\b(node|python|ruby|php|perl|bash|sh|powershell|java|go|rust|c\+\+|sqlite|postgres|mysql)\b/i;

  if (!['html', 'css', 'javascript'].includes(language)) {
    return 'Only frontend HTML, CSS, and JavaScript are supported.';
  }
  if (backendLanguages.test(language)) {
    return 'Backend or system languages are blocked in Studio.';
  }
  if (blockedPatterns.some((pattern) => pattern.test(code))) {
    return 'Blocked: Studio only allows isolated frontend rendering. Backend, network, storage, worker, and embedding APIs are disabled.';
  }
  return '';
}

function extractRunnableBlock(markdown) {
  const match = String(markdown).match(/```(html|css|javascript|js)\s*([\s\S]*?)```/i);
  if (!match) return null;

  return {
    language: match[1].toLowerCase() === 'js' ? 'javascript' : match[1].toLowerCase(),
    code: match[2].trim()
  };
}

function buildStudioDocument(language, code) {
  const guard = `
    <script>
      const blocked = () => { throw new Error('Studio sandbox blocks backend, network, storage, and worker APIs.'); };
      window.fetch = blocked;
      window.XMLHttpRequest = blocked;
      window.WebSocket = blocked;
      window.EventSource = blocked;
      window.Worker = blocked;
      window.SharedWorker = blocked;
      window.localStorage = undefined;
      window.sessionStorage = undefined;
      window.indexedDB = undefined;
      window.caches = undefined;
    <\/script>`;

  if (language === 'html') {
    return `<!doctype html><html><head><meta charset="utf-8">${guard}</head><body>${code}</body></html>`;
  }
  if (language === 'css') {
    return `<!doctype html><html><head><meta charset="utf-8">${guard}<style>${code}</style></head><body><main class="studio-css-preview">CSS preview canvas</main></body></html>`;
  }
  return `<!doctype html><html><head><meta charset="utf-8">${guard}</head><body><main id="app"></main><script>${code}<\/script></body></html>`;
}

function runStudioCode() {
  const thread = getCurrentThread();
  const language = studioLanguage.value;
  const code = studioCode.value;
  const validationError = validateStudioCode(language, code);

  thread.studio.language = language;
  thread.studio.code = code;
  thread.updatedAt = new Date().toISOString();
  saveThreads();

  if (validationError) {
    studioPreview.removeAttribute('srcdoc');
    studioStatus.textContent = validationError;
    studioStatus.className = 'studio-status error';
    renderThreads();
    return;
  }

  studioPreview.srcdoc = buildStudioDocument(language, code);
  studioStatus.textContent = `Ran in disposable frontend sandbox. Persistent directory: ${getWorkspacePath(thread)}`;
  studioStatus.className = 'studio-status ok';
  renderThreads();
}

function runModelGeneratedFrontend(markdown) {
  const runnable = extractRunnableBlock(markdown);
  if (!runnable) return;

  const validationError = validateStudioCode(runnable.language, runnable.code);
  if (validationError) {
    studioStatus.textContent = `Model code blocked: ${validationError}`;
    studioStatus.className = 'studio-status error';
    return;
  }

  const thread = getCurrentThread();
  thread.studio.language = runnable.language;
  thread.studio.code = runnable.code;
  thread.updatedAt = new Date().toISOString();
  saveThreads();

  studioLanguage.value = runnable.language;
  studioCode.value = runnable.code;
  studioPreview.srcdoc = buildStudioDocument(runnable.language, runnable.code);
  studioStatus.textContent = `Model-generated ${runnable.language} ran in disposable frontend sandbox. Only ${getWorkspacePath(thread)} is persistent.`;
  studioStatus.className = 'studio-status ok';
}

function saveStudioArtifact() {
  const thread = getCurrentThread();
  const language = studioLanguage.value;
  const code = studioCode.value;
  const extension = language === 'javascript' ? 'js' : language;
  const filename = `studio-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
  const artifact = {
    path: `${getWorkspacePath(thread)}/${filename}`,
    name: filename,
    language,
    content: code,
    createdAt: new Date().toISOString()
  };

  thread.studio.language = language;
  thread.studio.code = code;
  thread.studio.artifacts.unshift(artifact);
  thread.updatedAt = new Date().toISOString();
  saveThreads();
  studioStatus.textContent = `Saved ${artifact.path}`;
  studioStatus.className = 'studio-status ok';
  render();
}

function downloadArtifact(artifact) {
  const blob = new Blob([artifact.content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = artifact.name;
  link.click();
  URL.revokeObjectURL(url);
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content) return;

  const messages = getMessages();
  messages.push({ role: 'user', content });
  input.value = '';
  setMessages(messages);
  render();

  const pending = { role: 'assistant', content: 'Thinking with tools...' };
  messages.push(pending);
  setMessages(messages);
  render();

  try {
    const clientContext = getClientContext();
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        client_context: clientContext,
        messages: messages
          .filter((message) => !message.trace && message.content !== 'Thinking with tools...')
          .map(({ role, content }) => ({ role, content }))
      })
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed');

    pending.content = data.final || data.draft || 'No answer returned.';
    pending.trace = {
      planner: data.planner,
      clientContext: data.clientContext || clientContext,
      toolResults: data.toolResults,
      draft: data.draft
    };
    runModelGeneratedFrontend(pending.content);
  } catch (error) {
    pending.content = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }

  setMessages(messages);
  render();
});

clear.addEventListener('click', () => {
  setMessages([{ role: 'assistant', content: '已清空。輸入新問題即可。' }]);
  render();
});

newThread.addEventListener('click', () => {
  currentThreadId = createThread().id;
  studioStatus.textContent = '';
  studioPreview.removeAttribute('srcdoc');
  render();
});

studioLanguage.addEventListener('change', () => {
  const thread = getCurrentThread();
  thread.studio.language = studioLanguage.value;
  thread.updatedAt = new Date().toISOString();
  saveThreads();
  renderThreads();
});

studioCode.addEventListener('input', () => {
  const thread = getCurrentThread();
  thread.studio.code = studioCode.value;
  thread.updatedAt = new Date().toISOString();
  saveThreads();
  renderThreads();
});

runStudio.addEventListener('click', runStudioCode);
saveArtifact.addEventListener('click', saveStudioArtifact);

render();
