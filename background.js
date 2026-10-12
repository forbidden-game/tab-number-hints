// Only the focused window can own a held modifier. Session storage preserves that
// fact across MV3 worker suspension; nothing is saved to disk or synced.
let activeWindowId = null;
let pending = chrome.storage.session.get('activeWindowId').then(saved => {
  activeWindowId = saved.activeWindowId ?? null;
});

/** Serialize keyboard and tab events so a late decoration cannot undo a release. */
function enqueue(work) {
  const result = pending.then(work);
  pending = result.catch(error => console.error('Tab Number Hints:', error));
  return result;
}

/** Persist before painting, allowing a restarted worker to restore every title. */
async function setActiveWindow(windowId) {
  activeWindowId = windowId;
  await chrome.storage.session.set({ activeWindowId });
}

/** Map real tab indices, including restricted and pinned tabs, to native digits. */
async function paintWindow(windowId, held) {
  const tabs = await chrome.tabs.query({ windowId });
  await Promise.all(tabs.map(tab => {
    const digits = [];
    if (held && tab.index < 8) digits.push(tab.index + 1);
    if (held && tab.index === tabs.length - 1) digits.push(9);
    const hint = digits.length ? digits.join('/') : null;
    // Missing receivers are expected on protected, unloaded, and closing pages.
    return chrome.tabs.sendMessage(tab.id, { type: 'hint', hint }, { frameId: 0 }).catch(() => {});
  }));
}

/** End the session before restoring titles, including tabs that are now inactive. */
async function release() {
  if (activeWindowId === null) return;
  const previousWindow = activeWindowId;
  await setActiveWindow(null);
  await paintWindow(previousWindow, false);
}

/** Reject delayed keyboard messages from a tab or window that no longer has focus. */
async function activeSender(sender) {
  if (!sender.tab) return null;
  const [tab, window] = await Promise.all([
    chrome.tabs.get(sender.tab.id).catch(() => null),
    chrome.windows.get(sender.tab.windowId).catch(() => null),
  ]);
  return tab?.active && window?.focused ? tab : null;
}

/** Recompute only the held window; ordinary browsing requires no title traffic. */
function refresh(windowId) {
  return enqueue(async () => {
    if (activeWindowId === windowId) await paintWindow(windowId, true);
  });
}

/** Accept only our page lifecycle and modifier observations; never handle digits. */
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!sender.tab || !['held', 'ready'].includes(message?.type)) return;
  void enqueue(async () => {
    if (message.type === 'ready') {
      if (activeWindowId === sender.tab.windowId) await paintWindow(activeWindowId, true);
      return;
    }
    const tab = await activeSender(sender);
    if (!tab) return;
    if (message.held !== true) {
      await release();
    } else {
      if (activeWindowId !== tab.windowId) {
        await release();
        await setActiveWindow(tab.windowId);
      }
      await paintWindow(tab.windowId, true);
    }
  }).then(() => respond(), () => respond());
  return true;
});

/** Tab activation is not a release, even if the destination cannot observe keys. */
chrome.tabs.onActivated.addListener(({ windowId }) => { void refresh(windowId); });

// Index changes affect both the first eight digits and the special last-tab digit.
chrome.tabs.onCreated.addListener(tab => { void refresh(tab.windowId); });
chrome.tabs.onRemoved.addListener((_tabId, info) => {
  if (!info.isWindowClosing) void refresh(info.windowId);
});
chrome.tabs.onMoved.addListener((_tabId, info) => { void refresh(info.windowId); });
/** A moved tab is no longer included when its old window restores its titles. */
chrome.tabs.onAttached.addListener((tabId, info) => {
  void enqueue(async () => {
    if (activeWindowId === info.newWindowId) await paintWindow(info.newWindowId, true);
    else await chrome.tabs.sendMessage(tabId, { type: 'hint', hint: null }, { frameId: 0 }).catch(() => {});
  });
});
chrome.tabs.onDetached.addListener((_tabId, info) => { void refresh(info.oldWindowId); });
chrome.tabs.onUpdated.addListener((_tabId, change, tab) => {
  // Ignore title changes: our own prefixes must not trigger a repaint loop.
  if (change.status === 'complete') {
    void refresh(tab.windowId);
  }
});

/** Leaving the window ends the hold even when its page never receives keyup. */
chrome.windows.onFocusChanged.addListener(windowId => {
  void enqueue(async () => {
    if (activeWindowId !== windowId) await release();
  });
});

/** A closed window has no remaining titles to restore. */
chrome.windows.onRemoved.addListener(windowId => {
  void enqueue(async () => {
    if (activeWindowId === windowId) await setActiveWindow(null);
  });
});
