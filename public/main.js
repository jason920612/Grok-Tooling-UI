const messagesEl = document.querySelector('#messages');
const form = document.querySelector('#composer');
const input = document.querySelector('#input');
const clear = document.querySelector('#clear');
const template = document.querySelector('#message-template');

let messages = [
  {
    role: 'assistant',
    content: '我會先用 planner 檢查前提、時效與工具需求，再回答。'
  }
];

function render() {
  messagesEl.innerHTML = '';
  for (const message of messages) {
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

function escapeHtml(value) {
  return value
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
  const lines = markdown.split('\n');
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

function createReasoningTracePanel(trace) {
  const planner = trace.planner || {};
  const reasoningTrace = planner.reasoning_trace || {};
  const skills = Array.isArray(planner.selected_skills) ? planner.selected_skills : [];
  const toolResults = Array.isArray(trace.toolResults) ? trace.toolResults : [];

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

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const content = input.value.trim();
  if (!content) return;

  messages.push({ role: 'user', content });
  input.value = '';
  render();

  const pending = { role: 'assistant', content: 'Thinking with tools...' };
  messages.push(pending);
  render();

  try {
    const response = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
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
      toolResults: data.toolResults,
      draft: data.draft
    };
  } catch (error) {
    pending.content = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }

  render();
});

clear.addEventListener('click', () => {
  messages = [{ role: 'assistant', content: '已清空。輸入新問題即可。' }];
  render();
});

render();