(function initPlaceContext(global) {
  const RC = global.RC;
  const { dom, config, state } = RC;
  const placeContext = RC.placeContext = RC.placeContext || {};

  const STORAGE_KEY = (config.storageKeys && config.storageKeys.placeContextMap) || 'rcPlaceContextByKey';
  const BUSINESS_CONTEXT_KEY = (config.storageKeys && config.storageKeys.businessContext) || 'rcBusinessContext';
  const MAX_PLACE_NAME_CHARS = 120;
  const MAX_PLACE_TYPE_CHARS = 80;
  const MAX_REPLY_GUIDELINES_CHARS = 1200;

  function normalizeSpaces(value) {
    const raw = value == null ? '' : String(value);
    if (dom && typeof dom.normalizeSpaces === 'function') {
      return dom.normalizeSpaces(raw);
    }
    return raw.replace(/\s+/g, ' ').trim();
  }

  function truncate(value, maxLen) {
    if (!value) return '';
    return value.length > maxLen ? value.slice(0, maxLen).trim() : value;
  }

  function normalizePlaceName(value) {
    return truncate(normalizeSpaces(value), MAX_PLACE_NAME_CHARS);
  }

  function normalizePlaceType(value) {
    return truncate(normalizeSpaces(value), MAX_PLACE_TYPE_CHARS);
  }

  function normalizeReplyGuidelines(value) {
    return truncate((value == null ? '' : String(value))
      .replace(/\r\n?/g, '\n')
      .split('\n')
      .map(line => line.replace(/[ \t]+/g, ' ').trim())
      .join('\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim(), MAX_REPLY_GUIDELINES_CHARS);
  }

  function normalizeKeyPart(value) {
    return normalizeSpaces(value)
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }

  function isPlausibleName(value) {
    const normalized = normalizePlaceName(value);
    if (!normalized || normalized.length < 2) return false;
    const lowered = normalized.toLowerCase();
    if (/^(opinie|reviews|recenzje|zdjecia|photos|menu|przeglad|overview)$/.test(lowered)) return false;
    return true;
  }

  function isPlausibleType(value, placeName = '') {
    const normalized = normalizePlaceType(value);
    if (!normalized || normalized.length < 2) return false;
    const lowered = normalized.toLowerCase();
    if (placeName && lowered === normalizePlaceType(placeName).toLowerCase()) return false;
    if (/^(google maps|opinie|reviews|recenzje)$/.test(lowered)) return false;
    return true;
  }

  function firstVisibleText(selectors, validator) {
    for (const selector of selectors) {
      const nodes = dom.qsaDeep(selector, document);
      for (const node of nodes) {
        if (!node || node.closest('#rc_root')) continue;
        if (typeof dom.isElementVisible === 'function' && !dom.isElementVisible(node)) continue;
        const text = normalizeSpaces(node.textContent || node.innerText || '');
        if (!text) continue;
        if (!validator || validator(text)) {
          return text;
        }
      }
    }
    return '';
  }

  function parseTitleMetadata() {
    const rawTitle = normalizeSpaces(document.title || '');
    if (!rawTitle) return { placeName: '', placeType: '' };
    const title = rawTitle.replace(/\s*-\s*Google Maps\s*$/i, '').trim();
    if (!title) return { placeName: '', placeType: '' };

    const parts = title.split(/[·•|]/).map(part => normalizeSpaces(part)).filter(Boolean);
    const placeName = parts.length ? normalizePlaceName(parts[0]) : '';
    let placeType = '';

    for (let i = 1; i < parts.length; i++) {
      const candidate = normalizePlaceType(parts[i]);
      if (isPlausibleType(candidate, placeName) && !/\d/.test(candidate)) {
        placeType = candidate;
        break;
      }
    }

    return { placeName, placeType };
  }

  function detectPlaceName() {
    const selectors = [
      'h1.DUwDvf',
      'h1.fontHeadlineLarge',
      '[role="main"] h1',
      '[data-attrid="title"]',
      'h1'
    ];
    const fromDom = firstVisibleText(selectors, isPlausibleName);
    if (fromDom) return normalizePlaceName(fromDom);
    return parseTitleMetadata().placeName;
  }

  function detectPlaceType(placeName = '') {
    const selectors = [
      'button[jsaction*="pane.rating.category"]',
      '[data-item-id*="authority"] button',
      '[data-item-id*="authority"]',
      '[role="main"] button',
      '[role="main"] span',
      '[role="main"] div'
    ];

    const validator = (value) => {
      if (!isPlausibleType(value, placeName)) return false;
      if (value.length > 60) return false;
      if (/^\d+([.,]\d+)?$/.test(value)) return false;
      if (/^(otwarte|zamkniete|closed|open)$/i.test(value)) return false;
      return true;
    };

    const fromDom = firstVisibleText(selectors, validator);
    if (fromDom) return normalizePlaceType(fromDom);
    return parseTitleMetadata().placeType;
  }

  function extractPlaceIdentity() {
    try {
      const href = String(global.location.href || '');
      const hrefPlaceMatch = href.match(/\/maps\/place\/([^/?#]+)/i);
      if (hrefPlaceMatch) {
        const hrefSlug = normalizeKeyPart(decodeURIComponent(hrefPlaceMatch[1]).replace(/\+/g, ' '));
        if (hrefSlug) return `place:${hrefSlug}`;
      }

      const url = new URL(global.location.href);
      const cid = normalizeSpaces(url.searchParams.get('cid'));
      if (cid) return `cid:${cid}`;

      const ftid = normalizeSpaces(url.searchParams.get('ftid'));
      if (ftid) return `ftid:${ftid}`;

      const queryPlaceId = normalizeSpaces(url.searchParams.get('query_place_id'));
      if (queryPlaceId) return `placeid:${queryPlaceId}`;

      const combined = `${url.pathname}${url.search}`;
      const hexMatch = combined.match(/(0x[0-9a-f]+:0x[0-9a-f]+)/i);
      if (hexMatch) return `gm:${hexMatch[1].toLowerCase()}`;

      const placeMatch = url.pathname.match(/\/maps\/place\/([^/]+)/i);
      if (placeMatch) {
        const slug = normalizeKeyPart(decodeURIComponent(placeMatch[1]).replace(/\+/g, ' '));
        if (slug) return `place:${slug}`;
      }

      const query = normalizeSpaces(url.searchParams.get('q') || url.searchParams.get('query'));
      if (query) return `query:${normalizeKeyPart(query)}`;
    } catch (_) {
      return '';
    }
    return '';
  }

  function getStorageArea() {
    return chrome?.storage?.local || chrome?.storage?.sync || null;
  }

  function currentPageFingerprint() {
    return {
      href: String(global.location?.href || ''),
      title: normalizeSpaces(document.title || '')
    };
  }

  async function readStoredMap() {
    const storageArea = getStorageArea();
    if (!storageArea || typeof storageArea.get !== 'function') return {};
    const stored = await storageArea.get([STORAGE_KEY]);
    const value = stored && stored[STORAGE_KEY];
    return value && typeof value === 'object' ? value : {};
  }

  async function writeStoredMap(map) {
    const storageArea = getStorageArea();
    if (!storageArea || typeof storageArea.set !== 'function') return;
    await storageArea.set({ [STORAGE_KEY]: map });
  }

  async function readStoredBusinessContext() {
    const storageArea = getStorageArea();
    if (!storageArea || typeof storageArea.get !== 'function') return null;
    const stored = await storageArea.get([BUSINESS_CONTEXT_KEY]);
    const value = stored && stored[BUSINESS_CONTEXT_KEY];
    if (!value || typeof value !== 'object') return null;
    const normalized = placeContext.normalizeContext(value);
    if (!normalized.placeName && !normalized.placeType && !normalized.replyGuidelines) return null;
    return {
      placeName: normalized.placeName,
      placeType: normalized.placeType,
      replyGuidelines: normalized.replyGuidelines,
      updatedAt: value.updatedAt || null,
      source: value.source || 'options'
    };
  }

  placeContext.normalizeContext = function normalizeContext(input = {}) {
    return {
      placeName: normalizePlaceName(input.placeName),
      placeType: normalizePlaceType(input.placeType),
      replyGuidelines: normalizeReplyGuidelines(input.replyGuidelines)
    };
  };

  placeContext.detectPlaceContext = function detectPlaceContext() {
    const placeName = detectPlaceName();
    const placeType = detectPlaceType(placeName);
    const placeId = extractPlaceIdentity();
    const fallbackParts = [];

    if (!placeId) {
      const locationPart = normalizeKeyPart(`${global.location.origin || ''}${global.location.pathname || ''}`);
      if (locationPart) fallbackParts.push(locationPart);
      const namePart = normalizeKeyPart(placeName);
      if (namePart) fallbackParts.push(namePart);
    }

    return {
      placeKey: placeId || (fallbackParts.length ? `page:${fallbackParts.join(':')}` : ''),
      placeName,
      placeType
    };
  };

  placeContext.loadManualContext = async function loadManualContext(placeKey) {
    if (!placeKey) return null;
    const storedMap = await readStoredMap();
    const entry = storedMap[placeKey];
    if (!entry || typeof entry !== 'object') return null;
    const normalized = placeContext.normalizeContext(entry);
    if (!normalized.placeName && !normalized.placeType && !normalized.replyGuidelines) return null;
    return {
      placeName: normalized.placeName,
      placeType: normalized.placeType,
      replyGuidelines: normalized.replyGuidelines,
      updatedAt: entry.updatedAt || null,
      source: entry.source || 'manual'
    };
  };

  placeContext.saveManualContext = async function saveManualContext(placeKey, input = {}) {
    if (!placeKey) return;
    const normalized = placeContext.normalizeContext(input);
    const storedMap = await readStoredMap();
    if (!normalized.placeName && !normalized.placeType && !normalized.replyGuidelines) {
      if (storedMap[placeKey]) {
        delete storedMap[placeKey];
        await writeStoredMap(storedMap);
      }
      return;
    }
    storedMap[placeKey] = {
      placeName: normalized.placeName,
      placeType: normalized.placeType,
      replyGuidelines: normalized.replyGuidelines,
      updatedAt: new Date().toISOString(),
      source: 'manual'
    };
    await writeStoredMap(storedMap);
    if (state.placeContextCache && state.placeContextCache.placeKey === placeKey) {
      state.placeContextCache = {
        ...state.placeContextCache,
        resolved: {
          ...state.placeContextCache.resolved,
          placeName: normalized.placeName,
          placeType: normalized.placeType,
          replyGuidelines: normalized.replyGuidelines,
          source: 'manual'
        }
      };
    }
  };

  placeContext.loadBusinessContext = async function loadBusinessContext() {
    return readStoredBusinessContext();
  };

  placeContext.resolveContextForPage = async function resolveContextForPage(options = {}) {
    const forceRefresh = !!options.forceRefresh;
    const fingerprint = currentPageFingerprint();
    const cached = state.placeContextCache;
    if (!forceRefresh && cached
      && cached.href === fingerprint.href
      && cached.title === fingerprint.title
      && cached.resolved) {
      return { ...cached.resolved };
    }

    const detected = placeContext.detectPlaceContext();
    const manual = await placeContext.loadManualContext(detected.placeKey);
    const business = await readStoredBusinessContext();
    const resolved = {
      placeName: business?.placeName || manual?.placeName || detected.placeName,
      placeType: business?.placeType || manual?.placeType || detected.placeType,
      replyGuidelines: business?.replyGuidelines || manual?.replyGuidelines || ''
    };
    const source = business ? 'options' : (manual ? 'manual' : ((detected.placeName || detected.placeType) ? 'detected' : 'none'));
    const result = {
      placeKey: detected.placeKey,
      placeName: resolved.placeName || '',
      placeType: resolved.placeType || '',
      replyGuidelines: resolved.replyGuidelines || '',
      detectedPlaceName: detected.placeName || '',
      detectedPlaceType: detected.placeType || '',
      source
    };
    state.placeContextCache = {
      href: fingerprint.href,
      title: fingerprint.title,
      placeKey: result.placeKey,
      resolved: { ...result }
    };
    return result;
  };
})(window);
