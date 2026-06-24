const SESSION_ENDPOINT_PATH = '/api/extension/session';
const EXTENSION_UPGRADE_ENDPOINT_PATH = '/api/extension/account/upgrade';
const MAGIC_LINK_ENDPOINT_PATH = '/api/auth/magic-link';
const GENERATE_ENDPOINT_PATH = '/gemini/generate';
const LOG_ENDPOINT_PATH = '/api/extension/log';
const TOKEN_EXPIRY_GUARD_MS = 10 * 1000; // keep 10s safety window
const GENERATE_REQUEST_TIMEOUT_MS = 18 * 1000;
function t(key, fallback = '', substitutions) {
  try {
    const message = chrome?.i18n?.getMessage?.(key, substitutions);
    if (message) return message;
  } catch (_) { }
  return fallback || key;
}

const GENERATE_TIMEOUT_MESSAGE = t('generateTimeout', 'The reply generation service is taking too long. Try again.');
const MAX_PLACE_TYPE_CHARS = 80;
const MAX_PLACE_NAME_CHARS = 120;
const MAX_REPLY_GUIDELINES_CHARS = 1200;
const INSTALL_ID_KEY = 'rcInstallId';
const DEVICE_TOKEN_KEY = 'rcDeviceToken';
const ACCOUNT_PROFILE_KEY = 'rcAccountProfile';
const CONFIG_FILE = 'config.json';
const MAPS_TAB_URLS = ['https://*.google.com/maps*', 'https://*.google.pl/maps*'];

const AUTH_REQUIRED_CODE = 'AUTH_REQUIRED';
const AUTH_REQUIRED_MESSAGE = t('authRequired', 'Sign-in required. Open the extension options and sign in with Google.');
const GOOGLE_LOGIN_REQUIRED_CODE = 'GOOGLE_LOGIN_REQUIRED';
const LOGIN_CANCELLED_CODE = 'LOGIN_CANCELLED';
const CONSENT_REQUIRED_CODE = 'CONSENT_REQUIRED';
const CONSENT_REQUIRED_MESSAGE = t('consentRequired', 'Confirm in the extension options that you are the owner of the place or have explicit authorization to prepare replies.');
const AUTH_STATUS_CHANGED_MESSAGE = 'AUTH_STATUS_CHANGED';
const FRIENDLY_RETRY_MESSAGE = t('retryLater', 'Try again later.');
const FRIENDLY_UPGRADE_MESSAGE = t('paymentOpenFailedRetry', 'Could not open payment. Try again later.');
const FRIENDLY_OVERLOAD_MESSAGE = t('serverOverloaded', 'The server is currently busy. Try again in a moment.');
const OVERLOAD_RETRY_DELAY_MS = 1200;
const EXPECTED_USER_STATE_CODES = new Set([
  AUTH_REQUIRED_CODE,
  GOOGLE_LOGIN_REQUIRED_CODE,
  LOGIN_CANCELLED_CODE,
  CONSENT_REQUIRED_CODE,
  'FREE_LIMIT_REACHED',
  'SUBSCRIPTION_REQUIRED'
]);

let staticConfigPromise = null;
let quotaState = null;

function normalizeReviewText(value) {
  return (value || '').toString().trim();
}

function truncateContextField(value, maxLen) {
  const str = (value || '').toString().replace(/\s+/g, ' ').trim();
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen).trimEnd();
}

function truncateGuidelinesField(value, maxLen) {
  const str = (value || '').toString()
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen).trimEnd();
}

function getProxySessionStorage() {
  return (chrome.storage && chrome.storage.session) ? chrome.storage.session : chrome.storage.local;
}

function normalizeBase(url) {
  if (!url) return '';
  return url.trim().replace(/\/+$/, '');
}

async function loadConfigFile(fileName) {
  const url = chrome.runtime.getURL(fileName);
  const resp = await fetch(url, { cache: 'no-store' });
  if (!resp.ok) { throw new Error(`HTTP ${resp.status}`); }
  const raw = await resp.text();
  if (!raw) { throw new Error('Empty config file'); }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('Invalid JSON');
  }
  const proxyBase = normalizeBase(parsed.proxyBase || parsed.apiBase);
  const upgradeUrl = (parsed.upgradeUrl || parsed.billingUrl || '').trim();
  const licenseKey = (parsed.licenseKey || '').toString().trim();
  const googleClientId = (parsed.googleClientId || '').toString().trim();
  if (!proxyBase) {
    throw new Error('Missing proxyBase in config file');
  }
  return { proxyBase, upgradeUrl, source: fileName, licenseKey, googleClientId };
}

async function loadStaticConfig() {
  if (!staticConfigPromise) {
    staticConfigPromise = (async () => {
      try {
        const cfg = await loadConfigFile(CONFIG_FILE);
        console.info('[RC] Loaded proxy config from', CONFIG_FILE);
        return cfg;
      } catch (err) {
        console.warn('[RC] Config file skipped', { file: CONFIG_FILE, error: String(err) });
        return null;
      }
    })();
  }
  return staticConfigPromise;
}

async function getProxySettings() {
  const cfg = await loadStaticConfig();
  if (cfg && cfg.proxyBase) {
    return cfg;
  }
  throw new Error(t('missingConfig', 'Missing config.json. Build the extension before running it.'));
}

