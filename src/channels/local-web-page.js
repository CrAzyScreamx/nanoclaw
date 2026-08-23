/**
 * Browser asset for the local-web chat page. Served to the browser at
 * /local-web-page.js; never imported by the host process.
 */
/* global document, history, location, localStorage, sessionStorage */
/* eslint-disable no-catch-all/no-catch-all -- every catch here degrades the page
   instead of failing it: storage denied, a torn frame, an aborted stream. */

(() => {
  const historyKey = 'nanoclaw-local-web-history';
  const tokenKey = 'nanoclaw-local-web-token';
  const tokenHeader = 'x-nanoclaw-local-web-token';
  const maxVisibleItems = 100;
  const messages = document.querySelector('#messages');
  const form = document.querySelector('#composer');
  const input = document.querySelector('#message');
  const send = document.querySelector('#send');
  const status = document.querySelector('#status');
  const breath = document.querySelector('#breath');
  const activity = document.querySelector('#activity');
  const activityLabel = document.querySelector('#activity-label');
  const activityIdleMs = 10_000;
  let activityTimer = null;

  // The launcher hands the token over in the fragment, which never reaches
  // the server. Strip it immediately: the address bar is the one place it
  // could leave this machine, since browsers sync history and bookmarks.
  let token = new URLSearchParams(location.hash.slice(1)).get('token');
  if (token) {
    try {
      localStorage.setItem(tokenKey, token);
    } catch {
      // a browser with site data blocked keeps the token for this page load only
    }
    history.replaceState(null, '', location.pathname);
  } else {
    try {
      token = localStorage.getItem(tokenKey);
    } catch {
      // no stored token reads the same as never having had one
    }
  }

  let transcript = [];
  try {
    const parsed = JSON.parse(sessionStorage.getItem(historyKey) || '[]');
    if (Array.isArray(parsed)) transcript = parsed.slice(-maxVisibleItems);
  } catch {
    // unreadable transcript just starts the conversation empty
  }
  function trimConversation() {
    if (transcript.length > maxVisibleItems) transcript.splice(0, transcript.length - maxVisibleItems);
    while (messages.children.length > maxVisibleItems) messages.firstElementChild?.remove();
  }
  function persist() {
    trimConversation();
    try {
      sessionStorage.setItem(historyKey, JSON.stringify(transcript));
    } catch {
      // losing the transcript must never block sending
    }
  }
  function addMessage(role, text, save = true, html = null) {
    if (role !== 'system') clearPlaceholder();
    const node = document.createElement('div');
    node.className = `message ${role}`;
    // Agent HTML is produced by the server's raw-HTML-disabled Markdown renderer.
    if (role === 'agent' && typeof html === 'string') node.innerHTML = html;
    else node.textContent = text;
    messages.append(node);
    if (save) {
      transcript.push({ role, text, ...(typeof html === 'string' && { html }) });
      persist();
    }
    messages.scrollTop = messages.scrollHeight;
  }
  function addQuestion(card, save = true) {
    const node = document.createElement('article');
    node.className = 'question-card';
    node.dataset.questionId = card.questionId;

    const kicker = document.createElement('p');
    kicker.className = 'question-kicker';
    kicker.textContent = 'Action required';
    node.append(kicker);

    const title = document.createElement('h2');
    title.className = 'question-title';
    title.textContent = card.title;
    node.append(title);

    if (card.question) {
      const body = document.createElement('p');
      body.className = 'question-body';
      body.textContent = card.question;
      node.append(body);
    }

    const actions = document.createElement('div');
    actions.className = 'question-actions';
    const buttons = card.options.map((option, index) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `question-option ${option.style || ''}`;
      button.textContent = option.label;
      button.disabled = Boolean(card.resolution);
      button.addEventListener('click', async () => {
        buttons.forEach((item) => (item.disabled = true));
        try {
          const response = await fetch('/api/actions', {
            method: 'POST',
            headers: { 'content-type': 'application/json', [tokenHeader]: token },
            body: JSON.stringify({ questionId: card.questionId, option: index }),
          });
          if (!response.ok) {
            const responseBody = await response.json().catch(() => ({}));
            throw new Error(responseBody.error || `Action failed (${response.status})`);
          }
          resolveQuestion(card.questionId, option.selectedLabel || option.label);
          setState('Ready');
        } catch (error) {
          resolution.textContent = error instanceof Error ? error.message : 'Action could not be sent.';
          resolution.hidden = false;
          resolution.classList.add('question-error');
          buttons.forEach((item) => (item.disabled = false));
        }
      });
      actions.append(button);
      return button;
    });
    node.append(actions);

    const resolution = document.createElement('p');
    resolution.className = 'question-resolution';
    resolution.textContent = card.resolution || '';
    resolution.hidden = !card.resolution;
    node.append(resolution);

    messages.append(node);
    if (save) {
      transcript.push(card);
      persist();
    }
    messages.scrollTop = messages.scrollHeight;
  }
  function resolveQuestion(questionId, value) {
    const card = transcript.find((item) => item.type === 'question' && item.questionId === questionId);
    if (card) card.resolution = value;
    const node = [...messages.querySelectorAll('.question-card')].find(
      (item) => item.dataset.questionId === questionId,
    );
    if (!node) return;
    node.querySelectorAll('.question-option').forEach((button) => (button.disabled = true));
    const resolution = node.querySelector('.question-resolution');
    resolution.textContent = value;
    resolution.hidden = false;
    resolution.classList.remove('question-error');
    persist();
  }
  // Header status is connection state; turn activity lives in the pill.
  function setState(label) {
    status.textContent = label;
  }
  function setActivity(label, isTool = false) {
    clearTimeout(activityTimer);
    activityTimer = null;
    activity.hidden = !label;
    activity.classList.toggle('tool', isTool);
    breath.classList.toggle('thinking', Boolean(label));
    if (label) {
      activityLabel.textContent = label;
      activityTimer = setTimeout(() => setActivity(null), activityIdleMs);
    }
  }
  function showPlaceholder() {
    if (messages.querySelector('.placeholder')) return;
    const node = document.createElement('div');
    node.className = 'message system placeholder';
    node.textContent = 'Starting your local conversation…';
    messages.append(node);
  }
  function clearPlaceholder() {
    messages.querySelector('.placeholder')?.remove();
  }
  for (const item of transcript) {
    if (item.type === 'question') addQuestion(item, false);
    else addMessage(item.role === 'user' ? 'user' : 'agent', item.text, false, item.html);
  }
  if (transcript.length === 0) showPlaceholder();

  function showNotAuthorized() {
    send.disabled = true;
    input.disabled = true;
    setActivity(null);
    setState('Not connected');
    clearPlaceholder();
    // This screen is the recovery path when a browser opened the bare address,
    // so it has to name the token rather than any one installer's command.
    addMessage(
      'system',
      'This browser has no access token. Reopen the chat using the link its install prints, which ends in ' +
        '#token=…; the token is in data/local-web/token on the host.',
      false,
    );
  }

  // A hand-read stream rather than EventSource: EventSource cannot send the
  // token header, and its onerror reports no status, so a rejected token
  // would be indistinguishable from the server being down.
  async function streamEvents() {
    let retryDelay = 1_000;
    for (;;) {
      try {
        const response = await fetch('/events', { headers: { [tokenHeader]: token } });
        if (response.status === 401) {
          showNotAuthorized();
          return;
        }
        if (!response.ok || !response.body) throw new Error(`Stream failed (${response.status})`);
        setState('Ready');
        send.disabled = false;
        retryDelay = 1_000;
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          // split leaves an incomplete trailing frame as the last element
          const frames = buffer.split('\n\n');
          buffer = frames.pop();
          for (const frame of frames) if (frame.startsWith('data: ')) handleEvent(frame.slice(6));
        }
      } catch {
        // the connection failed or dropped; the retry below is the recovery
      }
      send.disabled = true;
      setState('Reconnecting…');
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      // back off, so a stopped host is not one failed fetch per second forever
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }

  function handleEvent(raw) {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'ready') {
        setState('Ready');
        setActivity(null);
        send.disabled = false;
      }
      if (data.type === 'thinking') {
        setActivity('Thinking…');
      }
      if (data.type === 'tool' && typeof data.name === 'string') {
        setActivity(`Using ${data.name}`, true);
      }
      if (data.type === 'reply' && typeof data.text === 'string') {
        clearPlaceholder();
        addMessage('agent', data.text, true, typeof data.html === 'string' ? data.html : null);
        send.disabled = false;
        input.focus();
        setState('Ready');
        setActivity(null);
      }
      if (
        data.type === 'question' &&
        typeof data.questionId === 'string' &&
        typeof data.title === 'string' &&
        Array.isArray(data.options)
      ) {
        clearPlaceholder();
        addQuestion({
          type: 'question',
          questionId: data.questionId,
          title: data.title,
          question: typeof data.question === 'string' ? data.question : '',
          options: data.options.filter(
            (option) => option && typeof option.label === 'string' && typeof option.selectedLabel === 'string',
          ),
        });
        send.disabled = false;
        setState('Action required');
        setActivity(null);
      }
      if (
        data.type === 'question-resolution' &&
        typeof data.questionId === 'string' &&
        typeof data.resolution === 'string'
      ) {
        resolveQuestion(data.questionId, data.resolution);
        setState('Ready');
      }
    } catch {
      // same: one bad frame never stops the page
    }
  }

  if (token) void streamEvents();
  else showNotAuthorized();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    addMessage('user', text);
    input.value = '';
    input.style.height = 'auto';
    send.disabled = true;
    setActivity('Thinking…');
    try {
      const response = await fetch('/api/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', [tokenHeader]: token },
        body: JSON.stringify({ text }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Request failed (${response.status})`);
      }
      send.disabled = false;
      input.focus();
    } catch (error) {
      addMessage('system', error instanceof Error ? error.message : 'Message could not be sent.', false);
      send.disabled = false;
      setState('Ready');
      setActivity(null);
    }
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      form.requestSubmit();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  });
  input.focus();
})();
