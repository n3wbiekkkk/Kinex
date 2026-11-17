chrome.runtime.onInstalled.addListener(() => {
  void chrome.storage.local.set({ installed: true });
});