function buildProxyUrl(base, path) {
  if (!base) return '';
  const suffix = path || '';
  return base + suffix;
}

async function fetchWithTimeout(url, init, timeoutMs, timeoutMessage) {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(url, init);
  }
  const controller = new AbortController();
  const timerId = setTimeout(() => {
    controller.abort(new Error(timeoutMessage || 'Request timed out.'));
  }, timeoutMs);
  try {
    return await fetch(url, {
      ...(init || {}),
      signal: controller.signal
    });
  } catch (err) {
    if (err && (err.name === 'AbortError' || String(err).includes('AbortError'))) {
      throw new Error(timeoutMessage || 'Request timed out.');
    }
    throw err;
  } finally {
    clearTimeout(timerId);
  }
}

async function getCachedSession() {
  if (chrome.storage && chrome.storage.session) {
    const { proxySession = {} } = await chrome.storage.session.get(['proxySession']);
    if (proxySession && proxySession.token) {
      return proxySession;
    }
  }
  const { proxySession: legacySession = {} } = await chrome.storage.local.get(['proxySession']);
  return legacySession;
}

function isSessionValid(session, proxyBase) {
  if (!session || session.proxyBase !== proxyBase || !session.token) return false;
  if (!session.expiresAt) return true;
  const expiresAt = new Date(session.expiresAt).getTime();
  if (Number.isNaN(expiresAt)) return false;
  return expiresAt > Date.now();
}

async function storeSession(session) {
  const storageArea = getProxySessionStorage();
  await storageArea.set({ proxySession: session });
  if (storageArea !== chrome.storage.local) {
    await chrome.storage.local.remove(['proxySession']);
  }
}

function normalizeQuota(raw, fallbackUrl = '') {
  if (!raw || typeof raw !== 'object') return null;
  const upgradeUrl = (raw.upgradeUrl || fallbackUrl || '').trim();
  const type = typeof raw.type === 'string' ? raw.type.toLowerCase() : null;
  const expiresAt = raw.expiresAt ? new Date(raw.expiresAt).toISOString() : null;
  const lifetime = raw.lifetime === true;
  const unlimitedLimit = Number(raw.limit);
  if (type === 'unlimited' || raw.unlimited === true || (Number.isFinite(unlimitedLimit) && unlimitedLimit < 0)) {
    return {
      type: 'unlimited',
      limit: -1,
      remaining: null,
      limitSeconds: null,
      remainingSeconds: null,
      expiresAt,
      upgradeUrl,
      lifetime
    };
  }
  if (type === 'time') {
    const limitSeconds = Number(raw.limitSeconds ?? raw.limit);
    if (!Number.isFinite(limitSeconds) || limitSeconds <= 0) return null;
    const remainingSecondsRaw = Number(raw.remainingSeconds ?? raw.remaining);
    const remainingSeconds = Number.isFinite(remainingSecondsRaw) ? Math.max(0, Math.floor(remainingSecondsRaw)) : null;
    return {
      type: 'time',
      limit: null,
      remaining: null,
      limitSeconds: Math.max(0, Math.floor(limitSeconds)),
      remainingSeconds,
      expiresAt,
      upgradeUrl
    };
  }
  const limit = Number(raw.limit ?? raw.limitSeconds);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const remainingNum = Number(raw.remaining ?? raw.remainingSeconds);
  const remaining = Number.isFinite(remainingNum) ? Math.max(0, Math.floor(remainingNum)) : null;
  return {
    type: 'usage',
    limit: Math.max(0, Math.floor(limit)),
    remaining,
    limitSeconds: null,
    remainingSeconds: null,
    expiresAt,
    upgradeUrl
  };
}

function updateQuotaState(quota) {
  quotaState = quota || null;
}

function getQuotaState() {
  return quotaState;
}

function quotaFromHeaders(resp, fallbackUrl = '') {
  if (!resp || typeof resp.headers?.get !== 'function') return null;
  const mode = (resp.headers.get('x-free-mode') || '').toLowerCase();
  const upgradeUrl = (resp.headers.get('x-free-upgrade-url') || fallbackUrl || '').trim();
  const rawLimitHeader = resp.headers.get('x-free-limit');
  const limitFromHeader = Number(rawLimitHeader);
  const expiresAtHeader = resp.headers.get('x-free-expires-at');
  const expiresAt = expiresAtHeader ? new Date(expiresAtHeader).toISOString() : null;
  if (mode === 'unlimited' || (Number.isFinite(limitFromHeader) && limitFromHeader < 0)) {
    return {
      type: 'unlimited',
      limit: -1,
      remaining: null,
      limitSeconds: null,
      remainingSeconds: null,
      expiresAt,
      upgradeUrl
    };
  }
  if (mode === 'time') {
    const limitSecondsRaw = Number(resp.headers.get('x-free-limit-seconds') ?? resp.headers.get('x-free-limit'));
    if (!Number.isFinite(limitSecondsRaw) || limitSecondsRaw <= 0) return null;
    const remainingSecondsRaw = Number(resp.headers.get('x-free-remaining-seconds') ?? resp.headers.get('x-free-remaining'));
    const remainingSeconds = Number.isFinite(remainingSecondsRaw) ? Math.max(0, Math.floor(remainingSecondsRaw)) : null;
    return {
      type: 'time',
      limit: null,
      remaining: null,
      limitSeconds: Math.max(0, Math.floor(limitSecondsRaw)),
      remainingSeconds,
      expiresAt,
      upgradeUrl
    };
  }
  const limit = Number(rawLimitHeader);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  const remainingNum = Number(resp.headers.get('x-free-remaining'));
  const remaining = Number.isFinite(remainingNum) ? Math.max(0, Math.floor(remainingNum)) : null;
  return {
    type: 'usage',
    limit: Math.max(0, Math.floor(limit)),
    remaining,
    limitSeconds: null,
    remainingSeconds: null,
    expiresAt,
    upgradeUrl
  };
}

