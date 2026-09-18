/*
 * The OrcaRouter provider card.
 *
 * TWO AUTHENTICATION CHOICES, BOTH REAL. Paste a key, or sign in with PKCE.
 * They are separate controls with separate status, because a single button that
 * sometimes asks for a key and sometimes opens a browser makes logout,
 * reauthentication and support all harder -- and because a user with a key but
 * no browser must keep a working path.
 *
 * THE PAGE NEVER HOLDS A KEY. The field posts the secret to the loopback server
 * and the server answers with a redacted status; the model list comes back
 * without credentials in it. There is no client-side store and nothing here
 * writes a secret to console, a URL or an error string.
 *
 * THE LOGIN LOCK IS RELEASED ON EVERY TERMINAL PATH. Success, denial, exchange
 * error, timeout, an explicit Cancel, switching choice, a closed modal, an
 * unmount, a reload, a window close and `pagehide`. The `pagehide` handler is
 * the one that cannot rely on the awaited continuation: that continuation is
 * generation-guarded and will correctly refuse to touch state once the page is
 * going away, which would leave a back-forward-cache restore permanently busy.
 * So it clears busy and hint synchronously and sends the cancel with
 * `keepalive`.
 *
 * EVERY ASYNC RESPONSE CHECKS ITS GENERATION before it is allowed to install a
 * credential or change the card, so a late reply from a superseded login cannot
 * appear under the current one.
 */

const ORCA = '/api/orcarouter';

/* One generation for the whole card, bumped by every state-changing action. */
let orcaGeneration = 0;
let orcaAttemptId = null;
let orcaAuthorizeUrl = null;
let orcaBusy = false;

const orcaEl = (id) => document.getElementById(id);

function orcaSetStatus(message, tone) {
  const node = orcaEl('orcarouter-auth-status');
  if (!node) return;
  node.textContent = message || '';
  if (tone) node.dataset.tone = tone;
  else delete node.dataset.tone;
}

function orcaSetBusy(busy, hint) {
  orcaBusy = busy;
  const connect = orcaEl('orcarouter-connect');
  const cancel = orcaEl('orcarouter-cancel');
  const manual = orcaEl('orcarouter-manual');
  if (connect) connect.disabled = busy;
  if (cancel) cancel.hidden = !busy;
  if (manual) manual.hidden = !busy;
  if (busy)
    orcaSetStatus(hint || 'Waiting for approval in your browser…', 'busy');
  else orcaSetStatus('', null);
}

