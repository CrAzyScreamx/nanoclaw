/**
 * Browser asset for the local-web chat page. Served to the browser at
 * /local-web-page.js; never imported by the host process.
 */
/* global document, history, location, localStorage, matchMedia, navigator, sessionStorage */
/* eslint-disable no-catch-all/no-catch-all -- every catch here degrades the page
   instead of failing it: storage denied, a torn frame, an aborted stream. */

(() => {
  const historyKey = 'nanoclaw-local-web-history';
  const tokenKey = 'nanoclaw-local-web-token';
  const themeKey = 'nanoclaw-local-web-theme';
  const tokenHeader = 'x-nanoclaw-local-web-token';
  const maxVisibleItems = 100;
  const maxLength = 8000;
  const counterThreshold = 400;
  const stickyBottomPx = 96;
  const activityIdleMs = 10_000;
  const silentTurnMs = 180_000;

  const root = document.documentElement;
  const messages = document.querySelector('#messages');
  const form = document.querySelector('#composer');
  const input = document.querySelector('#message');
  const send = document.querySelector('#send');
  const status = document.querySelector('#status');
  const statusLabel = status.querySelector('span');
  const themeButton = document.querySelector('#theme');
  const jump = document.querySelector('#jump');
  const counter = document.querySelector('#counter');
  const activity = document.querySelector('#activity');
  const activityLabel = document.querySelector('#activity-label');
  let activityTimer = null;
  let silentTurnTimer = null;

  // ---- theme ------------------------------------------------------------
  // No stored choice means follow the OS; the button writes an explicit one.
  try {
    const stored = localStorage.getItem(themeKey);
    if (stored === 'light' || stored === 'dark') root.dataset.theme = stored;
  } catch {
    // a browser with site data blocked simply follows the OS every load
  }
  function prefersDark() {
    return root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function syncThemeLabel() {
    const next = prefersDark() ? 'light' : 'dark';
    themeButton.setAttribute('aria-label', `Switch to ${next} theme`);
    themeButton.setAttribute('title', `Switch to ${next} theme`);
  }
  themeButton.addEventListener('click', () => {
    const next = prefersDark() ? 'light' : 'dark';
    root.dataset.theme = next;
    try {
      localStorage.setItem(themeKey, next);
    } catch {
      // the choice still applies to this page load
    }
    syncThemeLabel();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', syncThemeLabel);
  syncThemeLabel();

  // ---- token ------------------------------------------------------------
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

  // ---- transcript -------------------------------------------------------
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

  // ---- scroll -----------------------------------------------------------
  // Only follow new content when the reader is already at the bottom.
  // Yanking someone out of scrollback to show a message they can see the
  // arrival of is the single most irritating thing a chat log can do.
  function isAtBottom() {
    return messages.scrollHeight - messages.scrollTop - messages.clientHeight < stickyBottomPx;
  }
  function scrollToLatest(smooth = true) {
    messages.scrollTo({ top: messages.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
    jump.hidden = true;
  }
  function settleScroll(wasAtBottom) {
    if (wasAtBottom) scrollToLatest();
    else jump.hidden = false;
  }
  messages.addEventListener('scroll', () => {
    if (isAtBottom()) jump.hidden = true;
  });
  jump.addEventListener('click', () => {
    scrollToLatest();
    input.focus();
  });

  // ---- rendering --------------------------------------------------------
  function labelFor(role) {
    if (role === 'user') return 'You';
    return role === 'agent' ? 'NanoClaw' : '';
  }
  /** Copy buttons and horizontal table scrollers over server-rendered Markdown. */
  function enhanceMarkdown(node) {
    for (const table of node.querySelectorAll('table')) {
      const wrap = document.createElement('div');
      wrap.className = 'table-scroll';
      table.replaceWith(wrap);
      wrap.append(table);
    }
    for (const pre of node.querySelectorAll('pre')) {
      const source = (pre.querySelector('code') || pre).textContent;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'copy';
      button.textContent = 'Copy';
      button.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(source);
          button.textContent = 'Copied';
        } catch {
          button.textContent = 'Copy failed';
        }
        setTimeout(() => (button.textContent = 'Copy'), 1600);
      });
      pre.append(button);
    }
  }
  function addMessage(role, text, save = true, html = null) {
    const wasAtBottom = isAtBottom();
    if (role !== 'system') clearEmptyState();

    const turn = document.createElement('div');
    turn.className = `turn ${role}${save ? ' enter' : ''}`;

    const label = labelFor(role);
    if (label) {
      const roleTag = document.createElement('p');
      roleTag.className = 'role';
      roleTag.textContent = label;
      turn.append(roleTag);
    }

    const node = document.createElement('div');
    node.className = `message ${role}`;
    // Agent HTML is produced by the server's raw-HTML-disabled Markdown renderer.
    if (role === 'agent' && typeof html === 'string') {
      node.innerHTML = html;
      enhanceMarkdown(node);
    } else {
      node.textContent = text;
    }
    turn.append(node);
    messages.append(turn);

    if (save) {
      transcript.push({ role, text, ...(typeof html === 'string' && { html }) });
      persist();
    }
    settleScroll(wasAtBottom || !save);
  }
  function addQuestion(card, save = true) {
    const wasAtBottom = isAtBottom();
    clearEmptyState();
    const node = document.createElement('article');
    node.className = `question-card${save ? ' enter' : ''}`;
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
          setState('Ready', 'ready');
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
    settleScroll(wasAtBottom || !save);
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
  function setState(label, state) {
    statusLabel.textContent = label;
    status.dataset.state = state;
  }
  function setActivity(label, isTool = false) {
    clearTimeout(activityTimer);
    activityTimer = null;
    activity.hidden = !label;
    activity.classList.toggle('tool', isTool);
    activity.classList.remove('stalled');
    if (!label) return;
    activityLabel.textContent = label;
    // The backend stops emitting thinking/tool events roughly 15s into a turn
    // while the turn itself runs on. Hiding the pill there reads as "finished",
    // so it degrades to the only thing the page still honestly knows.
    activityTimer = setTimeout(() => {
      activityLabel.textContent = 'Still working';
      activity.classList.add('stalled');
      activity.classList.remove('tool');
    }, activityIdleMs);
  }
  // A turn can complete backend-side and deliver nothing, with no error event.
  // Rather than leave the pill spinning forever, say so after a long silence.
  function beginTurn() {
    clearTimeout(silentTurnTimer);
    silentTurnTimer = setTimeout(() => {
      setActivity(null);
      setState('Ready', 'ready');
      addMessage(
        'system',
        'No reply yet. The turn may still be running, or it may have finished without sending one.',
        false,
      );
    }, silentTurnMs);
  }
  function endTurn() {
    clearTimeout(silentTurnTimer);
    silentTurnTimer = null;
  }
  /** The full-height state the log shows when it holds no conversation. */
  function renderEmptyState({ heading, body, note, locked = false }) {
    clearEmptyState();
    const node = document.createElement('div');
    node.className = `empty${locked ? ' locked' : ''}`;

    const mark = document.createElement('div');
    mark.className = 'empty-mark';
    mark.setAttribute('aria-hidden', 'true');
    node.append(mark);

    const title = document.createElement('h2');
    title.textContent = heading;
    node.append(title);

    const text = document.createElement('p');
    text.textContent = body;
    node.append(text);

    if (note) {
      const code = document.createElement('code');
      code.textContent = note;
      node.append(code);
    }
    messages.append(node);
  }
  function showEmptyState() {
    if (messages.querySelector('.empty')) return;
    renderEmptyState({
      heading: 'Nothing here yet',
      body: 'This chat runs entirely on your machine. Nothing you type leaves 127.0.0.1.',
    });
  }
  function clearEmptyState() {
    messages.querySelector('.empty')?.remove();
  }
  for (const item of transcript) {
    if (item.type === 'question') addQuestion(item, false);
    else addMessage(item.role === 'user' ? 'user' : 'agent', item.text, false, item.html);
  }
  if (transcript.length === 0) showEmptyState();
  else scrollToLatest(false);

  function showNotAuthorized() {
    send.disabled = true;
    input.disabled = true;
    setActivity(null);
    setState('Not connected', 'down');
    // This screen is the recovery path when a browser opened the bare address,
    // so it has to name the token rather than any one installer's command.
    renderEmptyState({
      heading: 'This browser has no access token',
      body: 'Reopen the chat using the link your install prints; its address ends with a #token= fragment. On the host, the token itself lives at:',
      note: 'data/local-web/token',
      locked: true,
    });
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
        setState('Ready', 'ready');
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
      setState('Reconnecting…', 'down');
      await new Promise((resolve) => setTimeout(resolve, retryDelay));
      // back off, so a stopped host is not one failed fetch per second forever
      retryDelay = Math.min(retryDelay * 2, 30_000);
    }
  }

  function handleEvent(raw) {
    try {
      const data = JSON.parse(raw);
      if (data.type === 'ready') {
        setState('Ready', 'ready');
        setActivity(null);
        send.disabled = false;
      }
      if (data.type === 'thinking') {
        setState('Working', 'busy');
        setActivity('Thinking…');
      }
      if (data.type === 'tool' && typeof data.name === 'string') {
        setState('Working', 'busy');
        setActivity(`Using ${data.name}`, true);
      }
      if (data.type === 'reply' && typeof data.text === 'string') {
        endTurn();
        clearEmptyState();
        addMessage('agent', data.text, true, typeof data.html === 'string' ? data.html : null);
        send.disabled = false;
        input.focus();
        setState('Ready', 'ready');
        setActivity(null);
      }
      if (
        data.type === 'question' &&
        typeof data.questionId === 'string' &&
        typeof data.title === 'string' &&
        Array.isArray(data.options)
      ) {
        endTurn();
        clearEmptyState();
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
        setState('Action required', 'attention');
        setActivity(null);
      }
      if (
        data.type === 'question-resolution' &&
        typeof data.questionId === 'string' &&
        typeof data.resolution === 'string'
      ) {
        resolveQuestion(data.questionId, data.resolution);
        setState('Ready', 'ready');
      }
    } catch {
      // same: one bad frame never stops the page
    }
  }

  if (token) void streamEvents();
  else showNotAuthorized();

  // ---- composer ---------------------------------------------------------
  function resize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 200)}px`;
  }
  function updateCounter() {
    const remaining = maxLength - input.value.length;
    counter.hidden = remaining > counterThreshold;
    counter.textContent = `${remaining} left`;
    counter.classList.toggle('over', remaining <= 0);
  }
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text || send.disabled) return;
    addMessage('user', text);
    input.value = '';
    resize();
    updateCounter();
    send.disabled = true;
    setState('Working', 'busy');
    setActivity('Thinking…');
    beginTurn();
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
      endTurn();
      addMessage('system', error instanceof Error ? error.message : 'Message could not be sent.', false);
      send.disabled = false;
      setState('Ready', 'ready');
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
    resize();
    updateCounter();
  });
  input.focus();
})();