function quotaLimitValue(quota) {
  if (!quota) return null;
  if ((quota.type || '').toLowerCase() === 'unlimited') return null;
  if (typeof quota.limit === 'number') return quota.limit;
  if (typeof quota.limitSeconds === 'number') return quota.limitSeconds;
  return null;
}

function quotaRemainingValue(quota) {
  if (!quota) return null;
  if ((quota.type || '').toLowerCase() === 'unlimited') return null;
  if (typeof quota.remaining === 'number') return quota.remaining;
  if (typeof quota.remainingSeconds === 'number') return quota.remainingSeconds;
  return null;
}

function resolveSessionExpiry(parsed) {
  if (typeof parsed.expiresIn === 'number' && Number.isFinite(parsed.expiresIn)) {
    const ttlMs = Math.max(0, (parsed.expiresIn * 1000) - TOKEN_EXPIRY_GUARD_MS);
    return new Date(Date.now() + ttlMs).toISOString();
  }
  if (parsed.expiresAt) {
    const expTs = new Date(parsed.expiresAt).getTime();
    if (!Number.isNaN(expTs)) {
      const guardedTs = Math.max(Date.now(), expTs - TOKEN_EXPIRY_GUARD_MS);
      return new Date(guardedTs).toISOString();
    }
  }
  return null;
}

