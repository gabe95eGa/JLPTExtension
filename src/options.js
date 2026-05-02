const DEFAULT_PREFS = {
  hideAnswerKeyByDefault: true,
  theme: "system",
  toolbarCollapsed: false,
  gptFeatureEnabled: false
};

const form = document.getElementById("options-form");
const status = document.getElementById("status");

chrome.storage.sync.get(DEFAULT_PREFS, (items) => {
  form.hideAnswerKeyByDefault.checked = Boolean(items.hideAnswerKeyByDefault);
  form.theme.value = items.theme || "system";
  form.gptFeatureEnabled.checked = Boolean(items.gptFeatureEnabled);
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  chrome.storage.sync.set({
    hideAnswerKeyByDefault: form.hideAnswerKeyByDefault.checked,
    theme: form.theme.value,
    gptFeatureEnabled: form.gptFeatureEnabled.checked
  }, () => {
    status.textContent = "Options saved.";
    setTimeout(() => {
      status.textContent = "";
    }, 1800);
  });
});
