const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { JSDOM } = require('jsdom');

function setupPanelEnv(overrides = {}){
  const dom = new JSDOM('<!DOCTYPE html><body></body>', {
    pretendToBeVisual: true,
    url: overrides.url || 'https://example.com'
  });
  const { window } = dom;
  const customSetTimeout = typeof overrides.setTimeout === 'function' ? overrides.setTimeout : null;
  const customClearTimeout = typeof overrides.clearTimeout === 'function' ? overrides.clearTimeout : null;
  const sandbox = {
    window,
    document: window.document,
    console,
    Node: window.Node,
    Element: window.Element,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (cb)=>{ if (typeof cb === 'function') cb(); return 0; },
    cancelAnimationFrame: ()=>{},
    setTimeout: customSetTimeout || setTimeout,
    clearTimeout: customClearTimeout || clearTimeout,
    setInterval,
    clearInterval,
    performance: window.performance,
    confirm: ()=>true,
    InputEvent: window.InputEvent,
    Event: window.Event,
    MouseEvent: window.MouseEvent
  };
  sandbox.window.getSelection = window.getSelection.bind(window);
  sandbox.window.HTMLElement = window.HTMLElement;
  if (customSetTimeout){
    sandbox.window.setTimeout = customSetTimeout;
  }
  if (customClearTimeout){
    sandbox.window.clearTimeout = customClearTimeout;
  }
  sandbox.global = sandbox.window;
  sandbox.navigator = window.navigator;

  if (!window.ResizeObserver){
    class FakeResizeObserver{
      observe(){ }
      unobserve(){ }
      disconnect(){ }
    }
    window.ResizeObserver = FakeResizeObserver;
  }
  sandbox.ResizeObserver = window.ResizeObserver;
  if (!window.IntersectionObserver){
    class FakeIntersectionObserver{
      constructor(){ }
      observe(){ }
      unobserve(){ }
      disconnect(){ }
    }
    window.IntersectionObserver = FakeIntersectionObserver;
  }
  sandbox.IntersectionObserver = window.IntersectionObserver;

  const navigatorOverride = window.navigator;
  if (Object.prototype.hasOwnProperty.call(overrides, 'clipboard')){
    Object.defineProperty(navigatorOverride, 'clipboard', {
      value: overrides.clipboard,
      configurable: true,
      writable: true
    });
  } else {
    Object.defineProperty(navigatorOverride, 'clipboard', {
      value: { writeText: async ()=>{} },
      configurable: true,
      writable: true
    });
  }

  const execCommand = Object.prototype.hasOwnProperty.call(overrides, 'execCommand')
    ? overrides.execCommand
    : (()=>true);
  window.document.execCommand = execCommand;

  const storageState = { ...(overrides.initialLocalStorage || {}) };
  const storageGet = overrides.storageGet || (async ()=>({}));
  const storageSet = overrides.storageSet || (async ()=>{});
  const storageLocalGet = overrides.storageLocalGet || (async (keys)=>{
    if (!keys) return { ...storageState };
    const list = Array.isArray(keys) ? keys : [keys];
    const out = {};
    list.forEach((key) => {
      out[key] = storageState[key];
    });
    return out;
  });
  const storageLocalSet = overrides.storageLocalSet || (async (pairs)=>{
    Object.assign(storageState, pairs || {});
  });
  const sendMessageResponse = overrides.sendMessageResponse || {
    soft: 'Delikatna odpowiedz',
    brief: 'Rzeczowa odpowiedz',
    proactive: 'Proaktywna odpowiedz'
  };
  const quotaResponse = overrides.initialQuota ? { quota: overrides.initialQuota } : { quota: null };
  const sendMessageImpl = overrides.sendMessage || ((message, cb)=>{
    if (message && message.type === 'GET_QUOTA_STATUS'){
      if (typeof cb === 'function') cb(quotaResponse);
      return;
    }
    if (typeof cb === 'function') cb(sendMessageResponse);
  });
  const runtimeListeners = [];

  sandbox.chrome = {
    storage: {
      sync: { get: storageGet, set: storageSet },
      local: { get: storageLocalGet, set: storageLocalSet }
    },
    runtime: {
      lastError: null,
      sendMessage: sendMessageImpl,
      onMessage: {
        addListener: (fn) => {
          runtimeListeners.push(fn);
        }
      }
    }
  };

  const context = vm.createContext(sandbox);
  const readScript = (rel)=> fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

  new vm.Script(readScript('content/namespace.js'), { filename: 'namespace.js' }).runInContext(context);

  const { RC } = context.window;
  const cardMap = overrides.cardMap instanceof Map ? overrides.cardMap : new Map();
  RC.reviews = RC.reviews || {};
  if (overrides.reviews){
    Object.assign(RC.reviews, overrides.reviews);
  } else {
    RC.reviews.extractText = (card)=> card?.textContent || '';
    RC.reviews.extractRating = ()=> '';
  }
  RC.chips = RC.chips || {};
  RC.chips.findCardForHash = (hash)=> cardMap.get(hash) || null;

  new vm.Script(readScript('content/dom.js'), { filename: 'dom.js' }).runInContext(context);
  new vm.Script(readScript('content/place-context.js'), { filename: 'place-context.js' }).runInContext(context);

  const toasts = [];
  const domApi = RC.dom;
  domApi.showToast = (msg)=>{ toasts.push(msg); };
  if (overrides.findWritableField){
    domApi.findWritableField = overrides.findWritableField;
  }
  if (overrides.isElementVisible){
    domApi.isElementVisible = overrides.isElementVisible;
  }
  if (overrides.waitForCondition){
    domApi.waitForCondition = overrides.waitForCondition;
  }
  if (overrides.placeContext) {
    RC.placeContext = RC.placeContext || {};
    Object.assign(RC.placeContext, overrides.placeContext);
  }

  new vm.Script(readScript('content/panel.js'), { filename: 'panel.js' }).runInContext(context);

  return {
    panelApi: RC.panel,
    window: context.window,
    document: context.window.document,
    RC,
    dom: domApi,
    toasts,
    cardMap,
    runtimeListeners,
    storageState,
    reviews: RC.reviews,
    state: RC.state,
    flush: (ticks = 1)=> new Promise(resolve => {
      let remaining = ticks;
      const step = ()=>{
        if (--remaining <= 0){ resolve(); return; }
        setTimeout(step, 0);
      };
      setTimeout(step, 0);
    })
  };
}

