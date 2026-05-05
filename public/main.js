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
      const trace = document.createElement('details');
      trace.className = 'trace';
      trace.innerHTML = `<summary>tool / verifier trace</summary><pre>${escapeHtml(JSON.stringify(message.trace, null, 2))}</pre>`;
      node.appendChild(trace);
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