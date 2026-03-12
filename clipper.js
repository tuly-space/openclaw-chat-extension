if (!globalThis.__openclawClipperInstalled) {
  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.action === "getSelection") {
      sendResponse({
        text: window.getSelection().toString(),
        url: location.href,
        title: document.title,
      });
      return false;
    }

    if (msg.action === "getPageContent") {
      sendResponse({
        text: extractPageContent(),
        url: location.href,
        title: document.title,
      });
      return false;
    }
  });

  globalThis.__openclawClipperInstalled = true;
}

function extractPageContent() {
  const clonedBody = document.body?.cloneNode(true);
  if (!clonedBody) return "";

  const removableSelectors = [
    "nav",
    "header",
    "footer",
    "aside",
    "script",
    "style",
    "noscript",
    '[class*="ad"]',
    '[id*="ad"]',
    '[class*="sidebar"]',
    '[class*="related"]',
    '[class*="recommend"]',
  ];

  for (const node of clonedBody.querySelectorAll(removableSelectors.join(","))) {
    node.remove();
  }

  const primary = clonedBody.querySelector("article, main, [role='main']");
  const text = (primary?.innerText || primary?.textContent || clonedBody.innerText || clonedBody.textContent || "").trim();
  return text.replace(/\n{3,}/g, "\n\n");
}
