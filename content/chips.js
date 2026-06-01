(function initChips(global){
  const RC = global.RC;
  const { state, dom, reviews } = RC;
  const t = RC.t || ((key, fallback) => fallback || key);
  const chips = RC.chips = RC.chips || {};
  const RESTACK_HOVER_GRACE_MS = 400;

  chips.findCardForHash = function findCardForHash(hashVal){
    if (!hashVal) return null;
    const entry = state.chipRegistry.get(hashVal);
    if (entry){
      if (entry.card?.isConnected) return entry.card;
      if (entry.button?.isConnected){
        const host = entry.button.closest('[data-rc-hash]');
        if (host){ entry.card = host; return host; }
      }
    }
    try {
      return document.querySelector(`[data-rc-hash="${hashVal}"]`);
    } catch (_){
      return null;
    }
  };

  function isMeaningfulText(node){
    return node && node.nodeType === Node.TEXT_NODE && node.textContent.trim() !== '';
  }

  function previousMeaningfulSibling(node){
    let prev = node ? node.previousSibling : null;
    while (prev && prev.nodeType === Node.TEXT_NODE && !isMeaningfulText(prev)){
      prev = prev.previousSibling;
    }
    return prev;
  }

  function nextMeaningfulSibling(node){
    let next = node ? node.nextSibling : null;
    while (next && next.nodeType === Node.TEXT_NODE && !isMeaningfulText(next)){
      next = next.nextSibling;
    }
    return next;
  }

  function ensureAfter(anchor, btn){
    if (!anchor) return false;
    const parent = anchor.parentElement;
    if (!parent) return false;
    const reference = nextMeaningfulSibling(anchor);
    if (reference === btn) return true;
    if (btn.parentElement === parent && previousMeaningfulSibling(btn) === anchor) return true;
    parent.insertBefore(btn, reference || null);
    return true;
  }

  function ensureBefore(anchor, btn){
    if (!anchor) return false;
    const parent = anchor.parentElement;
    if (!parent) return false;
    if (btn.parentElement === parent && btn.nextSibling === anchor) return true;
    parent.insertBefore(btn, anchor);
    return true;
  }

  function locateHeaderGroup(card, header){
    if (!header) return null;
    const limit = card;
    const pattern = /(author|profile|header|heading|info|details|owner|name|title|like|polub|helpful|vote|glos)/i;
    let node = header;
    while (node.parentElement && node.parentElement !== limit){
      const parent = node.parentElement;
      const descriptor = [
        parent.getAttribute?.('class') || '',
        parent.getAttribute?.('aria-label') || '',
        parent.getAttribute?.('role') || '',
        parent.getAttribute?.('itemprop') || ''
      ].join(' ');
      if (pattern.test(descriptor)){
        node = parent;
        continue;
      }
      break;
    }
    return node;
  }

  function expandHeaderTail(card, node){
    if (!node) return null;
    const pattern = /(owner|wlascic|like|polub|helpful|badge|vote|glos|guide|autor|author|profile|header|title)/i;
    let tail = node;
    let next = tail.nextElementSibling;
    while (next && card.contains(next)){
      if (next.classList?.contains('rc-chip-slot')) break;
      const descriptor = [
        next.className || '',
        next.getAttribute?.('aria-label') || '',
        next.textContent || ''
      ].join(' ').toLowerCase();
      if (!descriptor.trim()) break;
      if (pattern.test(descriptor)){
        tail = next;
        next = tail.nextElementSibling;
        continue;
      }
      break;
    }
    return tail;
  }

  function ensureHeaderSlot(card, header){
    if (!card || !header) return null;
    const group = locateHeaderGroup(card, header);
    if (!group) return null;
    let tail = expandHeaderTail(card, group);
    if (!tail || !tail.parentElement) return null;
    const pattern = /(owner|wlascic|like|polub|helpful|badge|vote|glos|guide|autor|author|profile|header|title)/i;
    let slotNode = null;
    let scan = tail.nextSibling;
    while (scan && card.contains(scan)){
      if (scan.nodeType === Node.TEXT_NODE){
        if (scan.textContent.trim() === ''){
          scan = scan.nextSibling;
          continue;
        }
        break;
      }
      if (scan.nodeType === Node.ELEMENT_NODE){
        if (scan.classList?.contains('rc-chip-slot')){
          slotNode = scan;
          scan = scan.nextSibling;
          continue;
        }
        if (scan.classList?.contains('rc-chip-btn')){
          scan = scan.nextSibling;
          continue;
        }
        const descriptor = [
          scan.className || '',
          scan.getAttribute?.('aria-label') || '',
          scan.textContent || ''
        ].join(' ').toLowerCase();
        if (!descriptor.trim()){
          break;
        }
        if (pattern.test(descriptor)){
          tail = scan;
          scan = tail.nextElementSibling;
          continue;
        }
      }
      break;
    }
    let slot = slotNode;
    if (!slot || !slot.classList?.contains('rc-chip-slot')){
      slot = card.ownerDocument.createElement('div');
      slot.className = 'rc-chip-slot';
    }
    if (slot.previousSibling !== tail){
      tail.insertAdjacentElement('afterend', slot);
    }
    return slot;
  }

  function onChipClick(event){
    const button = event.currentTarget;
    const targetHash = button.getAttribute('data-rc-hash') || '';
    const entry = state.chipRegistry.get(targetHash);
    // Keep the chip stable while the panel opens so Google Maps reflows cannot eat the first click.
    lockRestack(entry, 900);
    let hostCard = button.closest('[data-rc-hash]');
    if (hostCard === button){
      hostCard = button.parentElement ? button.parentElement.closest('[data-rc-hash]') : null;
    }
    const card = (hostCard && hostCard.dataset.rcHash === targetHash)
      ? hostCard
      : chips.findCardForHash(targetHash);
    if (!card){
      dom.showToast(t('toastReviewNotFoundForSuggestion', 'I cannot find the review for this suggestion.'));
      return;
    }
    const panel = global.RC.panel;
    if (!panel || typeof panel.openForCard !== 'function'){
      dom.showToast(t('toastPanelLoading', 'The panel is still loading. Try again.'));
      return;
    }
    if (reviews){
      const newText = (reviews.extractText(card) || "").trim();
      if (newText) card.dataset.rcReviewText = newText;
      const newRating = (reviews.extractRating(card) || "").toString().trim();
      if (newRating) card.dataset.rcRating = newRating;
    }
    panel.openForCard(card, button);
  }

  chips.createChipButton = function createChipButton(hashVal){
    const btn = document.createElement('button');
    btn.className = 'rc-chip-btn';
    btn.setAttribute('data-rc-hash', hashVal);
    const label = t('chipSuggestReply', 'Suggest reply');
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none"><path d="M12 3l1.6 3.7L17 8.2l-3.4 1.5L12 13l-1.6-3.3L7 8.2l3.4-1.5L12 3z" stroke="currentColor" stroke-width="1.6"/></svg><span></span>';
    btn.querySelector('span').textContent = label;
    btn.setAttribute('aria-label', label);
    btn.addEventListener('click', onChipClick);
    return btn;
  };

  function nowTs(){
    return (global.performance && typeof global.performance.now === 'function')
      ? global.performance.now()
      : Date.now();
  }

  function lockRestack(entry, durationMs = RESTACK_HOVER_GRACE_MS){
    if (!entry) return;
    entry.restackLockedUntil = Math.max(entry.restackLockedUntil || 0, nowTs() + durationMs);
  }

  function isInteractionLocked(entry, btn){
    if (!btn) return false;
    if ((entry?.restackLockedUntil || 0) > nowTs()) return true;
    try {
      if (btn.matches(':hover')) return true;
    } catch (_){ }
    try {
      return document.activeElement === btn;
    } catch (_){
      return false;
    }
  }

  function bindInteractionGuards(entry){
    const btn = entry?.button;
    if (!entry || !btn || entry.interactionGuardsBound) return;

    const hold = () => lockRestack(entry, RESTACK_HOVER_GRACE_MS);
    const release = () => lockRestack(entry, RESTACK_HOVER_GRACE_MS);

    btn.addEventListener('mouseenter', hold);
    btn.addEventListener('mousemove', hold);
    btn.addEventListener('mouseleave', release);
    btn.addEventListener('focus', hold);
    btn.addEventListener('blur', release);
    btn.addEventListener('mousedown', hold);
    btn.addEventListener('mouseup', release);

    entry.interactionGuardsBound = true;
  }

  function ensureGuard(entry, card){
    if (!entry || !card) return;
    if (entry.guardObserver) return;

    const observer = new MutationObserver(() => {
      const btn = entry.button;
      if (!btn) return;
      if (entry.restacking) return;
      // Avoid shuffling while user hovers/clicks to prevent flicker and lost clicks
      if (isInteractionLocked(entry, btn)) return;

      const buttonInCard = card.contains(btn);
      const slot = entry.slot;
      const anchored = entry.anchorStrategy === 'fallback'
        ? buttonInCard
        : Boolean(slot && card.contains(slot) && slot.contains(btn));

      if (anchored){
        entry.restackCount = 0;
        return;
      }

      entry.restacking = true;

      try {
        const now = (global.performance && typeof global.performance.now === 'function')
          ? global.performance.now()
          : Date.now();
        const lastTs = entry.lastRestackTs || 0;
        if (!lastTs || (now - lastTs) > 1800){
          entry.restackCount = 0;
        }
        entry.lastRestackTs = now;
        entry.restackCount = (entry.restackCount || 0) + 1;
        entry.restackTotal = (entry.restackTotal || 0) + 1;

        if (entry.restackCount >= 3 || entry.restackTotal >= 6){
          entry.anchorStrategy = 'fallback';
          entry.slot = null;
        }

        const newSlot = chips.placeChip(card, btn, entry);
        if (entry.anchorStrategy === 'fallback'){
          entry.slot = null;
        } else if (newSlot){
          entry.slot = newSlot;
          entry.restackCount = 0;
        }
      } finally {
        entry.restacking = false;
      }
    });

    observer.observe(card, { childList: true, subtree: true });

    entry.guardObserver = observer;
  }


  chips.placeChip = function placeChip(card, btn, entry){
    if (!card || !btn) return null;
    if (!card.dataset.rcHash) card.dataset.rcHash = btn.getAttribute('data-rc-hash') || '';
    const duplicates = card.querySelectorAll('.rc-chip-btn');
    duplicates.forEach(el => { if (el !== btn) el.remove(); });

    const skipHeader = entry?.anchorStrategy === 'fallback';
    let slot = null;

    if (!skipHeader){
      const headerAnchor = dom.findReviewerHeader(card);
      if (headerAnchor){
        slot = ensureHeaderSlot(card, headerAnchor);
        if (slot){
          btn.classList.add('rc-chip-anchored');
          if (btn.parentElement !== slot) slot.appendChild(btn);
          card.querySelectorAll('.rc-chip-slot').forEach(node => { if (node !== slot) node.remove(); });
          return slot;
        }
      }
    }
    btn.classList.remove('rc-chip-anchored');

    const replyBtn = dom.findReplyButton(card);
    if (replyBtn && ensureAfter(replyBtn, btn)){
      if (skipHeader){
        card.querySelectorAll('.rc-chip-slot').forEach(node => node.remove());
      }
      return null;
    }

    const replyField = dom.qsaDeep(RC.config.selectors.textInputs, card)[0];
    if (replyField && ensureBefore(replyField, btn)){
      if (skipHeader){
        card.querySelectorAll('.rc-chip-slot').forEach(node => node.remove());
      }
      return null;
    }

    if (btn.parentElement === card && previousMeaningfulSibling(btn) === null){
      if (skipHeader){
        card.querySelectorAll('.rc-chip-slot').forEach(node => node.remove());
      }
      return null;
    }
    card.insertAdjacentElement('afterbegin', btn);
    if (skipHeader){
      card.querySelectorAll('.rc-chip-slot').forEach(node => node.remove());
    }
    return null;
  };


  chips.ensureChipForCard = function ensureChipForCard(card, hashVal){
    if (!card || !hashVal) return;
    let entry = state.chipRegistry.get(hashVal);
    if (entry && (!entry.button || !entry.button.isConnected)){
      try { entry.guardObserver?.disconnect(); } catch (_){ }
      state.chipRegistry.delete(hashVal);
      entry = null;
    }
    if (!entry){
      entry = { button: chips.createChipButton(hashVal), card, slot: null, guardObserver: null, restacking: false, restackCount: 0, lastRestackTs: 0, restackTotal: 0, anchorStrategy: 'auto', restackLockedUntil: 0, interactionGuardsBound: false };
      state.chipRegistry.set(hashVal, entry);
    }
    bindInteractionGuards(entry);
    const cardChanged = entry.card !== card;
    entry.card = card;
    if (cardChanged){
      entry.slot = null;
      entry.restackCount = 0;
      entry.lastRestackTs = 0;
      entry.restackTotal = 0;
    }
    if (isInteractionLocked(entry, entry.button)){
      ensureGuard(entry, card);
      return;
    }
    const slot = chips.placeChip(card, entry.button, entry);
    if (entry.anchorStrategy === 'fallback'){
      entry.slot = null;
    } else if (slot){
      entry.slot = slot;
    }
    ensureGuard(entry, card);
  };


  chips.cleanupRegistry = function cleanupRegistry(activeHashes){
    state.chipRegistry.forEach((entry, hashVal) => {
      if (!entry || !entry.button || !entry.button.isConnected || !activeHashes.has(hashVal)){
        try { entry.guardObserver?.disconnect(); } catch (_){ }
        try { entry.slot?.remove(); } catch (_){ }
        try { entry?.button?.remove(); } catch (_){ }
        state.chipRegistry.delete(hashVal);
      }
    });
  };
})(window);





