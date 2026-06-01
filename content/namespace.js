(function initNamespace(global){
  const RC = global.RC = global.RC || {};

  RC.t = RC.t || function translate(key, fallback = '', substitutions) {
    try {
      const message = chrome?.i18n?.getMessage?.(key, substitutions);
      if (message) return message;
    } catch (_) { }
    return fallback || key;
  };

  const state = RC.state = RC.state || {};
  if (typeof state.panelId === 'undefined') state.panelId = 'rc-panel';
  if (typeof state.currentPanel === 'undefined') state.currentPanel = null;
  if (typeof state.currentPanelCleanup === 'undefined') state.currentPanelCleanup = null;
  if (!state.chipRegistry) state.chipRegistry = new Map();
  if (typeof state.throttleMs === 'undefined') state.throttleMs = 400;
  if (typeof state.lastScanRun === 'undefined') state.lastScanRun = 0;
  if (typeof state.scanPending === 'undefined') state.scanPending = false;
  if (typeof state.scanTimerId === 'undefined') state.scanTimerId = 0;
  if (typeof state.scanIntervalId === 'undefined') state.scanIntervalId = 0;
  if (!state.handlers) state.handlers = {};
  if (typeof state.initialized === 'undefined') state.initialized = false;
  if (!state.placeContextCache) state.placeContextCache = null;

  const config = RC.config = RC.config || {};
  if (typeof config.minReviewLength === 'undefined') config.minReviewLength = 16;
  config.storageKeys = config.storageKeys || {
    reviewText: 'rcReviewText',
    rating: 'rcRating',
    placeContextMap: 'rcPlaceContextByKey',
    businessContext: 'rcBusinessContext'
  };
  config.selectors = config.selectors || {
    cards: '[role="article"], [data-review-id], [data-reviewid], div[aria-label*="review"], div.hxVHQb',
    textInputs: 'textarea, [contenteditable="true"], input[type="text"]'
  };
  config.reviewSelectors = config.reviewSelectors || [
    '[data-reviewid]',
    '[data-review-id]',
    '[data-review-text]',
    '[itemprop="reviewBody"]',
    '[jsname="fb90Dc"]',
    '[jsname="bN97Pc"]',
    '.ODSEW-ShBeI-text',
    '.ODSEW-ShBeI-fg9Q2e',
    '.ODSEW-ShBeI-jS0Naf',
    '.ODSEW-ShBeI-T3o0Zc',
    '.review-full-text',
    '.review-snippet'
  ];
  config.blockedNormalizedText = config.blockedNormalizedText || [
    'podpowiedz odpowiedz',
    'podpowiedz odpowied',
    'dodaj odpowiedz',
    'dodaj odpowied',
    'edytuj odpowiedz',
    'edytuj odpowied',
    'napisz odpowiedz',
    'napisz odpowied',
    'odpowiedz opublikowana',
    'polubione przez wlasciciela',
    'liked by owner',
    'liked by the owner',
    'liked by business owner',
    'zglos recenz'
  ];
  config.ratingAriaSelectors = config.ratingAriaSelectors || [
    '[aria-label*="stars"]',
    '[aria-label*="gwiaz"]',
    '[aria-label*="ocena"]',
    '[aria-label*="Ocena"]',
    '[aria-label*="rating"]',
    '[aria-label*="Rating"]'
  ];
  config.ratingAttrNames = config.ratingAttrNames || [
    'data-rating',
    'data-star-rating',
    'data-rating-score',
    'data-initial-rating'
  ];

  const pages = RC.pages = RC.pages || {};

  function isGoogleHost(hostname){
    return /(^|\.)google\.(com|pl)$/i.test(hostname || '');
  }

  function isGoogleMapsPath(pathname){
    return pathname === '/maps' || pathname.startsWith('/maps/');
  }

  pages.isSupportedPage = function isSupportedPage(locationLike = global.location){
    try {
      const url = new URL(String(locationLike?.href || ''), global.location?.href || 'https://www.google.com/');
      const hostname = url.hostname.toLowerCase();
      const pathname = url.pathname.toLowerCase();
      const hash = decodeURIComponent(url.hash || '').toLowerCase();

      if (isGoogleHost(hostname) && isGoogleMapsPath(pathname)) return true;
      if (hostname === 'business.google.com' && /\/(?:customers\/reviews|reviews)(?:\/|$)/.test(pathname + hash)) return true;
      if (isGoogleHost(hostname) && pathname === '/search' && /\/customers\/reviews(?:\/|$)/.test(hash)) return true;
    } catch (_){ }
    return false;
  };

  const debug = RC.debug = RC.debug || {};

  debug.isEnabled = function isEnabled(){
    try {
      if (global.localStorage?.getItem('rcDebug') === '1') return true;
      const url = new URL(String(global.location?.href || ''));
      return url.searchParams.get('rcdebug') === '1';
    } catch (_){
      return false;
    }
  };

  function renderDebugOverlay(){
    if (!debug.isEnabled()) return;
    if (!document.body) return;
    let el = document.getElementById('rc_debug_overlay');
    if (!el){
      el = document.createElement('pre');
      el.id = 'rc_debug_overlay';
      el.setAttribute('aria-live', 'polite');
      el.style.cssText = [
        'position:fixed',
        'left:12px',
        'bottom:12px',
        'z-index:2147483647',
        'max-width:min(640px,calc(100vw - 24px))',
        'max-height:45vh',
        'overflow:auto',
        'padding:10px 12px',
        'margin:0',
        'border:1px solid #2563eb',
        'border-radius:8px',
        'background:#0f172a',
        'color:#dbeafe',
        'font:12px/1.45 ui-monospace,SFMono-Regular,Consolas,monospace',
        'white-space:pre-wrap',
        'box-shadow:0 16px 40px rgba(15,23,42,.35)',
        'pointer-events:auto'
      ].join(';');
      document.body.appendChild(el);
    }
    const snapshot = debug.snapshot || {};
    el.textContent = `Reviews Coach debug\n${JSON.stringify(snapshot, null, 2)}`;
  }

  debug.log = function log(stage, data = {}){
    if (!debug.isEnabled()) return;
    debug.snapshot = {
      ...(debug.snapshot || {}),
      stage,
      updatedAt: new Date().toISOString(),
      [stage]: data
    };
    try { console.info('[RC_DEBUG]', stage, data); } catch (_){ }
    try { renderDebugOverlay(); } catch (_){ }
  };
})(window);
