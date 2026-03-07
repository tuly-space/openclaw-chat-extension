// background.js - Service worker: open side panel on toolbar click

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});
