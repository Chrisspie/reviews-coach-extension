(function initPanel(global) {
  const RC = global.RC;
  const { state, dom, reviews, chips, placeContext: placeContextApi = {} } = RC;
  const t = RC.t || ((key, fallback, substitutions) => fallback || key);
  const panelApi = RC.panel = RC.panel || {};

  panelApi.openForCard = async function openForCard(card, anchor) {
    if (!card) return;
    const root = dom.ensureRoot();
    dom.closeCurrentPanel();

    const wrap = document.createElement('div');
    wrap.className = 'rc-panel-wrap';
    wrap.dataset.rcTarget = card.dataset.rcHash || '';

    const panelEl = document.createElement('div');
    panelEl.className = state.panelId;
    wrap.appendChild(panelEl);
    root.appendChild(wrap);
    state.currentPanel = wrap;

    const reviewSource = {
      text: (card.dataset.rcReviewText || reviews.extractText(card) || '').trim(),
      rating: (card.dataset.rcRating || reviews.extractRating(card) || '').toString().trim()
    };
    card.dataset.rcReviewText = reviewSource.text;
    card.dataset.rcRating = reviewSource.rating;

    const margin = 16;
    let raf = 0;
    const position = { target: card, anchor };
    const scrollListeners = [];

    const repositionNow = () => {
      const ref = (position.target && position.target.isConnected) ? position.target : card;
      if (!ref || !document.body.contains(ref)) {
        dom.closeCurrentPanel();
        return;
      }
      const rect = ref.getBoundingClientRect();
      if (!rect.width && !rect.height) return;
      const anchorSource = (position.anchor && position.anchor.isConnected && position.anchor.getBoundingClientRect)
        ? position.anchor
        : ref;
      const anchorRect = anchorSource.getBoundingClientRect ? anchorSource.getBoundingClientRect() : rect;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const panelRect = panelEl.getBoundingClientRect();
      const mode = wrap.dataset.rcMode || 'card';
      let left;
      let top;
      if (mode === 'dialog') {
        left = anchorRect.left;
        if (left + panelRect.width + margin > viewportWidth) { left = viewportWidth - panelRect.width - margin; }
        if (left < margin) left = margin;
        top = anchorRect.bottom + margin;
        if (top + panelRect.height + margin > viewportHeight) {
          top = Math.max(margin, anchorRect.top - panelRect.height - margin);
        }
      } else {
        left = anchorRect.right + margin;
        if (left + panelRect.width + margin > viewportWidth) {
          left = rect.left - panelRect.width - margin;
          if (left < margin) { left = Math.max(margin, viewportWidth - panelRect.width - margin); }
        }
        top = Math.min(rect.top, anchorRect.top);
        const maxTop = viewportHeight - panelRect.height - margin;
        top = Math.min(Math.max(margin, top), Math.max(margin, maxTop));
      }
      wrap.style.top = `${Math.round(top)}px`;
      wrap.style.left = `${Math.round(left)}px`;
    };

    const scheduleReposition = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        repositionNow();
      });
    };

    const onWindowResize = () => scheduleReposition();
    const resizeObserver = window.ResizeObserver ? new ResizeObserver(() => scheduleReposition()) : null;
    const intersectionObserver = window.IntersectionObserver ? new IntersectionObserver(() => scheduleReposition(), { threshold: [0, 0.5, 1] }) : null;

    const resetObservers = () => {
      while (scrollListeners.length) {
        const { node, handler } = scrollListeners.pop();
        try { node.removeEventListener('scroll', handler); } catch (_) { }
      }
      const nodesToTrack = new Set();
      if (position.target && position.target.isConnected) dom.getScrollParents(position.target).forEach(n => nodesToTrack.add(n));
      if (position.anchor && position.anchor.isConnected) dom.getScrollParents(position.anchor).forEach(n => nodesToTrack.add(n));
      if (!nodesToTrack.size) nodesToTrack.add(window);
      nodesToTrack.forEach(node => {
        if (!node) return;
        const handler = () => scheduleReposition();
        try { node.addEventListener('scroll', handler, { passive: true }); }
        catch (_) { try { node.addEventListener('scroll', handler); } catch (__) { } }
        scrollListeners.push({ node, handler });
      });
      if (resizeObserver) {
        resizeObserver.disconnect();
        [position.target, position.anchor, panelEl].forEach(el => {
          if (el && el.isConnected) {
            try { resizeObserver.observe(el); } catch (_) { }
          }
        });
      }
      if (intersectionObserver) {
        intersectionObserver.disconnect();
        [position.target, position.anchor].forEach(el => {
          if (el && el.isConnected) {
            try { intersectionObserver.observe(el); } catch (_) { }
          }
        });
      }
    };

    const cleanup = () => {
      while (scrollListeners.length) {
        const { node, handler } = scrollListeners.pop();
        try { node.removeEventListener('scroll', handler); } catch (_) { }
      }
      window.removeEventListener('resize', onWindowResize);
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      resizeObserver?.disconnect?.();
      intersectionObserver?.disconnect?.();
      if (state.currentPanel === wrap) state.currentPanel = null;
      state.currentPanelCleanup = null;
      if (wrap.parentElement) wrap.parentElement.removeChild(wrap);
    };

    state.currentPanelCleanup = cleanup;
    wrap.reposition = scheduleReposition;
    wrap.updatePositionTargets = (target, anchorEl) => {
      if (target && target.isConnected) position.target = target;
      if (anchorEl && anchorEl.isConnected) position.anchor = anchorEl;
      const isDialog = position.target && (position.target.getAttribute?.('role') === 'dialog' || position.target.getAttribute?.('aria-modal') === 'true');
      if (isDialog) wrap.dataset.rcMode = 'dialog';
      else delete wrap.dataset.rcMode;
      resetObservers();
      scheduleReposition();
    };

    window.addEventListener('resize', onWindowResize);
    resetObservers();
    repositionNow();

    try {
      if (!wrap.isConnected || state.currentPanel !== wrap) return;
      const emptyPlaceContext = {
        placeKey: '',
        placeName: '',
        placeType: '',
        replyGuidelines: '',
        detectedPlaceName: '',
        detectedPlaceType: '',
        source: 'none'
      };
      renderMainPanel(panelEl, card, reviewSource, emptyPlaceContext, { autoGenerate: false });
      let resolvedPlaceContext = emptyPlaceContext;
      if (typeof placeContextApi.resolveContextForPage === 'function') {
        try {
          resolvedPlaceContext = await placeContextApi.resolveContextForPage();
        } catch (contextErr) {
          console.warn('[RC] Nie udalo sie odczytac kontekstu miejsca', contextErr);
        }
      }
      if (!wrap.isConnected || state.currentPanel !== wrap || !panelEl.isConnected) return;
      applyPlaceContextToPanel(panelEl, resolvedPlaceContext, { overwrite: true });
      panelApi.generateReplies(panelEl, card, panelEl._rcVariants || {
        soft: '',
        brief: '',
        proactive: ''
      }, false, reviewSource);
    } catch (err) {
      console.error('[RC] Nie udalo sie otworzyc panelu', err);
      if (wrap.isConnected) {
        panelEl.innerHTML = `<div class="rc-error">${dom.escapeHtml(t('panelOpenError', 'Could not open the panel.'))}</div>`;
      }
    }
  };

  function formatTrialDuration(seconds) {
    if (!Number.isFinite(seconds)) return null;
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const parts = [];
    if (days > 0) {
      parts.push(`${days} ${days === 1 ? t('durationDay', 'day') : t('durationDays', 'days')}`);
    }
    if (hours > 0 && parts.length < 2) {
      parts.push(`${hours} ${t('durationHourShort', 'h')}`);
    }
    if (days === 0 && minutes > 0 && parts.length < 2) {
      parts.push(`${minutes} ${t('durationMinuteShort', 'min')}`);
    }
    if (!parts.length) return t('durationLessThanMinute', 'less than a minute');
    return parts.join(' ');
  }

  function getRemainingSeconds(quota) {
    if (!quota) return null;
    if (typeof quota.remainingSeconds === 'number') return quota.remainingSeconds;
    if (quota.expiresAt) {
      const ts = new Date(quota.expiresAt).getTime();
      if (!Number.isNaN(ts)) {
        return Math.max(0, Math.floor((ts - Date.now()) / 1000));
      }
    }
    return null;
  }

  function updateQuotaInfo(panelEl, quota) {
    const box = panelEl.querySelector('#rc_quota');
    const upgradeBtn = panelEl.querySelector('#rc_upgrade');
    if (!box) return;
    box.innerHTML = '';
    box.classList.remove('rc-quota-warning');
    box.style.display = 'none';
    if (upgradeBtn) {
      upgradeBtn.style.display = 'none';
      upgradeBtn.removeAttribute('data-url');
    }
    if (!quota) return;

    const upgradeUrl = (quota.upgradeUrl || '').trim();
    const type = (quota.type || (quota.limit ? 'usage' : null))?.toLowerCase() || null;
    const rawLimit = Number(quota.limit);

    if (type === 'unlimited' || (Number.isFinite(rawLimit) && rawLimit < 0)) {
      box.style.display = 'block';
      box.textContent = t('unlimited', 'Unlimited.');
      return;
    }

    const showUpgradeCta = () => {
      if (!upgradeUrl) return;
      if (panelEl.dataset.rcAuthRequired === 'true') return;
      if (upgradeBtn) {
        upgradeBtn.dataset.url = upgradeUrl;
        upgradeBtn.style.display = 'inline-flex';
      }
    };
    showUpgradeCta();

    const formatNumber = (value) => {
      return Number.isFinite(value) ? new Intl.NumberFormat(navigator.language || 'pl-PL').format(value) : value;
    };

    if (type === 'time') {
      box.style.display = 'block';
      const remainingSeconds = getRemainingSeconds(quota);
      if (Number.isFinite(remainingSeconds) && remainingSeconds > 0) {
        const human = formatTrialDuration(remainingSeconds) || '';
        const expiresAt = quota.expiresAt ? new Date(quota.expiresAt) : null;
        const expiresLabel = expiresAt && !Number.isNaN(expiresAt.getTime())
          ? expiresAt.toLocaleString(navigator.language || 'pl-PL', { dateStyle: 'short', timeStyle: 'short' })
          : null;
        box.textContent = human ? t('trialEndsIn', `The free trial ends in ${human}.`, [human]) : t('trialStillActive', 'The free trial is still active.');
        if (expiresLabel) {
          const extra = document.createElement('span');
          extra.textContent = t('untilDate', ` (until ${expiresLabel})`, [expiresLabel]);
          box.appendChild(extra);
        }
        return;
      }
      box.classList.add('rc-quota-warning');
      const textEl = document.createElement('span');
      textEl.textContent = t('trialExpired', 'The free trial has expired.');
      box.appendChild(textEl);
      showUpgradeCta();
      return;
    }

    const limit = Number(quota.limit);
    if (!Number.isFinite(limit) || limit <= 0) return;
    const remainingRaw = Number(quota.remaining ?? 0);
    const remaining = Number.isFinite(remainingRaw) ? Math.max(0, Math.floor(remainingRaw)) : 0;
    box.style.display = 'block';
    if (remaining > 0) {
      const remainingLabel = formatNumber(remaining);
      const limitLabel = formatNumber(limit);
      box.textContent = t('remainingFreeRepliesOfLimit', `${remainingLabel} of ${limitLabel} free replies remaining.`, [remainingLabel, limitLabel]);
      return;
    }
    box.classList.add('rc-quota-warning');
    box.textContent = t('freeLimitReached', 'The free reply limit has been used.');
    showUpgradeCta();
  }

  function setAuthRequiredMode(panelEl, required) {
    if (!panelEl) return;
    panelEl.dataset.rcAuthRequired = required ? 'true' : 'false';
    const loginBtn = panelEl.querySelector('#rc_login');
    const copyBtn = panelEl.querySelector('#rc_copy');
    const regenBtn = panelEl.querySelector('#rc_regen');
    const upgradeBtn = panelEl.querySelector('#rc_upgrade');
    const note = panelEl.querySelector('.rc-note');
    if (loginBtn) loginBtn.style.display = required ? 'inline-flex' : 'none';
    if (copyBtn) copyBtn.style.display = required ? 'none' : 'inline-flex';
    if (regenBtn) regenBtn.style.display = required ? 'none' : 'inline-flex';
    if (note) note.style.display = required ? 'none' : '';
    if (required && upgradeBtn) upgradeBtn.style.display = 'none';
  }

  function requestLoginPage(panelEl) {
    const sendMessage = chrome?.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') {
      const err = panelEl?.querySelector?.('#rc_err');
      if (err) err.textContent = t('openLoginUnavailable', 'I cannot open sign-in from this page. Open the extension options.');
      return;
    }
    sendMessage({ type: 'OPEN_LOGIN_PAGE' }, (resp) => {
      const runtimeError = chrome?.runtime?.lastError || null;
      if (!panelEl?.isConnected || (!runtimeError && !(resp && resp.error))) return;
      const err = panelEl.querySelector('#rc_err');
      if (err) {
        err.textContent = runtimeError?.message || resp?.error || t('openLoginFailed', 'Could not open sign-in.');
      }
    });
  }

  function requestOptionsPage(panelEl) {
    const sendMessage = chrome?.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') {
      const err = panelEl?.querySelector?.('#rc_err');
      if (err) err.textContent = t('openOptionsUnavailable', 'I cannot open options from this page. Open the extension options manually.');
      return;
    }
    sendMessage({ type: 'OPEN_OPTIONS_PAGE' }, (resp) => {
      const runtimeError = chrome?.runtime?.lastError || null;
      if (!panelEl?.isConnected || (!runtimeError && !(resp && resp.error))) return;
      const err = panelEl.querySelector('#rc_err');
      if (err) {
        err.textContent = runtimeError?.message || resp?.error || t('openOptionsFailed', 'Could not open options.');
      }
    });
  }

  function refreshLoginAction(panelEl) {
    const sendMessage = chrome?.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') return;
    sendMessage({ type: 'GET_AUTH_STATUS' }, (resp) => {
      if (!panelEl?.isConnected || chrome?.runtime?.lastError) return;
      setAuthRequiredMode(panelEl, !(resp && resp.profile && resp.profile.email));
      panelEl.parentElement?.reposition?.();
    });
  }

  function currentPanelElement() {
    const wrap = state.currentPanel;
    if (wrap?.querySelector) {
      const panelEl = wrap.querySelector(`.${state.panelId}`);
      if (panelEl) return panelEl;
    }
    return document.querySelector(`.${state.panelId}`);
  }

  function handleAuthStatusChanged(message) {
    if (!message || message.type !== 'AUTH_STATUS_CHANGED') return;
    const panelEl = currentPanelElement();
    if (!panelEl?.isConnected) return;

    const wasAuthRequired = panelEl.dataset.rcAuthRequired === 'true';
    const loggedIn = Boolean(message.profile && message.profile.email);
    const errorBox = panelEl.querySelector('#rc_err');
    const preview = panelEl.querySelector('#rc_preview');

    setAuthRequiredMode(panelEl, !loggedIn);
    updateQuotaInfo(panelEl, message.quota || null);

    if (loggedIn) {
      if (errorBox) errorBox.textContent = '';
      if (wasAuthRequired && preview) {
        preview.textContent = t('signedInRegenerate', 'Signed in. Click Regenerate to generate a reply.');
      }
    } else {
      if (errorBox) errorBox.textContent = t('signedOutGenerate', 'Signed out. Sign in to generate a reply.');
      if (preview) preview.textContent = t('signInToGenerate', 'Sign in to generate a reply.');
    }

    panelEl.parentElement?.reposition?.();
  }

  if (!panelApi._authStatusListenerInstalled
    && typeof chrome !== 'undefined'
    && chrome?.runtime?.onMessage
    && typeof chrome.runtime.onMessage.addListener === 'function') {
    chrome.runtime.onMessage.addListener((message) => {
      handleAuthStatusChanged(message);
    });
    panelApi._authStatusListenerInstalled = true;
  }

  function normalizePanelPlaceContext(input = {}) {
    if (typeof placeContextApi.normalizeContext === 'function') {
      return placeContextApi.normalizeContext(input);
    }
    return {
      placeType: (input.placeType || '').trim(),
      placeName: (input.placeName || '').trim(),
      replyGuidelines: (input.replyGuidelines || '').trim()
    };
  }

  function getPanelPlaceContext(panelEl) {
    return normalizePanelPlaceContext(panelEl?._rcPlaceContext || {});
  }

  function applyPlaceContextToPanel(panelEl, contextMeta, options = {}) {
    if (!panelEl || !panelEl.isConnected || !contextMeta) return;
    panelEl._rcPlaceContext = normalizePanelPlaceContext(contextMeta);
    if (contextMeta.placeKey) panelEl.dataset.rcPlaceKey = contextMeta.placeKey;
  }

  async function refreshPlaceContextForPanel(panelEl) {
    if (!panelEl?.isConnected || typeof placeContextApi.resolveContextForPage !== 'function') return;
    try {
      const resolvedPlaceContext = await placeContextApi.resolveContextForPage({ forceRefresh: true });
      applyPlaceContextToPanel(panelEl, resolvedPlaceContext);
    } catch (contextErr) {
      console.warn('[RC] Nie udalo sie odswiezyc kontekstu miejsca', contextErr);
    }
  }

  function renderMainPanel(panelEl, card, reviewSource, initialPlaceContext, options = {}) {
    if (!panelEl.parentElement || !panelEl.parentElement.isConnected) return;
    const source = reviewSource || { text: reviews.extractText(card), rating: reviews.extractRating(card) };
    const reviewText = (source.text || '').trim();
    const reviewRating = (source.rating || '').toString().trim();
    const variants = { soft: '', brief: '', proactive: '' };
    panelEl._rcVariants = variants;
    const placeMeta = initialPlaceContext || {
      placeKey: '',
      placeName: '',
      placeType: '',
      replyGuidelines: '',
      detectedPlaceName: '',
      detectedPlaceType: '',
      source: 'none'
    };

    panelEl.innerHTML = `
      <div class="rc-head">
        <div class="rc-title"><span class="rc-dot"></span> ${dom.escapeHtml(t('panelTitle', 'Choose a style and review the reply'))}</div>
        <div class="rc-head-actions">
          <div class="rc-seg" id="rc_seg">
            <button data-style="soft" class="active">${dom.escapeHtml(t('styleSoft', 'Warm'))}</button>
            <button data-style="brief">${dom.escapeHtml(t('styleBrief', 'Direct'))}</button>
            <button data-style="proactive">${dom.escapeHtml(t('styleProactive', 'Proactive'))}</button>
          </div>
          <button id="rc_options" class="rc-icon-btn" type="button" title="${dom.escapeHtml(t('openOptions', 'Open options'))}" aria-label="${dom.escapeHtml(t('openOptions', 'Open options'))}">
            <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
              <path d="M19.4 13.5c.1-.5.1-1 .1-1.5s0-1-.1-1.5l2-1.5-2-3.5-2.4 1a7.8 7.8 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.8 7.8 0 0 0 7 6.5l-2.4-1-2 3.5 2 1.5c-.1.5-.1 1-.1 1.5s0 1 .1 1.5l-2 1.5 2 3.5 2.4-1a7.8 7.8 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.8 7.8 0 0 0 2.6-1.5l2.4 1 2-3.5-2-1.5ZM12 15.5A3.5 3.5 0 1 1 12 8a3.5 3.5 0 0 1 0 7.5Z"></path>
            </svg>
          </button>
        </div>
      </div>
      <div class="rc-preview" id="rc_preview"><div style="display:flex;align-items:center;gap:8px"><div class="rc-spinner"></div><span>${dom.escapeHtml(t('generating', 'Generating...'))}</span></div></div>
      <div id="rc_quota" class="rc-quota"></div>
      <div class="rc-actions">
        <button id="rc_copy" class="rc-primary">${dom.escapeHtml(t('copyGeneratedReply', 'Copy generated reply'))}</button>
        <button id="rc_regen" class="rc-secondary">${dom.escapeHtml(t('regenerate', 'Regenerate'))}</button>
        <button id="rc_login" class="rc-secondary rc-login" style="display:none">${dom.escapeHtml(t('signIn', 'Sign in'))}</button>
        <button id="rc_upgrade" class="rc-primary rc-upgrade" style="display:none">${dom.escapeHtml(t('buySubscription', 'Buy subscription'))}</button>
        <button id="rc_close" class="rc-secondary">${dom.escapeHtml(t('close', 'Close'))}</button>
        <span class="rc-note">${dom.escapeHtml(t('copyOpensReplyWindow', 'Copies to clipboard and opens the reply window.'))}</span>
        <span class="rc-note">${dom.escapeHtml(t('aiUsesReviewData', 'AI uses the review text, rating, and place context to prepare reply suggestions.'))}</span>
      </div>
      <div id="rc_err" class="rc-error"></div>
    `;

    const seg = panelEl.querySelector('#rc_seg');
    panelEl.dataset.rcPlaceKey = placeMeta.placeKey || '';
    panelEl._rcPlaceContext = normalizePanelPlaceContext(placeMeta);

    seg.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-style]');
      if (!button) return;
      seg.querySelectorAll('button').forEach(x => x.classList.remove('active'));
      button.classList.add('active');
      panelEl.querySelector('#rc_preview').textContent = variants[button.dataset.style] || '...';
    });

    panelEl.querySelector('#rc_copy').onclick = async () => {
      const targetHash = panelEl.parentElement?.dataset.rcTarget || card.dataset.rcHash || '';
      const activeStyle = seg.querySelector('.active')?.dataset.style || 'soft';
      const textValue = variants[activeStyle] || '';
      if (!textValue) {
        panelEl.querySelector('#rc_err').textContent = t('nothingToCopy', 'There is no text to copy.');
        return;
      }
      panelEl.querySelector('#rc_err').textContent = '';
      const copied = await panelApi.copyToClipboard(textValue);
      if (!copied) {
        panelEl.querySelector('#rc_err').textContent = t('copyFailed', 'Could not copy the text.');
        return;
      }
      dom.showToast(t('copiedToClipboard', 'Copied to clipboard.'));
      await panelApi.openReplyPopup(targetHash, card, { suppressWarnings: true });
    };

    const regenerateFromCurrentCard = async () => {
      panelEl.querySelector('#rc_err').textContent = '';
      await refreshPlaceContextForPanel(panelEl);
      panelApi.generateReplies(panelEl, card, variants, true, {
        text: reviews.extractText(card),
        rating: reviews.extractRating(card)
      });
    };
    panelEl._rcGenerateAfterLogin = regenerateFromCurrentCard;
    panelEl.querySelector('#rc_regen').onclick = regenerateFromCurrentCard;

    panelEl.querySelector('#rc_close').onclick = () => {
      dom.closeCurrentPanel();
    };

    const optionsBtn = panelEl.querySelector('#rc_options');
    if (optionsBtn) {
      optionsBtn.addEventListener('click', () => requestOptionsPage(panelEl));
    }

    const loginBtn = panelEl.querySelector('#rc_login');
    if (loginBtn) {
      loginBtn.addEventListener('click', () => requestLoginPage(panelEl));
    }

    const upgradeBtn = panelEl.querySelector('#rc_upgrade');
    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'OPEN_UPGRADE_PAGE' }, (resp) => {
          if (resp && resp.error) {
            dom.showToast(resp.error || t('paymentOpenFailedRetry', 'Could not open payment. Try again later.'));
          }
        });
      });
    }

    if (options.autoGenerate !== false) {
      panelApi.generateReplies(panelEl, card, variants, false, { text: reviewText, rating: reviewRating });
    }
    panelEl.parentElement?.reposition?.();
    chrome.runtime.sendMessage({ type: 'GET_QUOTA_STATUS' }, (resp) => {
      if (panelEl.isConnected) updateQuotaInfo(panelEl, resp && resp.quota ? resp.quota : null);
    });
    refreshLoginAction(panelEl);
  }

  const GENERATE_TIMEOUT_MS = 22000;

  panelApi.generateReplies = function generateReplies(panelEl, card, variants, force, reviewSource) {
    const preview = panelEl.querySelector('#rc_preview');
    const seg = panelEl.querySelector('#rc_seg');
    const errorBox = panelEl.querySelector('#rc_err');
    if (!force && variants.soft) {
      const active = seg.querySelector('.active')?.dataset.style || 'soft';
      preview.textContent = variants[active] || '...';
      return;
    }

    preview.innerHTML = `<div style="display:flex;align-items:center;gap:8px"><div class="rc-spinner"></div><span>${dom.escapeHtml(t('generating', 'Generating...'))}</span></div>`;
    panelEl.parentElement?.reposition?.();

    const showErrorFallback = (message) => {
      if (!panelEl.isConnected) return;
      if (errorBox) errorBox.textContent = message || t('generationErrorCheckKey', 'Generation failed.');
      const activeStyle = seg.querySelector('.active')?.dataset.style || 'soft';
      const fallback = variants[activeStyle] || variants.soft || variants.brief || variants.proactive || '...';
      preview.textContent = fallback;
      panelEl.parentElement?.reposition?.();
    };

    let timeoutId = 0;
    let settled = false;
    const settle = () => {
      if (settled) return false;
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
        timeoutId = 0;
      }
      return true;
    };

    const source = reviewSource || { text: reviews.extractText(card), rating: reviews.extractRating(card) };
    const contextValues = getPanelPlaceContext(panelEl);
    const payload = {
      text: (source.text || '').trim(),
      rating: (source.rating || '').toString().trim(),
      placeKey: panelEl.dataset.rcPlaceKey || '',
      placeType: contextValues.placeType,
      placeName: contextValues.placeName,
      replyGuidelines: contextValues.replyGuidelines
    };

    timeoutId = window.setTimeout(() => {
      if (!settle() || !panelEl.isConnected) return;
      showErrorFallback(t('generationNoResponse', 'The generation service did not respond. Try again.'));
    }, GENERATE_TIMEOUT_MS);

    const sendMessage = chrome?.runtime?.sendMessage;
    if (typeof sendMessage !== 'function') {
      console.error('[RC] chrome.runtime.sendMessage is not available.');
      settle();
      showErrorFallback(t('generationNoCommunication', 'Cannot communicate with the generation service.'));
      return;
    }

    try {
      sendMessage({ type: 'GENERATE_ALL', payload }, (resp) => {
        if (!settle() || !panelEl.isConnected) return;
        const runtimeError = chrome?.runtime?.lastError || null;
        if (runtimeError) {
          console.error('[RC] Runtime message error', runtimeError);
          showErrorFallback(runtimeError.message || t('generationCommunicationError', 'Generation communication failed.'));
          return;
        }
        updateQuotaInfo(panelEl, resp && resp.quota ? resp.quota : null);
        if (!resp || resp.error) {
          let errorMessage = resp?.error || t('generationErrorCheckKey', 'Generation failed.');
          const upgradeEligible = resp?.errorCode === 'FREE_LIMIT_REACHED' || resp?.errorCode === 'SUBSCRIPTION_REQUIRED';
          if (resp?.errorCode === 'FREE_LIMIT_REACHED') {
            errorMessage = t('freeLimitReached', 'The free reply limit has been used.');
          } else if (resp?.errorCode === 'SUBSCRIPTION_REQUIRED') {
            errorMessage = t('subscriptionRequired', 'A subscription is required to continue.');
          }
          if (resp?.errorCode === 'AUTH_REQUIRED') {
            if (errorBox) errorBox.textContent = errorMessage;
            if (preview) preview.textContent = t('signInToGenerate', 'Sign in to generate a reply.');
            setAuthRequiredMode(panelEl, true);
            panelEl.parentElement?.reposition?.();
            return;
          }
          if (upgradeEligible) {
            const quota = resp?.quota || { limit: resp.freeLimit || 0, remaining: 0, upgradeUrl: resp.upgradeUrl };
            if (resp?.upgradeUrl && (!quota.upgradeUrl || !quota.upgradeUrl.trim())) {
              quota.upgradeUrl = resp.upgradeUrl;
            }
            updateQuotaInfo(panelEl, quota);
          }
          showErrorFallback(errorMessage);
          return;
        }

        variants.soft = resp.soft || '';
        variants.brief = resp.brief || '';
        variants.proactive = resp.proactive || '';
        const active = seg.querySelector('.active')?.dataset.style || 'soft';
        preview.textContent = variants[active] || '...';
        if (errorBox) errorBox.textContent = '';
        setAuthRequiredMode(panelEl, false);
        panelEl.parentElement?.reposition?.();
      });
    } catch (err) {
      console.error('[RC] Failed to send GENERATE_ALL message', err);
      settle();
      showErrorFallback(t('generationSendFailed', 'Could not send the generation request.'));
    }
  };

  panelApi.copyToClipboard = async function copyToClipboard(text) {
    if (!text) return false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (_) { }
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    textarea.style.opacity = '0';
    textarea.style.pointerEvents = 'none';
    document.body.appendChild(textarea);
    textarea.select();
    textarea.setSelectionRange(0, textarea.value.length);
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) { ok = false; }
    textarea.remove();
    return ok;
  };

  panelApi.openReplyPopup = async function openReplyPopup(targetHash, fallbackCard, options = {}) {
    const suppressWarnings = Boolean(options && options.suppressWarnings);
    let card = chips.findCardForHash(targetHash);
    if ((!card || !card.isConnected) && fallbackCard?.isConnected) card = fallbackCard;
    if (!card) {
      if (!suppressWarnings) dom.showToast(t('toastReviewNotFound', 'I cannot find the review. Try again.'));
      return;
    }

    const wrap = state.currentPanel;
    const inlineField = dom.findWritableField(card);
    if (inlineField && dom.isElementVisible(inlineField)) {
      wrap?.updatePositionTargets?.(card, inlineField);
      panelApi.focusReplyField(inlineField);
      return;
    }

    const replyBtn = dom.findReplyButton(card);
    if (replyBtn) {
      try { replyBtn.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { }
      try { replyBtn.focus?.(); } catch (_) { }
      try { replyBtn.click?.(); } catch (_) { }
      ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click'].forEach(ev => {
        try { replyBtn.dispatchEvent(new MouseEvent(ev, { bubbles: true, cancelable: true, view: window })); } catch (_) { }
      });
    }

    const target = await dom.waitForCondition(() => {
      const inline = dom.findWritableField(card);
      if (inline && dom.isElementVisible(inline)) return { root: card, anchor: inline };
      const dialogs = dom.qsaDeep('[role="dialog"], [aria-modal="true"]');
      for (const dlg of dialogs) {
        const field = dom.findWritableField(dlg);
        if (field && dom.isElementVisible(field)) return { root: dlg, anchor: field };
        const fallbackField = dom.findWritableField(dlg, true);
        if (fallbackField) return { root: dlg, anchor: fallbackField };
      }
      return null;
    }, 4200, 150);

    if (!target) {
      if (!suppressWarnings) dom.showToast(t('toastReplyFieldOpenFailed', 'I cannot open the reply field. Open it manually and paste the reply.'));
      return;
    }

    const anchorEl = target.anchor || dom.findWritableField(target.root, true) || target.root;
    wrap?.updatePositionTargets?.(target.root, anchorEl);
    panelApi.focusReplyField(target.root, target.root !== card);
  };

  panelApi.focusReplyField = function focusReplyField(target, allowHidden = false) {
    let input = null;
    if (target && target.nodeType === 1 && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' || target.isContentEditable)) {
      input = target;
    } else {
      input = dom.findWritableField(target, allowHidden);
    }
    if (!input) {
      dom.showToast(t('toastReplyFieldNotVisible', 'I cannot see the reply field in the window.'));
      return;
    }
    try { input.focus?.(); } catch (_) { }
    try { input.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) { }
    try {
      if (input.tagName === 'TEXTAREA' && input.setSelectionRange) {
        const pos = input.value.length;
        input.setSelectionRange(pos, pos);
      } else if (input.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(input);
        range.collapse(false);
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
      }
    } catch (_) { }
  };
})(window);

