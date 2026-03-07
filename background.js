// background.js — Service worker
// Handles: (1) open side panel on click, (2) proxy chat requests (bypass CORS)

chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Long-lived port for streaming chat
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "chat") return;

  port.onMessage.addListener(async (msg) => {
    if (msg.type === "SEND") {
      await handleChatStream(port, msg);
    } else if (msg.type === "ABORT") {
      // abortController is per-message; signal handled below
    }
  });
});

// Map portId → AbortController for cancellation
const abortControllers = new Map();

async function handleChatStream(port, msg) {
  const { text, settings, sessionKey } = msg;
  const ac = new AbortController();
  const portId = port.name + "_" + Date.now();
  abortControllers.set(port, ac);

  port.onDisconnect.addListener(() => {
    ac.abort();
    abortControllers.delete(port);
  });

  try {
    const agentId = settings.agentId || "main";
    const res = await fetch(`${settings.gatewayUrl}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${settings.token}`,
        "Content-Type": "application/json",
        "x-openclaw-session-key": sessionKey,
      },
      body: JSON.stringify({
        model: `openclaw:${agentId}`,
        messages: [{ role: "user", content: text }],
        stream: true,
      }),
      signal: ac.signal,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      port.postMessage({ type: "ERROR", message: `HTTP ${res.status}: ${body.slice(0, 200)}` });
      return;
    }

    port.postMessage({ type: "START" });

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop();

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === "data: [DONE]") continue;
        if (!trimmed.startsWith("data: ")) continue;
        try {
          const chunk = JSON.parse(trimmed.slice(6));
          const delta = chunk.choices?.[0]?.delta?.content;
          if (delta) port.postMessage({ type: "DELTA", delta });
        } catch (_) {}
      }
    }

    port.postMessage({ type: "DONE" });

  } catch (e) {
    if (e.name === "AbortError") {
      port.postMessage({ type: "ABORTED" });
    } else {
      port.postMessage({ type: "ERROR", message: e.message });
    }
  } finally {
    abortControllers.delete(port);
  }
}