async function ensureInstallId() {
  const stored = await chrome.storage.local.get([INSTALL_ID_KEY]);
  const current = stored?.[INSTALL_ID_KEY];
  if (current && typeof current === 'string') { return current; }
  const generated = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `rc-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const payload = {}; payload[INSTALL_ID_KEY] = generated;
  await chrome.storage.local.set(payload);
  return generated;
}

async function getStoredAccountProfile() {
  const stored = await chrome.storage.local.get([ACCOUNT_PROFILE_KEY]);
  return stored?.[ACCOUNT_PROFILE_KEY] || null;
}

async function storeAccountProfile(profile) {
  if (!profile) return;
  const payload = {}; payload[ACCOUNT_PROFILE_KEY] = profile;
  await chrome.storage.local.set(payload);
}

async function clearAccountProfile() {
  await chrome.storage.local.remove([ACCOUNT_PROFILE_KEY]);
}

function buildStoredProfile(rawProfile, parsed) {
  if (!rawProfile || typeof rawProfile !== 'object') return null;
  const license = parsed && parsed.license && typeof parsed.license === 'object' ? parsed.license : {};
  return {
    email: (rawProfile.email || '').toString(),
    sub: (rawProfile.sub || '').toString(),
    name: (rawProfile.name || '').toString(),
    plan: (rawProfile.plan || parsed?.plan || '').toString(),
    licenseId: (rawProfile.licenseId || license.id || '').toString(),
    licenseStartsAt: rawProfile.licenseStartsAt ? String(rawProfile.licenseStartsAt) : '',
    licenseEndsAt: rawProfile.licenseEndsAt ? String(rawProfile.licenseEndsAt) : '',
    replyAssistantConsentAt: rawProfile.replyAssistantConsentAt ? String(rawProfile.replyAssistantConsentAt) : '',
    replyAssistantConsentVersion: rawProfile.replyAssistantConsentVersion ? String(rawProfile.replyAssistantConsentVersion) : '',
    replyAssistantConsentSource: rawProfile.replyAssistantConsentSource ? String(rawProfile.replyAssistantConsentSource) : '',
    updatedAt: new Date().toISOString()
  };
}

async function getAuthStatusPayload(options = {}) {
  const refresh = options.refresh !== false;
  const forceRefresh = options.forceRefresh === true;
  let profile = await getStoredAccountProfile();
  let quota = getQuotaState();
  const cached = await getCachedSession();
  if (!quota && cached?.quota) {
    quota = cached.quota;
    updateQuotaState(quota);
  }

  const deviceToken = refresh ? await getStoredDeviceToken() : '';
  if (refresh && profile && !cached?.token && !deviceToken) {
    await clearAccountProfile();
    updateQuotaState(null);
    profile = null;
    quota = null;
  }

  if (refresh && (cached?.token || deviceToken)) {
    try {
      const proxySettings = await getProxySettings();
      await ensureSessionToken(proxySettings, { interactive: false, forceRefresh });
      profile = await getStoredAccountProfile();
      quota = getQuotaState();
      const refreshed = await getCachedSession();
      if (!quota && refreshed?.quota) {
        quota = refreshed.quota;
        updateQuotaState(quota);
      }
    } catch (err) {
      if (isExpectedUserStateError(err)) {
        await logoutAccount();
        profile = null;
        quota = null;
      } else {
        console.warn('[RC] Nie udalo sie odswiezyc statusu konta', err);
      }
    }
  }

  return { profile: profile || null, quota: quota || null };
}

async function getStoredDeviceToken() {
  const stored = await chrome.storage.local.get([DEVICE_TOKEN_KEY]);
  return stored?.[DEVICE_TOKEN_KEY] || '';
}

async function storeDeviceToken(token) {
  if (!token) return;
  const payload = {}; payload[DEVICE_TOKEN_KEY] = token;
  await chrome.storage.local.set(payload);
}

async function clearStoredDeviceToken() {
  await chrome.storage.local.remove([DEVICE_TOKEN_KEY]);
}

function launchAuthFlow(url) {
  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow({ url, interactive: true }, redirectUri => {
      if (chrome.runtime.lastError || !redirectUri) {
        const message = chrome.runtime.lastError?.message || 'Auth flow failed.';
        reject(createErrorWithCode(message, isLoginCancelledMessage(message) ? LOGIN_CANCELLED_CODE : undefined));
        return;
      }
      resolve(redirectUri);
    });
  });
}

function isInvalidDeviceTokenError(err) {
  const message = err && err.message ? String(err.message) : '';
  return message.toLowerCase().includes('invalid device token');
}

async function requestGoogleIdToken(proxySettings) {
  const clientId = (proxySettings?.googleClientId || '').toString().trim();
  if (!clientId) {
    throw new Error(t('missingGoogleClientId', 'Missing Google Client ID in configuration.'));
  }
  const redirectUri = chrome.identity.getRedirectURL('provider_cb');
  console.log('[RC] OAuth Redirect URI (add this to Google Cloud Console):', redirectUri);
  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'id_token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', 'email profile openid');
  authUrl.searchParams.set('nonce', Math.random().toString(36).substring(2));
  authUrl.searchParams.set('prompt', 'select_account');

  const responseUrl = await launchAuthFlow(authUrl.toString());
  if (!responseUrl) {
    throw createErrorWithCode(t('loginCancelled', 'Sign-in cancelled.'), LOGIN_CANCELLED_CODE);
  }
  const urlObj = new URL(responseUrl);
  const hashParams = new URLSearchParams(urlObj.hash.substring(1));
  const authError = hashParams.get('error') || urlObj.searchParams.get('error');
  if (authError) {
    throw createErrorWithCode(authError, isLoginCancelledMessage(authError) ? LOGIN_CANCELLED_CODE : undefined);
  }
  const hashToken = hashParams.get('id_token');
  if (hashToken) {
    return hashToken;
  }
  const queryToken = urlObj.searchParams.get('id_token');
  if (queryToken) {
    return queryToken;
  }
  throw new Error(t('missingGoogleIdToken', 'Missing id_token in the Google response.'));
}

async function clearStoredSession() {
  const storageArea = getProxySessionStorage();
  await storageArea.remove(['proxySession']);
}

async function logoutAccount() {
  await clearStoredDeviceToken();
  await clearAccountProfile();
  await clearStoredSession();
  updateQuotaState(null);
}

async function broadcastAuthStatusChanged(reason) {
  if (!chrome.tabs || typeof chrome.tabs.query !== 'function' || typeof chrome.tabs.sendMessage !== 'function') {
    return;
  }
  let status = { profile: null, quota: null };
  try {
    status = await getAuthStatusPayload();
  } catch (err) {
    console.warn('[RC] Nie udalo sie pobrac statusu auth do powiadomienia kart.', err);
  }
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: MAPS_TAB_URLS });
  } catch (err) {
    console.warn('[RC] Nie udalo sie znalezc kart do powiadomienia o auth.', err);
    return;
  }
  const message = {
    type: AUTH_STATUS_CHANGED_MESSAGE,
    reason: reason || '',
    profile: status.profile || null,
    quota: status.quota || null
  };
  await Promise.allSettled((tabs || [])
    .filter(tab => tab && Number.isFinite(tab.id))
    .map(tab => chrome.tabs.sendMessage(tab.id, message).catch(() => {})));
}

function createAuthRequiredError(message = AUTH_REQUIRED_MESSAGE) {
  const err = new Error(message);
  err.code = AUTH_REQUIRED_CODE;
  return err;
}

function createErrorWithCode(message, code) {
  const err = new Error(message || FRIENDLY_RETRY_MESSAGE);
  if (code) err.code = code;
  return err;
}

function errorCodeFrom(err) {
  return (err && err.code ? String(err.code) : '').toUpperCase();
}

function isLoginCancelledMessage(message) {
  const normalized = (message || '').toString().trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('logowanie anulowane')
    || normalized.includes('user did not approve')
    || normalized.includes('access_denied')
    || normalized.includes('cancelled')
    || normalized.includes('canceled')
    || normalized.includes('cancel');
}

function isExpectedUserStateError(err) {
  const code = errorCodeFrom(err);
  if (code && EXPECTED_USER_STATE_CODES.has(code)) return true;

  const message = (err && err.message ? err.message : err || '').toString().toLowerCase();
  return isLoginCancelledMessage(message)
    || message.includes('auth_required')
    || message.includes('google_login_required')
    || message.includes('consent_required')
    || message.includes('wymagane logowanie')
    || message.includes('zaloguj sie kontem google')
    || message.includes('potwierdz w opcjach rozszerzenia')
    || message.includes('zaloguj się kontem google')
    || message.includes('sesja wygasla')
    || message.includes('sesja wygasła');
}

function logUnexpectedError(label, err) {
  if (!isExpectedUserStateError(err)) {
    console.error(label, err);
  }
}

function sanitizeUserFacingError(message, fallback = FRIENDLY_RETRY_MESSAGE) {
  const text = (message || '').toString().trim();
  if (!text) return fallback;

  const normalized = text.toLowerCase();
  if (isLoginCancelledMessage(text)) {
    return t('loginCancelled', 'Sign-in cancelled.');
  }
  if (normalized.includes('failed to fetch') || normalized.includes('networkerror') || normalized.includes('load failed')) {
    return fallback;
  }
  if (isOverloadMessage(text)) {
    return FRIENDLY_OVERLOAD_MESSAGE;
  }
  if (normalized.includes('auth_required') || normalized.includes('wymagane logowanie') || normalized.includes('sesja wygasla')) {
    return t('sessionExpiredSignInExtension', 'Session expired. Sign in again in the extension.');
  }
  if (normalized.includes('google_login_required') || normalized.includes('zaloguj sie kontem google')) {
    return t('googleLoginRequiredForSubscription', 'To buy a subscription, sign in with Google in the extension.');
  }
  if (normalized.includes('consent_required') || normalized.includes('potwierdz w opcjach rozszerzenia')) {
    return CONSENT_REQUIRED_MESSAGE;
  }
  return text;
}

function isOverloadMessage(message) {
  const normalized = (message || '').toString().trim().toLowerCase();
  if (!normalized) return false;
  return normalized.includes('currently experiencing high demand')
    || normalized.includes('spikes in demand are usually temporary')
    || normalized.includes('resource_exhausted')
    || normalized.includes('resource exhausted')
    || normalized.includes('too many requests');
}

async function waitMs(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchSessionToken(settings, options = {}) {
  const proxyBase = settings?.proxyBase;
  if (!proxyBase) { throw new Error(t('missingProxyUrl', 'Missing Proxy URL in configuration.')); }
  const licenseKey = (settings?.licenseKey || '').toString().trim();
  const deviceToken = licenseKey ? '' : (await getStoredDeviceToken());
  const installId = await ensureInstallId();
  const tokenUrl = buildProxyUrl(proxyBase, SESSION_ENDPOINT_PATH);
  const body = {
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    installId
  };
  if (options.idToken) {
    body.idToken = options.idToken;
  } else if (options.code) {
    body.code = options.code;
  } else if (licenseKey) {
    body.licenseKey = licenseKey;
  } else if (deviceToken) {
    body.deviceToken = deviceToken;
  } else {
    throw createAuthRequiredError();
  }
  if (options.consent && typeof options.consent === 'object') {
    body.replyAssistantAuthorized = options.consent.authorized === true;
    body.replyAssistantConsentVersion = (options.consent.version || '').toString().trim();
    body.replyAssistantConsentSource = (options.consent.source || '').toString().trim();
  }
  const headers = {
    'Content-Type': 'application/json',
    'X-Extension-Id': chrome.runtime.id
  };
  const resp = await fetch(tokenUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    mode: 'cors',
    cache: 'no-store',
    credentials: 'omit'
  });
  const raw = await resp.text();
  let parsed;
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch (err) {
    throw new Error(resp.ok ? t('proxyInvalidAuthJson', 'The proxy returned invalid JSON during authorization.') : `Proxy auth HTTP ${resp.status}`);
  }
  if (!resp.ok) {
    const errorText = parsed && (parsed.error || parsed.message) ? (parsed.error || parsed.message) : resp.statusText;
    const err = new Error(errorText || t('proxySessionFailed', 'Could not get a proxy session.'));
    if (parsed && parsed.code) {
      err.code = parsed.code;
    }
    throw err;
  }
  const token = (parsed.token || parsed.jwt || '').trim();
  if (!token) throw new Error(t('proxyMissingJwt', 'The proxy did not return a JWT token.'));
  const expiresAt = resolveSessionExpiry(parsed);
  const normalizedQuota = normalizeQuota(parsed.quota, settings?.upgradeUrl);
  if (normalizedQuota) updateQuotaState(normalizedQuota);
  if (parsed.deviceToken) {
    await storeDeviceToken(parsed.deviceToken);
  }
  if (parsed.profile) {
    await storeAccountProfile(buildStoredProfile(parsed.profile, parsed));
  }
  const session = { token, proxyBase, expiresAt, quota: normalizedQuota };
  await storeSession(session);
  return session;
}

async function ensureSessionToken(settings, options = {}) {
  const cached = await getCachedSession();
  if (!options.forceRefresh && isSessionValid(cached, settings.proxyBase)) {
    if (cached.quota) updateQuotaState(cached.quota);
    return cached.token;
  }
  let session;
  try {
    session = await fetchSessionToken(settings, options);
  } catch (err) {
    if (!isInvalidDeviceTokenError(err)) {
      throw err;
    }

    await clearStoredDeviceToken();
    await clearStoredSession();

    const canRetryWithGoogle = options.interactive === true
      && !options.idToken
      && !options.code
      && !(settings?.licenseKey || '').toString().trim();

    if (!canRetryWithGoogle) {
      throw createAuthRequiredError(t('sessionExpiredSignInAgain', 'Session expired. Sign in again.'));
    }

    const idToken = await requestGoogleIdToken(settings);
    session = await fetchSessionToken(settings, { idToken, consent: options.consent });
  }
  return session.token;
}
function proxyErrorText(j) {
  if (j && j.error && (j.error.message || j.error.status)) return (j.error.message || j.error.status);
  return null;
}

async function openUpgradeCheckout(proxySettings) {
  let sessionToken = await ensureSessionToken(proxySettings, { interactive: false });
  let attempt = 0;

  while (attempt < 2) {
    const resp = await fetch(buildProxyUrl(proxySettings.proxyBase, EXTENSION_UPGRADE_ENDPOINT_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${sessionToken}`,
        'X-Extension-Id': chrome.runtime.id
      },
      body: JSON.stringify({ plan_id: 'pro_monthly' }),
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit'
    });

    const raw = await resp.text();
    let parsed = {};
    try {
      parsed = raw ? JSON.parse(raw) : {};
    } catch (_) {
      parsed = {};
    }

    if (resp.status === 401 && attempt === 0) {
      attempt += 1;
      const refreshed = await fetchSessionToken(proxySettings, { interactive: false });
      sessionToken = refreshed.token;
      continue;
    }

    if (!resp.ok) {
      const message = parsed.message || parsed.error || resp.statusText || FRIENDLY_UPGRADE_MESSAGE;
      throw createErrorWithCode(message, parsed.code);
    }

    const checkoutUrl = (parsed.checkout_url || '').toString().trim();
    if (!checkoutUrl) {
      throw createErrorWithCode(FRIENDLY_UPGRADE_MESSAGE);
    }
    return checkoutUrl;
  }

  throw createErrorWithCode(t('sessionExpiredSignInExtension', 'Session expired. Sign in again in the extension.'), AUTH_REQUIRED_CODE);
}

