(() => {
  const mac = /Mac/i.test(navigator.platform);
  const title = window === window.top ? createTitleController() : null;
  let observedHeld;
  let pageHidden = false;
  let disposed = false;

  /** Restore the latest page title when this extension context becomes invalid. */
  function dispose() {
    if (disposed) return;
    disposed = true;
    title?.setHint(null);
    window.removeEventListener('keydown', onInput, true);
    window.removeEventListener('keyup', onInput, true);
    window.removeEventListener('pointermove', onInput, true);
    window.removeEventListener('pointerdown', onInput, true);
    window.removeEventListener('focus', onFocus, true);
    window.removeEventListener('blur', onBlur, true);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
  }

  /** Report state without intercepting keys; an invalid extension restores locally. */
  async function send(message) {
    if (disposed) return;
    try {
      if (!chrome.runtime.id) return dispose();
      await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (!chrome.runtime.id) dispose();
      else console.warn('Tab Number Hints:', error);
    }
  }

  /** Read the modifier itself; switching tabs or pressing another key does not end a hold. */
  function onInput(event) {
    if (!event.isTrusted || pageHidden || disposed) return;
    const held = mac ? event.metaKey : event.ctrlKey;
    // Pointer input reconciles a release missed in browser UI or a protected page.
    // Explicit modifier events remain authoritative after an unobserved focus transfer.
    const modifierEvent = event.key === (mac ? 'Meta' : 'Control');
    if (held === observedHeld && !modifierEvent) return;
    observedHeld = held;
    void send({ type: 'held', held });
  }

  /** A newly focused frame must report its first key event, even if it is keyup. */
  function onFocus() {
    observedHeld = undefined;
    void send({ type: 'ready' });
  }

  /** Reset local deduplication, but never mistake a focus transfer for modifier release. */
  function onBlur() {
    observedHeld = undefined;
  }

  /** Do not cache decorated titles when a page enters the back/forward cache. */
  function onPageHide() {
    pageHidden = true;
    title?.setHint(null);
    onBlur();
  }

  /** Rejoin a live session after navigation or restoration from the page cache. */
  function onPageShow() {
    pageHidden = false;
    onFocus();
  }

  /** Only the top frame owns the tab title; all frames may observe modifier keys. */
  chrome.runtime.onMessage.addListener(message => {
    if (disposed) return;
    if (message?.type === 'hint' && !pageHidden) title?.setHint(message.hint);
  });
  window.addEventListener('keydown', onInput, true);
  window.addEventListener('keyup', onInput, true);
  window.addEventListener('pointermove', onInput, true);
  window.addEventListener('pointerdown', onInput, true);
  window.addEventListener('focus', onFocus, true);
  window.addEventListener('blur', onBlur, true);
  window.addEventListener('pagehide', onPageHide);
  window.addEventListener('pageshow', onPageShow);
  void send({ type: 'ready' });

  /** Preserve page-owned titles verbatim rather than guessing which numeric prefix is ours. */
  function createTitleController() {
    let hint = null;
    let rawTitle = document.title;
    let renderedTitle = null;
    const observer = new MutationObserver(onTitleMutation);

    /** Capture synchronous page writes too, before their mutation callback has run. */
    function captureTitle() {
      if (renderedTitle === null || document.title !== renderedTitle) rawTitle = document.title;
    }

    /** Observe title/head replacement without watching unrelated body mutations. */
    function observeTitle() {
      observer.observe(document, { childList: true });
      if (document.documentElement) observer.observe(document.documentElement, { childList: true });
      if (document.head) observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    }

    /** Exclude our own writes from observation so prefixes never become page content. */
    function renderTitle() {
      observer.disconnect();
      renderedTitle = hint === null ? null : `[${hint}] ${rawTitle}`;
      const nextTitle = renderedTitle ?? rawTitle;
      if (document.title !== nextTitle) document.title = nextTitle;
      if (hint !== null) observeTitle();
    }

    /** Keep the current number while retaining the newest title supplied by the site. */
    function onTitleMutation() {
      if (hint === null) return;
      captureTitle();
      renderTitle();
    }

    /** Apply or remove the number without stripping natural titles such as “[2026] Notes”. */
    function setHint(nextHint) {
      captureTitle();
      hint = nextHint;
      renderTitle();
    }

    return { setHint };
  }
})();