async function orcaRequest(path, options = {}) {
  const response = await fetch(`${ORCA}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

function orcaRenderStatus(status) {
  const card = orcaEl('orcarouter-card');
  if (!card || !status) return;
  card.dataset.state = status.ready ? 'ready' : 'idle';
  card.removeAttribute('aria-busy');

  const chip = orcaEl('orcarouter-state');
  if (chip) {
    chip.textContent = status.ready
      ? `Connected · ${status.activeSource === 'oauth-pkce' ? 'Auth' : 'API key'}`
      : 'Not connected';
  }

  const apiChoice = orcaEl('orcarouter-choice-api');
  const authChoice = orcaEl('orcarouter-choice-auth');
  const apiAdapter = status.adapters?.find(
    (adapter) => adapter.id === 'orcarouter'
  );
  const authAdapter = status.adapters?.find(
    (adapter) => adapter.id === 'orcarouter-oauth'
  );
  const apiConfigured = !!apiAdapter?.configured;
  const authConfigured = !!authAdapter?.configured;
  const apiActive = !!apiAdapter?.active;
  const authActive = !!authAdapter?.active;
  if (apiChoice) {
    apiChoice.dataset.configured = String(apiConfigured);
    apiChoice.dataset.active = String(apiActive);
  }
  if (authChoice) {
    authChoice.dataset.configured = String(authConfigured);
    authChoice.dataset.active = String(authActive);
  }
  const apiFlag = orcaEl('orcarouter-flag-api');
  if (apiFlag) apiFlag.hidden = !apiActive;
  const authFlag = orcaEl('orcarouter-flag-auth');
  if (authFlag) authFlag.hidden = !authActive;

  const keyField = orcaEl('orcarouter-key');
  if (keyField) {
    // This adapter's own redacted value, not the active one's: with both choices configured the
    // placeholder must describe the key this field would replace.
    keyField.placeholder = apiConfigured
      ? `Stored: ${apiAdapter.masked || 'sk-orca-…'}`
      : 'sk-orca-…';
  }
  orcaEl('orcarouter-disconnect')?.toggleAttribute('disabled', !authConfigured);

  const note = orcaEl('orcarouter-note');
  if (note) {
    const origins = status.origins || {};
    note.textContent = status.ready
      ? `Inference and model discovery go to ${origins.apiBase}. Authorization goes to ${origins.authBase}. Manage or revoke this key at ${status.dashboardUrl}.`
      : `Not connected yet. Inference will use ${origins.apiBase || 'the OrcaRouter relay'} once either choice below is completed.`;
  }
}

/*
 * The model control.
 *
 * A LISTBOX BUILT FROM THE CATALOG, NOT A TEXT FIELD. The options come from
 * the server's catalog route, already filtered for the capability and the input
 * modality of the entry point being configured. There is no path by which a
 * name that is not in that list can be selected, which is the point: a free
 * text field is how an integration ends up advertising models nobody can call.
 *
 * A previously selected model is kept only while it is still in the returned
 * list. A modality switch can invalidate it, and silently keeping a value that
 * no longer fits sends a request the user did not choose.
 */
let orcaModels = [];
let orcaSelectedModel = '';

function orcaRenderModelList() {
  const list = orcaEl('orcarouter-model-list');
  const trigger = orcaEl('orcarouter-model-value');
  const note = orcaEl('orcarouter-model-panel-note');
  if (!list) return;
  const query = (orcaEl('orcarouter-model-search')?.value || '')
    .trim()
    .toLowerCase();
  const shown = orcaModels.filter(
    (model) =>
      !query ||
      model.id.toLowerCase().includes(query) ||
      String(model.name || '')
        .toLowerCase()
        .includes(query)
  );

  list.innerHTML = '';
  if (!shown.length) {
    const empty = document.createElement('li');
    empty.className = 'model-option is-empty';
    empty.textContent = orcaModels.length
      ? 'No model matches that search.'
      : 'No compatible model is offered for this entry point.';
    list.append(empty);
  }
  for (const model of shown) {
    const item = document.createElement('li');
    item.className = 'model-option';
    item.id = `orca-model-${model.id.replace(/[^A-Za-z0-9_-]/g, '-')}`;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(model.id === orcaSelectedModel));
    item.dataset.value = model.id;
    if (model.id === orcaSelectedModel) item.classList.add('is-selected');

    const name = document.createElement('span');
    name.className = 'model-option-name';
    name.textContent = model.name ? `${model.name}` : model.id;
    const id = document.createElement('span');
    id.className = 'model-option-id';
    id.textContent = model.id;
    item.append(name, id);

    const meta = [];
    if (model.contextLength)
      meta.push(`${Math.round(model.contextLength / 1000)}k context`);
    const nonText = model.inputModalities.filter((m) => m !== 'text');
    if (nonText.length) meta.push(`reads ${nonText.join(', ')}`);
    if (model.reasoningEfforts?.length)
      meta.push(`reasoning ${model.reasoningEfforts.join('/')}`);
    if (model.fromSeed) meta.push('verified fallback');
    if (meta.length) {
      const metaNode = document.createElement('span');
      metaNode.className = 'model-option-meta';
      metaNode.textContent = meta.join(' · ');
      item.append(metaNode);
    }

    item.addEventListener('click', () => {
      orcaSelectedModel = model.id;
      orcaCloseModelPanel();
      orcaRenderModelList();
      orcaSetStatus('', null);
    });
    list.append(item);
  }

  if (trigger) trigger.textContent = orcaSelectedModel || 'Not selected';
  if (note)
    note.textContent = `${shown.length} of ${orcaModels.length} compatible models`;
}

function orcaOpenModelPanel() {
  const panel = orcaEl('orcarouter-model-panel');
  const trigger = orcaEl('orcarouter-model');
  if (!panel || !trigger) return;
  panel.hidden = false;
  trigger.setAttribute('aria-expanded', 'true');
  orcaEl('orcarouter-model-search')?.focus();
}

function orcaCloseModelPanel() {
  const panel = orcaEl('orcarouter-model-panel');
  const trigger = orcaEl('orcarouter-model');
  if (!panel || !trigger) return;
  panel.hidden = true;
  trigger.setAttribute('aria-expanded', 'false');
  const search = orcaEl('orcarouter-model-search');
  if (search) search.value = '';
}

function orcaModelPanelOpen() {
  return orcaEl('orcarouter-model-panel')?.hidden === false;
}

async function orcaLoadModels({ reason } = {}) {
  const generation = orcaGeneration;
  const count = orcaEl('orcarouter-model-count');
  const modality = orcaEl('orcarouter-modality')?.value || 'text';
  if (reason === 'refresh' && count)
    count.textContent = 'Refreshing the catalog…';

  const query = new URLSearchParams({ capability: 'chat' });
  if (modality !== 'text') query.set('inputModality', modality);
  const result = await orcaRequest(`/models?${query.toString()}`);
  if (generation !== orcaGeneration) return;

  if (!result.ok || !result.body) {
    // Fail closed and say so. The list keeps its previous options rather than
    // becoming free text, and the reason is on screen.
    if (count)
      count.textContent =
        result.body?.error ||
        'The model catalog could not be reached, so the last known list is still shown.';
    return;
  }

  const previous = orcaSelectedModel;
  orcaModels = result.body.models || [];
  const stillOffered = orcaModels.some((model) => model.id === previous);
  if (!stillOffered) orcaSelectedModel = '';
  orcaRenderModelList();

  if (count) {
    const state = result.body.status === 'live' ? 'live' : 'degraded';
    count.textContent =
      `${orcaModels.length} compatible ${orcaModels.length === 1 ? 'model' : 'models'}` +
      ` (${state} catalog)`;
  }
  const note = orcaEl('orcarouter-note');
  if (note && result.body.status === 'degraded') {
    note.textContent = `${result.body.degradedReason} Showing the verified fallback list, which is marked as such.`;
  }
  if (previous && !stillOffered) {
    orcaSetStatus(
      'The model you had selected does not accept this input, so it was cleared. Choose another.',
      'error'
    );
  }
  return orcaSelectedModel;
}

async function orcaRefresh({ reason } = {}) {
  const status = await orcaRequest('/status');
  if (status.ok) orcaRenderStatus(status.body);
  await orcaLoadModels({ reason });
}

async function orcaSaveKey() {
  const field = orcaEl('orcarouter-key');
  const key = field?.value?.trim() || '';
  const generation = orcaGeneration;
  if (!key) {
    orcaSetStatus('Enter an OrcaRouter API key.', 'error');
    return;
  }
  const result = await orcaRequest('/key', {
    method: 'POST',
    body: JSON.stringify({ key }),
  });
  if (generation !== orcaGeneration) return;
  if (!result.ok) {
    orcaSetStatus(result.body?.error || 'That key was not accepted.', 'error');
    return;
  }
  // Cleared from the field the moment it is stored: a key left in an input is a
  // key in the next screenshot.
  if (field) field.value = '';
  orcaRenderStatus(result.body);
  orcaSetStatus('Key saved.', 'ok');
  await orcaLoadModels();
}

async function orcaClearKey() {
  const generation = orcaGeneration;
  const result = await orcaRequest('/key', { method: 'DELETE' });
  if (generation !== orcaGeneration) return;
  if (result.ok) {
    orcaRenderStatus(result.body);
    orcaSetStatus('Stored API key removed.', 'ok');
  }
}

/*
 * Start a login. Loopback first: this server is on the user's own machine, so a
 * 127.0.0.1 callback is always reachable and the user clicks once.
 */
async function orcaConnect() {
  orcaGeneration += 1;
  const generation = orcaGeneration;
  orcaSetBusy(true, 'Starting the OrcaRouter sign-in…');
  const result = await orcaRequest('/connect', {
    method: 'POST',
    body: JSON.stringify({ mode: 'loopback' }),
  });
  if (generation !== orcaGeneration) return;
  if (!result.ok || !result.body?.attemptId) {
    orcaSetBusy(false);
    orcaSetStatus(
      result.body?.error || 'Could not start the OrcaRouter sign-in.',
      'error'
    );
    return;
  }
  orcaAttemptId = result.body.attemptId;
  orcaAuthorizeUrl = result.body.authorizeUrl;
  orcaSetBusy(true, 'Waiting for approval in your browser…');
  window.open(result.body.authorizeUrl, '_blank', 'noopener,noreferrer');
  await orcaComplete();
}

async function orcaComplete() {
  if (!orcaAttemptId) return;
  const generation = orcaGeneration;
  const attemptId = orcaAttemptId;
  const result = await orcaRequest(`/connect/${attemptId}/complete`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  // A response that arrives after the generation moved on belongs to an attempt
  // the user already cancelled or replaced, so it must not install a credential
  // or clear the state of the attempt that is current.
  if (generation !== orcaGeneration) return;
  orcaAttemptId = null;
  orcaSetBusy(false);
  if (!result.ok) {
    orcaSetStatus(
      result.body?.error || 'The OrcaRouter sign-in did not complete.',
      'error'
    );
    return;
  }
  orcaRenderStatus(result.body.status);
  if (result.body.scopeDowngraded) {
    orcaSetStatus(
      `Connected, but the workspace granted "${result.body.scope || 'a narrower scope'}" rather than the scope requested.`,
      'error'
    );
  } else {
    orcaSetStatus('Connected with OrcaRouter.', 'ok');
  }
  await orcaLoadModels();
}

async function orcaSubmitCode() {
  const code = orcaEl('orcarouter-code')?.value?.trim() || '';
  if (!orcaAttemptId) {
    orcaSetStatus('Start a connection first.', 'error');
    return;
  }
  const result = await orcaRequest(`/connect/${orcaAttemptId}/code`, {
    method: 'POST',
    body: JSON.stringify({ code }),
  });
  if (!result.ok) {
    orcaSetStatus(result.body?.error || 'That code was not accepted.', 'error');
  }
}

/* Explicit cancel. Releases the server-side listener and the pending exchange. */
async function orcaCancel({ keepalive = false } = {}) {
  const attemptId = orcaAttemptId;
  orcaGeneration += 1;
  orcaAttemptId = null;
  orcaAuthorizeUrl = null;
  // Cleared BEFORE the request is awaited, because on `pagehide` there is no
  // later: the guarded continuation refuses to run, so a deferred clear would
  // leave a restored page permanently busy.
  orcaSetBusy(false);
  if (!attemptId) return;
  try {
    await fetch(`${ORCA}/connect/${attemptId}`, {
      method: 'DELETE',
      keepalive,
    });
  } catch {
    /* the page is going away; the server also drops the attempt on shutdown */
  }
}

async function orcaDisconnect() {
  orcaGeneration += 1;
  const result = await orcaRequest('/connect', { method: 'DELETE' });
  if (result.ok) {
    orcaRenderStatus(result.body);
    orcaSetStatus('OrcaRouter authorization removed.', 'ok');
  }
}

function orcaWire() {
  const card = orcaEl('orcarouter-card');
  if (!card) return;

  orcaEl('orcarouter-save')?.addEventListener('click', () => {
    void orcaSaveKey();
  });
  orcaEl('orcarouter-clear')?.addEventListener('click', () => {
    void orcaClearKey();
  });
  orcaEl('orcarouter-connect')?.addEventListener('click', () => {
    void orcaConnect();
  });
  orcaEl('orcarouter-cancel')?.addEventListener('click', () => {
    void orcaCancel();
  });
  orcaEl('orcarouter-disconnect')?.addEventListener('click', () => {
    void orcaDisconnect();
  });
  orcaEl('orcarouter-submit-code')?.addEventListener('click', () => {
    void orcaSubmitCode();
  });
  orcaEl('orcarouter-refresh')?.addEventListener('click', () => {
    void orcaLoadModels({ reason: 'refresh' });
  });
  // Switching what this entry point will send changes which models are
  // compatible, so the list is recomputed rather than filtered in place.
  orcaEl('orcarouter-modality')?.addEventListener('change', () => {
    orcaGeneration += 1;
    void orcaLoadModels();
  });
  orcaEl('orcarouter-key')?.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') void orcaSaveKey();
  });

  const modelTrigger = orcaEl('orcarouter-model');
  modelTrigger?.addEventListener('click', () => {
    if (orcaModelPanelOpen()) orcaCloseModelPanel();
    else orcaOpenModelPanel();
  });
  modelTrigger?.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Enter') {
      event.preventDefault();
      orcaOpenModelPanel();
    }
  });
  orcaEl('orcarouter-model-search')?.addEventListener('input', () => {
    orcaRenderModelList();
  });
  orcaEl('orcarouter-model-search')?.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      orcaCloseModelPanel();
      modelTrigger?.focus();
    }
  });
  // A click anywhere outside closes the panel, which is what a modal-free
  // dropdown is expected to do and what keeps the page from having two open
  // lists after a user moves on.
  document.addEventListener('click', (event) => {
    const box = orcaEl('orcarouter-model-combobox');
    if (!box || !orcaModelPanelOpen()) return;
    if (!box.contains(event.target)) orcaCloseModelPanel();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && orcaModelPanelOpen()) {
      orcaCloseModelPanel();
      modelTrigger?.focus();
    }
  });

  /*
   * THE BACK-FORWARD-CACHE CASE. The page can be put into the bfcache mid-login
   * and restored later, and the awaited continuation that would normally clear
   * the busy state is generation-guarded, so it will refuse. This handler
   * therefore clears the UI synchronously and asks the server to cancel with
   * `keepalive`, which is what makes a second login startable without a
   * remount.
   */
  window.addEventListener('pagehide', () => {
    if (orcaBusy || orcaAttemptId) void orcaCancel({ keepalive: true });
  });
  // An unmount cancels the server-side work but writes no UI state: there is no
  // page left to write to.
  window.addEventListener('beforeunload', () => {
    if (orcaAttemptId) void orcaCancel({ keepalive: true });
  });

  void orcaRefresh();
}

document.addEventListener('DOMContentLoaded', orcaWire);
