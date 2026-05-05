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
    node.querySelector('.content').textContent = message.content;
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
