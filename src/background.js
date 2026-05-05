"use strict";

const ANKI_ENDPOINTS = [
  "http://127.0.0.1:8765",
  "http://localhost:8765"
];

const ankiRequest = async (action, params = {}) => {
  const payload = {
    action,
    version: 6,
    params
  };

  let lastError = null;
  for (const endpoint of ANKI_ENDPOINTS) {
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (data.error) throw new Error(data.error);
      return { ok: true, result: data.result, endpoint };
    } catch (error) {
      lastError = error;
    }
  }

  return {
    ok: false,
    error: lastError ? lastError.message : "Could not connect to AnkiConnect."
  };
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || message.type !== "ankiRequest") return false;

  ankiRequest(message.action, message.params)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});