function sendLogEvent(proxySettings, token, level, message, context) {
  if (!proxySettings?.proxyBase || !token || !message) return;
  try {
    const payload = {
      level: level || 'info',
      message,
      context: context || {},
      timestamp: new Date().toISOString()
    };
    fetch(buildProxyUrl(proxySettings.proxyBase, LOG_ENDPOINT_PATH), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        'X-Extension-Id': chrome.runtime.id
      },
      body: JSON.stringify(payload),
      mode: 'cors',
      cache: 'no-store',
      credentials: 'omit'
    }).catch(() => { });
  } catch (_) { }
}

function openExtensionOptionsPage() {
  if (typeof chrome.runtime.openOptionsPage === 'function') {
    return chrome.runtime.openOptionsPage();
  }
  chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  return Promise.resolve();
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    if (msg.type === 'GET_QUOTA_STATUS') {
      sendResponse({ quota: getQuotaState() });
      return;
    }
    if (msg.type === 'GET_AUTH_STATUS') {
      const status = await getAuthStatusPayload({ forceRefresh: msg.forceRefresh === true });
      sendResponse(status);
      return;
    }
    if (msg.type === 'OPEN_LOGIN_PAGE' || msg.type === 'OPEN_OPTIONS_PAGE') {
      try {
        await openExtensionOptionsPage();
        sendResponse({ ok: true });
      } catch (err) {
        console.error('[RC] Open options page error:', err);
        sendResponse({ error: t('optionsOpenManual', 'Could not open options. Open the extension options manually.') });
      }
      return;
    }
    if (msg.type === 'START_GOOGLE_LOGIN') {
      try {
        const proxySettings = await getProxySettings();
        const idToken = await requestGoogleIdToken(proxySettings);
        await clearStoredDeviceToken();
        await clearStoredSession();
        const consent = msg && typeof msg === 'object' && msg.consent && typeof msg.consent === 'object'
          ? msg.consent
          : null;
        const session = await fetchSessionToken(proxySettings, { idToken, consent });
        const profile = await getStoredAccountProfile();
        await broadcastAuthStatusChanged('login');
        sendResponse({ ok: true, profile, quota: session.quota || getQuotaState() });
      } catch (err) {
        logUnexpectedError('[RC] Google login failed', err);
        sendResponse({ error: sanitizeUserFacingError(err && err.message, t('googleLoginFailed', 'Google sign-in failed.')) });
      }
      return;
    }
    if (msg.type === 'OPEN_UPGRADE_PAGE') {
      (async () => {
        try {
          const proxySettings = await getProxySettings();
          const checkoutUrl = await openUpgradeCheckout(proxySettings);
          chrome.tabs.create({ url: checkoutUrl });
          sendResponse({ ok: true, checkoutUrl });
        } catch (err) {
          logUnexpectedError('[RC] OPEN_UPGRADE_PAGE error:', err);
          sendResponse({
            error: sanitizeUserFacingError(err && err.message, FRIENDLY_UPGRADE_MESSAGE),
            code: err && err.code ? err.code : undefined
          });
        }
      })();
      return true; // async response
    }
    if (msg.type === 'START_MAGIC_LINK') {
      const email = (msg.email || '').toString().trim();
      if (!email) {
        sendResponse({ error: t('emailRequired', 'Email is required.') });
        return;
      }
      try {
        const proxySettings = await getProxySettings();
        const installId = await ensureInstallId();
        const redirectUri = chrome.identity.getRedirectURL('magic-link');
        const requestBody = {
          email,
          installId,
          extensionId: chrome.runtime.id,
          redirectUri
        };
        const resp = await fetch(buildProxyUrl(proxySettings.proxyBase, MAGIC_LINK_ENDPOINT_PATH), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
          mode: 'cors',
          cache: 'no-store',
          credentials: 'omit'
        });
        const raw = await resp.text();
        let parsed = {};
        try { parsed = raw ? JSON.parse(raw) : {}; } catch (_) { parsed = {}; }
        if (!resp.ok) {
          const message = parsed.error || parsed.message || resp.statusText || t('magicLinkFailed', 'Magic link request failed.');
          sendResponse({ error: message });
          return;
        }
        if (parsed.magicLink) {
          const redirectUrl = await launchAuthFlow(parsed.magicLink);
          const urlObj = new URL(redirectUrl);
          const code = urlObj.searchParams.get('code');
          if (!code) {
            sendResponse({ error: t('missingAuthCode', 'Missing auth code in redirect.') });
            return;
          }
          await clearStoredSession();
          const session = await fetchSessionToken(proxySettings, { code });
          const profile = await getStoredAccountProfile();
          await broadcastAuthStatusChanged('login');
          sendResponse({ ok: true, profile, quota: session.quota || getQuotaState() });
          return;
        }
        sendResponse({ ok: true, pending: true, emailSent: parsed.emailSent === true });
      } catch (err) {
        const message = sanitizeUserFacingError(err && err.message, FRIENDLY_RETRY_MESSAGE);
        sendResponse({ error: message });
      }
      return;
    }
    if (msg.type === 'COMPLETE_MAGIC_LINK') {
      const code = (msg.code || '').toString().trim();
      if (!code) {
        sendResponse({ error: t('codeRequired', 'Code is required.') });
        return;
      }
      try {
        const proxySettings = await getProxySettings();
        await clearStoredSession();
        const session = await fetchSessionToken(proxySettings, { code });
        const profile = await getStoredAccountProfile();
        await broadcastAuthStatusChanged('login');
        sendResponse({ ok: true, profile, quota: session.quota || getQuotaState() });
      } catch (err) {
        const message = sanitizeUserFacingError(err && err.message, FRIENDLY_RETRY_MESSAGE);
        sendResponse({ error: message });
      }
      return;
    }
    if (msg.type === 'LOGOUT') {
      await logoutAccount();
      await broadcastAuthStatusChanged('logout');
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'GENERATE_ALL') {
      const payload = (msg && typeof msg === 'object' && msg.payload && typeof msg.payload === 'object') ? msg.payload : null;
      if (!payload) {
        console.warn('[RC] GENERATE_ALL message missing payload.');
        sendResponse({ error: t('missingReviewData', 'Missing review data for generation.') });
        return;
      }
      const proxySettings = await getProxySettings();
      if (!proxySettings.proxyBase) { sendResponse({ error: t('missingProxyRebuild', 'Missing Proxy URL. Build the extension again.') }); return; }
      let sessionToken = '';
      try {
        sessionToken = await ensureSessionToken(proxySettings, { interactive: true });
      } catch (err) {
        logUnexpectedError('[RC] Nie udalo sie pobrac tokenu proxy', err);
        const message = sanitizeUserFacingError(err && err.message, FRIENDLY_RETRY_MESSAGE);
        sendResponse({ error: message, errorCode: err && err.code ? err.code : undefined });
        return;
      }
      const ratingRaw = payload.rating == null ? '?' : payload.rating;
      const rating = (typeof ratingRaw === 'string' ? ratingRaw : String(ratingRaw)).trim() || '?';
      const reviewText = normalizeReviewText(payload.text == null ? '' : String(payload.text));
      const placeType = truncateContextField(payload.placeType, MAX_PLACE_TYPE_CHARS);
      const placeName = truncateContextField(payload.placeName, MAX_PLACE_NAME_CHARS);
      const replyGuidelines = truncateGuidelinesField(payload.replyGuidelines, MAX_REPLY_GUIDELINES_CHARS);
      console.log('[RC] Worker payload meta:', {
        rating,
        textLength: reviewText.length,
        placeType,
        hasPlaceName: !!placeName,
        hasReplyGuidelines: !!replyGuidelines,
        replyGuidelinesLength: replyGuidelines.length
      });
      console.log('[RC] Proxy request meta:', {
        proxy: proxySettings.proxyBase,
        textLength: reviewText.length,
        rating,
        placeType,
        hasPlaceName: !!placeName,
        hasReplyGuidelines: !!replyGuidelines,
        replyGuidelinesLength: replyGuidelines.length
      });
      const url = buildProxyUrl(proxySettings.proxyBase, GENERATE_ENDPOINT_PATH);
      const body = {
        text: reviewText,
        rating,
        placeType,
        placeName,
        replyGuidelines
      };
      const baseHeaders = {
        'Content-Type': 'application/json',
        'X-Extension-Id': chrome.runtime.id
      };
      const requestBody = JSON.stringify(body);
      const requestInitBase = {
        method: 'POST',
        body: requestBody,
        mode: 'cors',
        cache: 'no-store',
        credentials: 'omit'
      };
      sendLogEvent(proxySettings, sessionToken, 'info', 'generate_start', {
        rating,
        textLength: reviewText.length,
        placeType,
        hasPlaceName: !!placeName,
        hasReplyGuidelines: !!replyGuidelines,
        replyGuidelinesLength: replyGuidelines.length
      });
      let attempt = 0;
      try {
        while (attempt < 2) {
          const headers = {
            ...baseHeaders,
            'Authorization': `Bearer ${sessionToken}`
          };
          const resp = await fetchWithTimeout(
            url,
            { ...requestInitBase, headers },
            GENERATE_REQUEST_TIMEOUT_MS,
            GENERATE_TIMEOUT_MESSAGE
          );
          if (resp.status === 401 && attempt === 0) {
            attempt++;
            const refreshedSession = await fetchSessionToken(proxySettings, { interactive: false });
            sessionToken = refreshedSession.token;
            continue;
          }
          const quotaFromResp = quotaFromHeaders(resp, proxySettings.upgradeUrl);
          const raw = await resp.text();
          let j = null;
          try {
            j = raw ? JSON.parse(raw) : {};
          } catch (_) {
            if (!resp.ok) {
              sendResponse({ error: t('proxyErrorStatus', `Proxy error (${resp.status})`, [String(resp.status)]), quota: quotaFromResp });
              if (quotaFromResp) updateQuotaState(quotaFromResp);
              return;
            }
            sendResponse({ error: t('proxyInvalidResponse', 'Invalid proxy response.'), quota: quotaFromResp });
            if (quotaFromResp) updateQuotaState(quotaFromResp);
            return;
          }
          if (!resp.ok) {
            const rawErrorText = proxyErrorText(j) || j.error || resp.statusText;
            const retryableOverload = (resp.status === 429 || isOverloadMessage(rawErrorText)) && attempt === 0;
            if (retryableOverload) {
              attempt++;
              sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_retry_overload', { status: resp.status });
              await waitMs(OVERLOAD_RETRY_DELAY_MS);
              continue;
            }
            const proxyErr = sanitizeUserFacingError(rawErrorText, FRIENDLY_RETRY_MESSAGE);
            const enriched = quotaFromResp || normalizeQuota(j?.quota, proxySettings.upgradeUrl);
            if (enriched) updateQuotaState(enriched);
            sendResponse({ error: proxyErr, errorCode: j?.code, freeLimit: j?.limit, upgradeUrl: j?.upgradeUrl || proxySettings.upgradeUrl, quota: enriched });
            const remainingForLog = quotaRemainingValue(enriched);
            sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_rejected', { error: proxyErr, code: j?.code, remaining: remainingForLog, quotaType: enriched?.type });
            return;
          }
          const rawProxyErr = proxyErrorText(j);
          const err = rawProxyErr ? sanitizeUserFacingError(rawProxyErr, FRIENDLY_RETRY_MESSAGE) : null;
          if (err) {
            if (attempt === 0 && isOverloadMessage(rawProxyErr)) {
              attempt++;
              sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_retry_overload', { status: resp.status });
              await waitMs(OVERLOAD_RETRY_DELAY_MS);
              continue;
            }
            if (quotaFromResp) updateQuotaState(quotaFromResp);
            const logRemaining = quotaRemainingValue(quotaFromResp);
            sendLogEvent(proxySettings, sessionToken, 'warn', 'generate_error', { error: err, remaining: logRemaining, quotaType: quotaFromResp?.type });
            sendResponse({ error: err, quota: quotaFromResp });
            return;
          }
          let soft = (j?.soft || '').trim();
          let brief = (j?.brief || '').trim();
          let proactive = (j?.proactive || '').trim();
          if (!soft || !brief || !proactive) {
            const text = (j && j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts)
              ? j.candidates[0].content.parts.map(p => p.text || '').join('\n')
              : '';
            try {
              const obj = JSON.parse(text);
              soft = (obj.soft || '').trim();
              brief = (obj.brief || '').trim();
              proactive = (obj.proactive || '').trim();
            } catch (_) {
              soft = '';
              brief = '';
              proactive = '';
            }
          }
          if (quotaFromResp) updateQuotaState(quotaFromResp);
          const logRemaining = quotaRemainingValue(quotaFromResp);
          const logLimit = quotaLimitValue(quotaFromResp);
          sendLogEvent(proxySettings, sessionToken, 'info', 'generate_success', { rating, remaining: logRemaining, limit: logLimit, quotaType: quotaFromResp?.type });
          sendResponse({ soft, brief, proactive, quota: quotaFromResp });
          return;
        }
      } catch (e) {
        const errorMessage = sanitizeUserFacingError(e && e.message ? e.message : String(e), FRIENDLY_RETRY_MESSAGE);
        sendLogEvent(proxySettings, sessionToken, 'error', 'generate_exception', { error: String(e), rating });
        sendResponse({ error: errorMessage });
      }
      return;
    }
  })();
  return true;
});

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { normalizeBase, loadConfigFile, fetchWithTimeout, normalizeReviewText, normalizeQuota, quotaFromHeaders };
}
