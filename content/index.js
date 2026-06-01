(function bootstrap(global){
  const RC = global.RC;
  const { state, dom, scan } = RC;

  function ensureRouteWatcher(){
    if (state.handlers.routeChange) return;
    let routeTimerId = 0;
    state.lastRouteHref = String(global.location?.href || '');

    const scheduleBootstrap = () => {
      if (routeTimerId) clearTimeout(routeTimerId);
      routeTimerId = setTimeout(()=>{
        routeTimerId = 0;
        bootstrap(global);
      }, 80);
    };

    const handler = () => {
      state.lastRouteHref = String(global.location?.href || '');
      scheduleBootstrap();
    };

    const checkHref = () => {
      const href = String(global.location?.href || '');
      if (href === state.lastRouteHref) return;
      state.lastRouteHref = href;
      scheduleBootstrap();
    };

    window.addEventListener('hashchange', handler);
    window.addEventListener('popstate', handler);
    const intervalId = setInterval(checkHref, 1000);
    state.handlers.routeChange = { handler, intervalId };
  }

  function teardown(){
    if (state.mutationObserver){
      try { state.mutationObserver.disconnect(); } catch (_){ }
      state.mutationObserver = null;
    }
    if (state.handlers.scroll){
      try { window.removeEventListener('scroll', state.handlers.scroll); } catch (_){ }
      delete state.handlers.scroll;
    }
    if (state.handlers.resize){
      try { window.removeEventListener('resize', state.handlers.resize); } catch (_){ }
      delete state.handlers.resize;
    }
    if (state.handlers.visibility){
      try { document.removeEventListener('visibilitychange', state.handlers.visibility); } catch (_){ }
      delete state.handlers.visibility;
    }
    if (state.handlers.pointerDown){
      try { document.removeEventListener('pointerdown', state.handlers.pointerDown); } catch (_){ }
      delete state.handlers.pointerDown;
    }
    if (state.scanIntervalId){
      try { clearInterval(state.scanIntervalId); } catch (_){ }
      state.scanIntervalId = 0;
    }
    if (state.scanTimerId){
      try { clearTimeout(state.scanTimerId); } catch (_){ }
      state.scanTimerId = 0;
    }
    state.scanPending = false;
    state.initialized = false;
  }

  ensureRouteWatcher();

  const supportedPage = !(RC.pages && typeof RC.pages.isSupportedPage === 'function') || RC.pages.isSupportedPage();
  RC.debug?.log?.('bootstrap', {
    href: String(global.location?.href || ''),
    supportedPage
  });

  if (!supportedPage){
    teardown();
    RC.debug?.log?.('teardown', { reason: 'unsupported-page' });
    return;
  }

  if (state.mutationObserver){
    try { state.mutationObserver.disconnect(); } catch (_){ }
  }
  const observer = new MutationObserver(()=> scan.queue());
  observer.observe(document, { childList: true, subtree: true });
  state.mutationObserver = observer;

  if (!state.handlers.scroll){
    const handler = ()=> scan.queue();
    window.addEventListener('scroll', handler, { passive: true });
    state.handlers.scroll = handler;
  }

  if (!state.handlers.resize){
    const handler = ()=> scan.queue();
    window.addEventListener('resize', handler);
    state.handlers.resize = handler;
  }

  if (!state.handlers.visibility){
    const handler = ()=>{ if (!document.hidden) scan.queue(true); };
    document.addEventListener('visibilitychange', handler);
    state.handlers.visibility = handler;
  }

  if (!state.handlers.pointerDown){
    const handler = (event)=>{
      if (!state.currentPanel) return;
      const btn = event.target.closest('button, [role="button"]');
      if (!btn) return;
      if (state.currentPanel.contains(btn)) return;
      if (btn.classList?.contains('rc-chip-btn')) return;
      const text = (btn.textContent || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
      if (/(odpowiedz|reply|respond)/.test(text)){
        dom.closeCurrentPanel();
      }
    };
    document.addEventListener('pointerdown', handler);
    state.handlers.pointerDown = handler;
  }

  if (!state.scanIntervalId){
    state.scanIntervalId = setInterval(()=> scan.queue(), 2800);
  }

  state.initialized = true;
  scan.queue(true);
})(window);
