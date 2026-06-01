(function(){
  const authStatusEl = document.getElementById('auth-status');
  const accountEmailEl = document.getElementById('account-email');
  const licenseTypeEl = document.getElementById('license-type');
  const quotaLeftEl = document.getElementById('quota-left');
  const nextPaymentEl = document.getElementById('next-payment');
  const consentStatusEl = document.getElementById('consent-status');
  const googleLoginBtn = document.getElementById('google_login_btn');
  const upgradeBtn = document.getElementById('upgrade_btn');
  const logoutBtn = document.getElementById('logout_btn');
  const placeTypeInput = document.getElementById('business_place_type');
  const placeNameInput = document.getElementById('business_place_name');
  const replyGuidelinesInput = document.getElementById('business_reply_guidelines');
  const replyGuidelinesCountEl = document.getElementById('reply-guidelines-count');
  const saveContextBtn = document.getElementById('save_context_btn');
  const contextSaveStatusEl = document.getElementById('context-save-status');
  const upgradeStatusEl = document.getElementById('upgrade-status');
  const consentCheckbox = document.getElementById('reply_assistant_consent');
  const authOnlyEls = Array.from(document.querySelectorAll('.auth-only'));
  const guestOnlyEls = Array.from(document.querySelectorAll('.guest-only'));
  const BUSINESS_CONTEXT_KEY = 'rcBusinessContext';
  const MAX_PLACE_TYPE_CHARS = 80;
  const MAX_PLACE_NAME_CHARS = 120;
  const MAX_REPLY_GUIDELINES_CHARS = 1200;
  const REPLY_ASSISTANT_CONSENT_VERSION = '2026-05-06';
  const REPLY_ASSISTANT_CONSENT_SOURCE = 'extension-options';

  let loggedInState = false;
  let authActionPending = false;

  function t(key, fallback = '', substitutions) {
    try {
      const message = chrome?.i18n?.getMessage?.(key, substitutions);
      if (message) return message;
    } catch (_) { }
    return fallback || key;
  }

  function applyI18n() {
    document.documentElement.lang = chrome?.i18n?.getUILanguage?.() || 'en';
    document.title = t('optionsTitle', 'Reviews Coach - Options');
    document.querySelectorAll('[data-i18n]').forEach((el) => {
      const key = el.getAttribute('data-i18n');
      if (!key) return;
      el.textContent = t(key, el.textContent || '');
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
      const key = el.getAttribute('data-i18n-placeholder');
      if (!key) return;
      el.setAttribute('placeholder', t(key, el.getAttribute('placeholder') || ''));
    });
    document.querySelectorAll('[data-i18n-title]').forEach((el) => {
      const key = el.getAttribute('data-i18n-title');
      if (!key) return;
      el.setAttribute('title', t(key, el.getAttribute('title') || ''));
    });
  }

  function setText(el, text){
    if (el) el.textContent = text || '-';
  }

  function visibleDisplayFor(el){
    const configuredDisplay = el?.getAttribute?.('data-auth-display');
    if (configuredDisplay) return configuredDisplay;
    const tagName = (el?.tagName || '').toUpperCase();
    if (tagName === 'BUTTON') return 'inline-flex';
    if (tagName === 'SPAN' || tagName === 'A') return 'inline';
    if (tagName === 'TR') return 'table-row';
    if (tagName === 'TD' || tagName === 'TH') return 'table-cell';
    return 'block';
  }

  function setAuthenticatedUiVisible(visible){
    authOnlyEls.forEach((el) => {
      el.style.display = visible ? visibleDisplayFor(el) : 'none';
    });
    guestOnlyEls.forEach((el) => {
      el.style.display = visible ? 'none' : visibleDisplayFor(el);
    });
  }

  function normalizeSpaces(value){
    return (value == null ? '' : String(value)).replace(/\s+/g, ' ').trim();
  }

  function truncate(value, maxLength){
    if (!value) return '';
    return value.length > maxLength ? value.slice(0, maxLength).trim() : value;
  }

  function normalizeMultiline(value){
    return (value == null ? '' : String(value))
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function updateReplyGuidelinesCount(){
    if (!replyGuidelinesCountEl) return;
    const length = (replyGuidelinesInput?.value || '').length;
    replyGuidelinesCountEl.textContent = `${Math.min(length, MAX_REPLY_GUIDELINES_CHARS)}/${MAX_REPLY_GUIDELINES_CHARS}`;
  }

  function readContextForm(){
    return {
      placeType: truncate(normalizeSpaces(placeTypeInput?.value || ''), MAX_PLACE_TYPE_CHARS),
      placeName: truncate(normalizeSpaces(placeNameInput?.value || ''), MAX_PLACE_NAME_CHARS),
      replyGuidelines: truncate(normalizeMultiline(replyGuidelinesInput?.value || ''), MAX_REPLY_GUIDELINES_CHARS)
    };
  }

  function setContextStatus(text, kind){
    if (!contextSaveStatusEl) return;
    contextSaveStatusEl.textContent = text || '';
    contextSaveStatusEl.className = `save-status ${kind === 'error' ? 'status-err' : (kind === 'ok' ? 'status-ok' : 'muted')}`;
  }

  function setUpgradeStatus(text, kind){
    if (!upgradeStatusEl) return;
    upgradeStatusEl.textContent = text || '';
    upgradeStatusEl.className = `upgrade-status ${kind === 'error' ? 'status-err' : (kind === 'ok' ? 'status-ok' : 'muted')}`;
  }

  function isConsentAccepted() {
    return Boolean(consentCheckbox?.checked);
  }

  function buildConsentPayload() {
    if (!isConsentAccepted()) return null;
    return {
      authorized: true,
      version: REPLY_ASSISTANT_CONSENT_VERSION,
      source: REPLY_ASSISTANT_CONSENT_SOURCE
    };
  }

  function syncLoginButtonState() {
    if (!googleLoginBtn) return;
    googleLoginBtn.disabled = authActionPending || (!loggedInState && !isConsentAccepted());
  }

  async function loadBusinessContext(){
    if (!chrome?.storage?.local) {
      setContextStatus(t('storageUnavailable', 'Extension storage is unavailable.'), 'error');
      return;
    }
    try {
      const stored = await chrome.storage.local.get([BUSINESS_CONTEXT_KEY]);
      const value = stored && stored[BUSINESS_CONTEXT_KEY] && typeof stored[BUSINESS_CONTEXT_KEY] === 'object'
        ? stored[BUSINESS_CONTEXT_KEY]
        : {};
      if (placeTypeInput) placeTypeInput.value = truncate(normalizeSpaces(value.placeType || ''), MAX_PLACE_TYPE_CHARS);
      if (placeNameInput) placeNameInput.value = truncate(normalizeSpaces(value.placeName || ''), MAX_PLACE_NAME_CHARS);
      if (replyGuidelinesInput) {
        replyGuidelinesInput.value = truncate(normalizeMultiline(value.replyGuidelines || ''), MAX_REPLY_GUIDELINES_CHARS);
        updateReplyGuidelinesCount();
      }
    } catch (err) {
      console.error('[RC] Nie udalo sie wczytac kontekstu miejsca', err);
      setContextStatus(t('contextLoadFailed', 'Could not load place context.'), 'error');
    }
  }

  async function saveBusinessContext(){
    if (!chrome?.storage?.local) {
      setContextStatus(t('storageUnavailable', 'Extension storage is unavailable.'), 'error');
      return;
    }
    const context = readContextForm();
    if (placeTypeInput) placeTypeInput.value = context.placeType;
    if (placeNameInput) placeNameInput.value = context.placeName;
    if (replyGuidelinesInput) {
      replyGuidelinesInput.value = context.replyGuidelines;
      updateReplyGuidelinesCount();
    }
    if (saveContextBtn) saveContextBtn.disabled = true;
    setContextStatus(t('saving', 'Saving...'), 'muted');
    try {
      await chrome.storage.local.set({
        [BUSINESS_CONTEXT_KEY]: {
          ...context,
          updatedAt: new Date().toISOString(),
          source: 'options'
        }
      });
      setContextStatus(t('contextSaved', 'Place context saved.'), 'ok');
    } catch (err) {
      console.error('[RC] Nie udalo sie zapisac kontekstu miejsca', err);
      setContextStatus(t('contextSaveFailed', 'Could not save place context.'), 'error');
    } finally {
      if (saveContextBtn) saveContextBtn.disabled = false;
    }
  }

  function formatNumber(value){
    return Number.isFinite(value)
      ? new Intl.NumberFormat(navigator.language || 'pl-PL').format(value)
      : null;
  }

  function formatDate(value){
    if (!value) return null;
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return null;
    return date.toLocaleString(navigator.language || 'pl-PL', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function formatDuration(seconds){
    if (!Number.isFinite(seconds)) return null;
    const total = Math.max(0, Math.floor(seconds));
    const days = Math.floor(total / 86400);
    const hours = Math.floor((total % 86400) / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    if (days > 0) return `${days} ${days === 1 ? t('durationDay', 'day') : t('durationDays', 'days')}`;
    if (hours > 0) return `${hours} ${t('durationHourShort', 'h')}`;
    if (minutes > 0) return `${minutes} ${t('durationMinuteShort', 'min')}`;
    return t('lessThanMinute', 'less than a minute');
  }

  function formatConsentStatus(profile){
    const consentAt = formatDate(profile?.replyAssistantConsentAt);
    if (consentAt) return t('confirmedAt', `Confirmed ${consentAt}.`, [consentAt]);
    return t('noConsentRecord', 'No saved confirmation.');
  }

  function planLabel(profile, quota){
    const plan = (profile?.plan || '').toString().toLowerCase();
    if (plan === 'pro') return 'Pro';
    if (plan === 'trial') return t('trialPlan', 'Trial');
    if (plan === 'expired') return t('expiredPlan', 'Expired');
    if (quota?.lifetime === true) return t('lifetimeLicense', 'Lifetime license');
    if (profile?.licenseId || quota) return t('activeLicense', 'Active license');
    return '-';
  }

  function isUnlimitedQuota(quota){
    if (!quota) return false;
    const type = (quota.type || '').toString().toLowerCase();
    const limit = Number(quota.limit);
    return type === 'unlimited' || (Number.isFinite(limit) && limit < 0);
  }

  function quotaLabel(quota){
    if (!quota) return t('noData', 'No data.');
    if (isUnlimitedQuota(quota)) return t('unlimited', 'Unlimited.');
    if ((quota.type || '').toLowerCase() === 'time') {
      const remaining = Number(quota.remainingSeconds);
      const duration = formatDuration(remaining);
      return duration ? t('remainingDuration', `${duration} remaining.`, [duration]) : t('noTimeRemainingData', 'No remaining time data.');
    }
    const remaining = Number(quota.remaining);
    const limit = Number(quota.limit);
    const remainingText = formatNumber(remaining);
    const limitText = formatNumber(limit);
    if (remainingText && limitText) return t('replyCountOfLimit', `${remainingText} of ${limitText} replies.`, [remainingText, limitText]);
    if (limitText) return t('limitLabel', `Limit: ${limitText} replies.`, [limitText]);
    return t('noData', 'No data.');
  }

  function nextPaymentLabel(profile, quota){
    if (quota?.lifetime === true) return t('noPaymentLifetime', 'None - lifetime license.');
    const expiresAt = formatDate(quota?.expiresAt);
    const plan = (profile?.plan || '').toString().toLowerCase();
    if (plan === 'trial' && expiresAt) return t('trialUntil', `No payment. Trial until ${expiresAt}.`, [expiresAt]);
    if (plan === 'pro' && expiresAt) return t('proRenewalAt', `${expiresAt} (based on access renewal).`, [expiresAt]);
    if (expiresAt) return t('accessRenewalAt', `Access renewal: ${expiresAt}.`, [expiresAt]);
    return t('noExtensionData', 'No data in the extension.');
  }

  function renderStatus(profile, quota){
    const loggedIn = Boolean(profile && profile.email);
    const plan = (profile?.plan || '').toString().toLowerCase();
    const isTrial = loggedIn && plan === 'trial';
    loggedInState = loggedIn;
    if (loggedIn) {
      authStatusEl.textContent = t('signedInAs', `Signed in as ${profile.email}.`, [profile.email]);
      authStatusEl.className = 'status-ok';
    } else {
      authStatusEl.textContent = t('notSignedIn', 'You are not signed in.');
      authStatusEl.className = 'muted';
    }
    setText(accountEmailEl, loggedIn ? profile.email : '-');
    setText(licenseTypeEl, loggedIn ? planLabel(profile, quota) : '-');
    setText(quotaLeftEl, loggedIn ? quotaLabel(quota) : '-');
    setText(nextPaymentEl, loggedIn ? nextPaymentLabel(profile, quota) : '-');
    setText(consentStatusEl, loggedIn ? formatConsentStatus(profile) : '-');
    setAuthenticatedUiVisible(loggedIn);
    if (logoutBtn) logoutBtn.disabled = authActionPending || !loggedIn;
    if (logoutBtn) logoutBtn.style.display = loggedIn ? 'inline-flex' : 'none';
    if (googleLoginBtn) googleLoginBtn.textContent = loggedIn ? t('changeGoogleAccount', 'Change Google account') : t('signInWithGoogle', 'Sign in with Google');
    if (upgradeBtn) upgradeBtn.style.display = isTrial ? 'inline-flex' : 'none';
    if (!isTrial) setUpgradeStatus('', 'muted');
    syncLoginButtonState();
    if (loggedIn) {
      loadBusinessContext();
    } else {
      if (placeTypeInput) placeTypeInput.value = '';
      if (placeNameInput) placeNameInput.value = '';
      if (replyGuidelinesInput) {
        replyGuidelinesInput.value = '';
        updateReplyGuidelinesCount();
      }
      setContextStatus('', 'muted');
    }
  }

  function setButtonsDisabled(disabled){
    authActionPending = disabled;
    syncLoginButtonState();
    if (logoutBtn) logoutBtn.disabled = disabled || !loggedInState;
    if (upgradeBtn) upgradeBtn.disabled = disabled;
  }

  function requestAuthStatus(){
    chrome.runtime.sendMessage({ type: 'GET_AUTH_STATUS', forceRefresh: true }, resp => {
      if (chrome.runtime.lastError){
        authStatusEl.textContent = chrome.runtime.lastError.message;
        authStatusEl.className = 'status-err';
        return;
      }
      renderStatus(resp?.profile || null, resp?.quota || null);
    });
  }

  if (googleLoginBtn){
    googleLoginBtn.addEventListener('click', ()=>{
      if (!loggedInState && !isConsentAccepted()) {
        authStatusEl.textContent = t('confirmAuthorizationBeforeGoogle', 'Confirm authorization before connecting your Google account.');
        authStatusEl.className = 'status-err';
        syncLoginButtonState();
        return;
      }
      setButtonsDisabled(true);
      authStatusEl.textContent = t('openingGoogleSignIn', 'Opening Google sign-in...');
      authStatusEl.className = 'muted';
      chrome.runtime.sendMessage({ type: 'START_GOOGLE_LOGIN', consent: buildConsentPayload() }, resp => {
        setButtonsDisabled(false);
        if (chrome.runtime.lastError){
          authStatusEl.textContent = chrome.runtime.lastError.message;
          authStatusEl.className = 'status-err';
          return;
        }
        if (resp && resp.error){
          authStatusEl.textContent = resp.error;
          authStatusEl.className = 'status-err';
          requestAuthStatus();
          return;
        }
        renderStatus(resp?.profile || null, resp?.quota || null);
      });
    });
  }

  if (logoutBtn){
    logoutBtn.addEventListener('click', ()=>{
      setButtonsDisabled(true);
      chrome.runtime.sendMessage({ type: 'LOGOUT' }, resp => {
        setButtonsDisabled(false);
        if (chrome.runtime.lastError){
          authStatusEl.textContent = chrome.runtime.lastError.message;
          authStatusEl.className = 'status-err';
          return;
        }
        if (resp && resp.error){
          authStatusEl.textContent = resp.error;
          authStatusEl.className = 'status-err';
          return;
        }
        renderStatus(null, null);
      });
    });
  }

  if (upgradeBtn){
    upgradeBtn.addEventListener('click', ()=>{
      const previousText = upgradeBtn.textContent;
      upgradeBtn.disabled = true;
      upgradeBtn.textContent = t('redirecting', 'Redirecting...');
      setUpgradeStatus(t('openingStripePayment', 'Opening Stripe payment...'), 'muted');
      chrome.runtime.sendMessage({ type: 'OPEN_UPGRADE_PAGE' }, resp => {
        upgradeBtn.disabled = false;
        upgradeBtn.textContent = previousText || t('buySubscription', 'Buy subscription');
        if (chrome.runtime.lastError){
          setUpgradeStatus(chrome.runtime.lastError.message, 'error');
          return;
        }
        if (resp && resp.error){
          setUpgradeStatus(resp.error, 'error');
          return;
        }
        setUpgradeStatus(t('paymentOpened', 'Payment opened in a new tab.'), 'ok');
      });
    });
  }

  if (saveContextBtn){
    saveContextBtn.addEventListener('click', saveBusinessContext);
  }

  if (replyGuidelinesInput) {
    replyGuidelinesInput.addEventListener('input', updateReplyGuidelinesCount);
  }

  if (consentCheckbox) {
    consentCheckbox.addEventListener('change', () => {
      syncLoginButtonState();
      if (!loggedInState && isConsentAccepted()) {
        authStatusEl.textContent = t('canConnectGoogle', 'You can connect your Google account.');
        authStatusEl.className = 'muted';
      }
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyI18n();
    updateReplyGuidelinesCount();
    syncLoginButtonState();
    requestAuthStatus();
  });
})();