describe('Panel Logic', () => {
  test('Panel renders options shortcut without inline context fields', async () => {
    const env = setupPanelEnv({
      sendMessageResponse: { soft: 'Wybrana delikatna', brief: 'Wybrana rzeczowa', proactive: 'Wybrana proaktywna' }
    });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'card-1';
    card.textContent = 'Pierwotna opinia klienta o dluzszej tresci';
    window.document.body.appendChild(card);
    reviews.extractText = ()=> 'Testowa opinia';
    reviews.extractRating = ()=> '5';

    await panelApi.openForCard(card, null);
    await env.flush();

    const wrap = window.document.querySelector('.rc-panel-wrap');
    expect(wrap).toBeTruthy();
    expect(wrap.querySelector('.rc-context')).toBeFalsy();
    expect(wrap.querySelector('#rc_place_type')).toBeFalsy();
    expect(wrap.querySelector('#rc_place_name')).toBeFalsy();
    expect(wrap.querySelector('#rc_options')).toBeTruthy();
    expect(wrap.querySelector('#rc_preview').textContent).toBe('Wybrana delikatna');
  });

  test('Options shortcut opens extension options page', async () => {
    const sentMessages = [];
    const env = setupPanelEnv({
      sendMessage: (message, cb) => {
        sentMessages.push(message);
        if (message?.type === 'GET_QUOTA_STATUS') {
          if (typeof cb === 'function') cb({ quota: null });
          return;
        }
        if (message?.type === 'OPEN_OPTIONS_PAGE') {
          if (typeof cb === 'function') cb({ ok: true });
          return;
        }
        if (typeof cb === 'function') {
          cb({ soft: 'A', brief: 'B', proactive: 'C' });
        }
      }
    });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'card-options';
    window.document.body.appendChild(card);
    reviews.extractText = () => 'Testowa opinia';
    reviews.extractRating = () => '5';

    await panelApi.openForCard(card, null);
    await env.flush(2);
    window.document.querySelector('#rc_options').click();

    expect(sentMessages.some(message => message?.type === 'OPEN_OPTIONS_PAGE')).toBe(true);
  });

  test('Panel shows unlimited quota without upgrade action', async () => {
    const unlimitedQuota = { type: 'unlimited', limit: -1, remaining: null, upgradeUrl: 'https://example.com/upgrade' };
    const env = setupPanelEnv({
      sendMessage: (message, cb) => {
        if (message?.type === 'GET_QUOTA_STATUS') {
          if (typeof cb === 'function') cb({ quota: unlimitedQuota });
          return;
        }
        if (typeof cb === 'function') {
          cb({ soft: 'A', brief: 'B', proactive: 'C', quota: unlimitedQuota });
        }
      }
    });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'unlimited-quota';
    window.document.body.appendChild(card);
    reviews.extractText = () => 'Bardzo dobra obsluga';
    reviews.extractRating = () => '5';

    await panelApi.openForCard(card, null, { autoGenerate: false });
    await env.flush(2);

    expect(window.document.querySelector('#rc_quota').textContent).toBe('Unlimited.');
    expect(window.document.querySelector('#rc_upgrade').style.display).toBe('none');
  });

  test('Panel includes detected place context in generate payload', async () => {
    const sentMessages = [];
    const env = setupPanelEnv({
      url: 'https://www.google.com/maps/place/Zielony+Piec/@50.0,19.0,17z/',
      sendMessage: (message, cb) => {
        sentMessages.push(message);
        if (message?.type === 'GET_QUOTA_STATUS') {
          if (typeof cb === 'function') cb({ quota: null });
          return;
        }
        if (typeof cb === 'function') {
          cb({ soft: 'A', brief: 'B', proactive: 'C' });
        }
      }
    });
    const { panelApi, window, reviews } = env;
    window.document.title = 'Zielony Piec · Restauracja - Google Maps';
    const heading = window.document.createElement('h1');
    heading.textContent = 'Zielony Piec';
    window.document.body.appendChild(heading);
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'card-ctx';
    card.textContent = 'Pierwotna opinia';
    window.document.body.appendChild(card);
    reviews.extractText = () => 'Swietna obsluga';
    reviews.extractRating = () => '5';

    await panelApi.openForCard(card, null);
    await env.flush(2);

    const generateMessage = sentMessages.find(message => message?.type === 'GENERATE_ALL');
    expect(generateMessage).toBeTruthy();
    expect(generateMessage.payload).toMatchObject({
      rating: '5',
      text: 'Swietna obsluga',
      placeType: 'Restauracja',
      placeName: 'Zielony Piec'
    });
    expect(generateMessage.payload.placeKey).toContain('place:zielony-piec');
  });

  test('Panel opens immediately on first click even when place context resolves slowly', async () => {
    let resolveContext;
    const sentMessages = [];
    const env = setupPanelEnv({
      sendMessage: (message, cb) => {
        sentMessages.push(message);
        if (message?.type === 'GET_QUOTA_STATUS') {
          if (typeof cb === 'function') cb({ quota: null });
          return;
        }
        if (typeof cb === 'function') {
          cb({ soft: 'A', brief: 'B', proactive: 'C' });
        }
      },
      placeContext: {
        resolveContextForPage: () => new Promise((resolve) => {
          resolveContext = resolve;
        })
      }
    });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'slow-card';
    window.document.body.appendChild(card);
    reviews.extractText = () => 'Opinia testowa';
    reviews.extractRating = () => '5';

    const openPromise = panelApi.openForCard(card, null);
    const wrap = window.document.querySelector('.rc-panel-wrap');
    expect(wrap).toBeTruthy();
    expect(window.document.querySelector('#rc_preview')).toBeTruthy();
    expect(sentMessages.some(message => message?.type === 'GENERATE_ALL')).toBe(false);

    resolveContext({
      placeKey: 'place:test',
      placeType: 'salon fryzjerski',
      placeName: 'Nozyczki',
      source: 'detected'
    });
    await openPromise;
    await env.flush(2);

    expect(sentMessages.some(message => message?.type === 'GENERATE_ALL')).toBe(true);
  });

  test('Saved options place context is reused on regenerate', async () => {
    const sentMessages = [];
    const env = setupPanelEnv({
      url: 'https://www.google.com/maps/place/Studio+Szkla/',
      initialLocalStorage: {
        rcBusinessContext: {
          placeType: 'szklarstwo',
          placeName: 'Studio Szkla Krakow',
          replyGuidelines: 'Nie proponuj rabatow.',
          source: 'options'
        }
      },
      sendMessage: (message, cb) => {
        sentMessages.push(message);
        if (message?.type === 'GET_QUOTA_STATUS') {
          if (typeof cb === 'function') cb({ quota: null });
          return;
        }
        if (typeof cb === 'function') {
          cb({ soft: 'A', brief: 'B', proactive: 'C' });
        }
      }
    });
    const { panelApi, window, reviews, storageState } = env;
    window.document.title = 'Studio Szkla - Google Maps';
    const heading = window.document.createElement('h1');
    heading.textContent = 'Studio Szkla';
    window.document.body.appendChild(heading);
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'card-manual';
    window.document.body.appendChild(card);
    reviews.extractText = () => 'Dziekujemy';
    reviews.extractRating = () => '4';

    await panelApi.openForCard(card, null);
    await env.flush(2);

    expect(storageState.rcPlaceContextByKey).toBeUndefined();

    window.document.querySelector('#rc_regen').click();
    await env.flush(2);

    const generateMessages = sentMessages.filter(message => message?.type === 'GENERATE_ALL');
    expect(generateMessages.at(-1).payload).toMatchObject({
      placeType: 'szklarstwo',
      placeName: 'Studio Szkla Krakow',
      replyGuidelines: 'Nie proponuj rabatow.',
      rating: '4',
      text: 'Dziekujemy'
    });
  });

  test('CopyToClipboard uses navigator', async () => {
    const writes = [];
    const env = setupPanelEnv({ clipboard: { writeText: async (value)=> writes.push(value) } });
    await env.window.navigator.clipboard.writeText('Manual');
    expect(writes).toEqual(['Manual']);
    writes.length = 0;
    const ok = await env.panelApi.copyToClipboard('Skopiuj to prosze');
    expect(ok).toBe(true);
    expect(writes).toEqual(['Skopiuj to prosze']);
  });

  test('CopyToClipboard fallback success', async () => {
    const calls = [];
    const env = setupPanelEnv({ clipboard: undefined, execCommand: (cmd)=>{ calls.push(cmd); return true; } });
    const before = env.document.querySelectorAll('textarea').length;
    const ok = await env.panelApi.copyToClipboard('Fallback kopiowanie');
    const after = env.document.querySelectorAll('textarea').length;
    expect(ok).toBe(true);
    expect(calls).toEqual(['copy']);
    expect(after).toBe(before);
  });

  test('CopyToClipboard fallback failure', async () => {
    const env = setupPanelEnv({ clipboard: undefined, execCommand: ()=>false });
    const ok = await env.panelApi.copyToClipboard('Nie skopiuje');
    expect(ok).toBe(false);
  });

  test('CopyToClipboard empty', async () => {
    const env = setupPanelEnv();
    const ok = await env.panelApi.copyToClipboard('');
    expect(ok).toBe(false);
  });

  test('OpenReplyPopup inline field', async () => {
    const env = setupPanelEnv();
    const { window, panelApi, state } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-inline';
    const field = window.document.createElement('textarea');
    card.appendChild(field);
    window.document.body.appendChild(card);
    env.cardMap.set('hash-inline', card);
    state.currentPanel = { updatePositionTargets: ()=>{} };
    let focused = null;
    const originalFocus = panelApi.focusReplyField;
    panelApi.focusReplyField = function(target){
      focused = target;
      return originalFocus.call(this, target);
    };

    await panelApi.openReplyPopup('hash-inline', null);

    expect(focused).toBe(field);
  });

  test('OpenReplyPopup with dialog wait', async () => {
    const env = setupPanelEnv();
    const { window, panelApi, RC, state } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-dialog';
    const reply = window.document.createElement('button');
    reply.textContent = 'Odpowiedz';
    card.appendChild(reply);
    window.document.body.appendChild(card);
    env.cardMap.set('hash-dialog', card);

    const dialog = window.document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    const dialogField = window.document.createElement('textarea');
    dialog.appendChild(dialogField);
    window.document.body.appendChild(dialog);

    RC.dom.findWritableField = (root)=>{
      if (root === card) return null;
      if (root === dialog) return dialogField;
      return null;
    };
    RC.dom.isElementVisible = ()=> true;
    RC.dom.waitForCondition = async (check)=>
      check() || { root: dialog, anchor: dialogField };

    const updates = [];
    state.currentPanel = { updatePositionTargets: (...args)=> updates.push(args) };
    let focusCall = null;
    const originalFocus = panelApi.focusReplyField;
    panelApi.focusReplyField = function(target, allowHidden){
      focusCall = { target, allowHidden };
      return originalFocus.call(this, target, allowHidden);
    };

    await panelApi.openReplyPopup('hash-dialog', null);

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0][0]).toBe(dialog);
    expect(updates[0][1]).toBe(dialogField);
    expect(focusCall).toEqual({ target: dialog, allowHidden: true });
  });

  test('OpenReplyPopup no card', async () => {
    const env = setupPanelEnv();
    const { panelApi, toasts } = env;
    await panelApi.openReplyPopup('missing-hash', null);
    expect(toasts).toEqual(['I cannot find the review. Try again.']);
  });

  test('OpenReplyPopup timeout', async () => {
    const env = setupPanelEnv({ findWritableField: ()=>null, waitForCondition: async ()=> null });
    const { window, panelApi, state, toasts } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-timeout';
    window.document.body.appendChild(card);
    env.cardMap.set('hash-timeout', card);
    state.currentPanel = { updatePositionTargets: ()=>{} };

    await panelApi.openReplyPopup('hash-timeout', null);
    expect(toasts).toEqual(['I cannot open the reply field. Open it manually and paste the reply.']);
  });

  test('FocusReplyField without input', async () => {
    const env = setupPanelEnv({ findWritableField: ()=>null });
    const { window, panelApi, toasts } = env;
    const root = window.document.createElement('div');
    await panelApi.focusReplyField(root);
    expect(toasts).toEqual(['I cannot see the reply field in the window.']);
  });

  test('CopyButton no variant', async () => {
    const env = setupPanelEnv({ sendMessageResponse: { soft: '', brief: '', proactive: '' } });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-empty';
    window.document.body.appendChild(card);
    reviews.extractText = ()=> 'Testowa opinia';

    await panelApi.openForCard(card, null);
    await env.flush();

    const button = window.document.querySelector('#rc_copy');
    expect(button).toBeTruthy();
    await button.onclick();
    const err = window.document.querySelector('#rc_err');
    expect(err.textContent).toBe('There is no text to copy.');
  });

  test('CopyButton copy failure', async () => {
    const env = setupPanelEnv();
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-fail';
    window.document.body.appendChild(card);
    reviews.extractText = ()=> 'Testowa opinia';

    await panelApi.openForCard(card, null);
    await env.flush();

    panelApi.copyToClipboard = async ()=> false;
    panelApi.openReplyPopup = async ()=>{ throw new Error('nie powinno wywolac openReplyPopup przy bledzie kopiowania'); };

    const button = window.document.querySelector('#rc_copy');
    await button.onclick();
    const err = window.document.querySelector('#rc_err');
    expect(err.textContent).toBe('Could not copy the text.');
  });

  test('CopyButton success triggers popup', async () => {
    const env = setupPanelEnv({ sendMessageResponse: { soft: 'Odpowiedz A', brief: 'Odpowiedz B', proactive: 'Odpowiedz C' } });
    const { panelApi, window, reviews, state, toasts } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'hash-success';
    window.document.body.appendChild(card);
    env.cardMap.set('hash-success', card);
    state.currentPanel = { dataset: { rcTarget: 'hash-success' } };
    reviews.extractText = ()=> 'Dluga opinia klienta';

    await panelApi.openForCard(card, null);
    await env.flush();

    let calledWith = null;
    panelApi.copyToClipboard = async ()=> true;
    panelApi.openReplyPopup = async (...args)=>{ calledWith = args; };

    const button = window.document.querySelector('#rc_copy');
    await button.onclick();

    const err = window.document.querySelector('#rc_err');
    expect(err.textContent).toBe('');
    expect(toasts).toEqual(['Copied to clipboard.']);
    expect(calledWith).toBeTruthy();
    expect(calledWith[0]).toBe('hash-success');
    expect(calledWith[1]).toBe(card);
    expect(calledWith[2].suppressWarnings).toBe(true);
  });

  test('AUTH_REQUIRED shows only login action and opens extension options', async () => {
    const sentMessages = [];
    const env = setupPanelEnv({
      sendMessage: (message, cb) => {
        sentMessages.push(message);
        if (message?.type === 'GET_QUOTA_STATUS') {
          if (typeof cb === 'function') cb({ quota: null });
          return;
        }
        if (message?.type === 'GET_AUTH_STATUS') {
          if (typeof cb === 'function') cb({ profile: null });
          return;
        }
        if (message?.type === 'OPEN_LOGIN_PAGE') {
          if (typeof cb === 'function') cb({ ok: true });
          return;
        }
        if (typeof cb === 'function') {
          cb({
            error: 'Sesja wygasla. Zaloguj sie ponownie w rozszerzeniu.',
            errorCode: 'AUTH_REQUIRED'
          });
        }
      }
    });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'auth-required';
    window.document.body.appendChild(card);
    reviews.extractText = () => 'Testowa opinia';
    reviews.extractRating = () => '5';

    await panelApi.openForCard(card, null);
    await env.flush(2);

    const err = window.document.querySelector('#rc_err');
    const loginBtn = window.document.querySelector('#rc_login');
    const copyBtn = window.document.querySelector('#rc_copy');
    const regenBtn = window.document.querySelector('#rc_regen');
    const upgradeBtn = window.document.querySelector('#rc_upgrade');
    const closeBtn = window.document.querySelector('#rc_close');
    const note = window.document.querySelector('.rc-note');
    const preview = window.document.querySelector('#rc_preview');
    expect(err.textContent).toBe('Sesja wygasla. Zaloguj sie ponownie w rozszerzeniu.');
    expect(preview.textContent).toBe('Sign in to generate a reply.');
    expect(loginBtn).toBeTruthy();
    expect(loginBtn.style.display).toBe('inline-flex');
    expect(copyBtn.style.display).toBe('none');
    expect(regenBtn.style.display).toBe('none');
    expect(upgradeBtn.style.display).toBe('none');
    expect(note.style.display).toBe('none');
    expect(closeBtn.style.display).not.toBe('none');

    loginBtn.click();

    expect(sentMessages.some(message => message?.type === 'OPEN_LOGIN_PAGE')).toBe(true);
  });

  test('AUTH_STATUS_CHANGED restores panel actions without consuming quota after login', async () => {
    const sentMessages = [];
    const env = setupPanelEnv({
      sendMessage: (message, cb) => {
        sentMessages.push(message);
        if (message?.type === 'GET_QUOTA_STATUS') {
          if (typeof cb === 'function') cb({ quota: null });
          return;
        }
        if (message?.type === 'GET_AUTH_STATUS') {
          if (typeof cb === 'function') cb({ profile: null });
          return;
        }
        if (message?.type === 'GENERATE_ALL' && sentMessages.filter(item => item?.type === 'GENERATE_ALL').length === 1) {
          if (typeof cb === 'function') {
            cb({
              error: 'Sesja wygasla. Zaloguj sie ponownie w rozszerzeniu.',
              errorCode: 'AUTH_REQUIRED'
            });
          }
          return;
        }
        if (message?.type === 'GENERATE_ALL') {
          if (typeof cb === 'function') {
            cb({
              soft: 'Nowa delikatna',
              brief: 'Nowa rzeczowa',
              proactive: 'Nowa proaktywna',
              quota: { type: 'usage', limit: 100, remaining: 99 }
            });
          }
          return;
        }
        if (typeof cb === 'function') cb({ ok: true });
      }
    });
    const { panelApi, window, reviews, runtimeListeners } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'auth-refresh';
    window.document.body.appendChild(card);
    reviews.extractText = () => 'Testowa opinia';
    reviews.extractRating = () => '5';

    await panelApi.openForCard(card, null);
    await env.flush(2);

    const panelEl = window.document.querySelector('.rc-panel');
    expect(panelEl.dataset.rcAuthRequired).toBe('true');
    expect(window.document.querySelector('#rc_login').style.display).toBe('inline-flex');

    runtimeListeners.forEach(listener => listener({
      type: 'AUTH_STATUS_CHANGED',
      reason: 'login',
      profile: { email: 'owner@example.com' },
      quota: { type: 'usage', limit: 100, remaining: 99 }
    }));
    await env.flush(2);

    expect(panelEl.dataset.rcAuthRequired).toBe('false');
    expect(window.document.querySelector('#rc_login').style.display).toBe('none');
    expect(window.document.querySelector('#rc_copy').style.display).toBe('inline-flex');
    expect(window.document.querySelector('#rc_preview').textContent).toBe('Signed in. Click Regenerate to generate a reply.');
    expect(sentMessages.filter(message => message?.type === 'GENERATE_ALL')).toHaveLength(1);
  });

  test('GenerateReplies shows timeout error when worker stays silent', async () => {
    const timerQueue = [];
    const fakeTimeout = (cb)=>{
      timerQueue.push(cb);
      return timerQueue.length;
    };
    const fakeClearTimeout = (id)=>{
      const idx = Number(id) - 1;
      if (idx >= 0 && idx < timerQueue.length){
        timerQueue[idx] = null;
      }
    };
    const env = setupPanelEnv({
      sendMessage: (message, cb)=>{
        if (message?.type === 'GET_QUOTA_STATUS'){
          if (typeof cb === 'function') cb({ quota: null });
        }
      },
      setTimeout: fakeTimeout,
      clearTimeout: fakeClearTimeout
    });
    const { panelApi, window, reviews } = env;
    const card = window.document.createElement('div');
    card.dataset.rcHash = 'silent-hash';
    window.document.body.appendChild(card);
    reviews.extractText = ()=> 'Klient nie odpowiedzial';
    reviews.extractRating = ()=> '4';

    await panelApi.openForCard(card, null);
    await env.flush();

    timerQueue.forEach((cb, idx)=>{
      if (typeof cb === 'function'){
        cb();
        timerQueue[idx] = null;
      }
    });

    const err = window.document.querySelector('#rc_err');
    expect(err.textContent).toBe('The generation service did not respond. Try again.');
    const preview = window.document.querySelector('#rc_preview');
    expect(preview.textContent).toBe('...');
  });
});
