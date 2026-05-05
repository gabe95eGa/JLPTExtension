document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

const setText = (id, value) => {
  const element = document.getElementById(id);
  if (element) element.textContent = value;
};

const renderDiagnostics = (diagnostics) => {
  setText("diag-compatible", diagnostics.compatible ? "Compatible" : "Not detected");
  setText("diag-questions", String(diagnostics.questionCount || 0));
  setText("diag-answers", String(diagnostics.answerKeyCount || 0));
  setText("diag-radios", String(diagnostics.nativeRadioCount || 0));
  setText("diag-theme", `${diagnostics.theme || "system"} / ${diagnostics.darkModeScope || "helper"}`);
};

chrome.tabs.query({ active: true, currentWindow: true }, ([tab]) => {
  if (!tab || !tab.id || !/^https:\/\/japanesetest4you\.com\//.test(tab.url || "")) {
    setText("diag-compatible", "Open JT4Y page");
    return;
  }

  chrome.tabs.sendMessage(tab.id, { type: "getDiagnostics" }, (response) => {
    if (chrome.runtime.lastError || !response || !response.ok) {
      setText("diag-compatible", "Not detected");
      return;
    }
    renderDiagnostics(response.diagnostics || {});
  });
});
