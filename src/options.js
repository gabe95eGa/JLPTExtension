const DEFAULT_PREFS = {
  hideAnswerKeyByDefault: true,
  theme: "system",
  darkModeScope: "helper",
  toolbarCollapsed: false,
  gptFeatureEnabled: false,
  ankiEnabled: true,
  ankiLastDeck: ""
};

const form = document.getElementById("options-form");
const status = document.getElementById("status");

const applyTheme = (theme, darkModeScope) => {
  document.documentElement.dataset.jt4yHelperTheme = theme || "system";
  document.documentElement.dataset.jt4yHelperDarkScope = darkModeScope || "helper";
};

chrome.storage.sync.get(DEFAULT_PREFS, (items) => {
  form.hideAnswerKeyByDefault.checked = Boolean(items.hideAnswerKeyByDefault);
  form.theme.value = items.theme || "system";
  form.darkModeScope.value = items.darkModeScope || "helper";
  form.gptFeatureEnabled.checked = Boolean(items.gptFeatureEnabled);
  form.ankiEnabled.checked = Boolean(items.ankiEnabled);
  applyTheme(form.theme.value, form.darkModeScope.value);
});

form.theme.addEventListener("change", () => applyTheme(form.theme.value, form.darkModeScope.value));
form.darkModeScope.addEventListener("change", () => applyTheme(form.theme.value, form.darkModeScope.value));

form.addEventListener("submit", (event) => {
  event.preventDefault();
  chrome.storage.sync.set({
    hideAnswerKeyByDefault: form.hideAnswerKeyByDefault.checked,
    theme: form.theme.value,
    darkModeScope: form.darkModeScope.value,
    gptFeatureEnabled: form.gptFeatureEnabled.checked,
    ankiEnabled: form.ankiEnabled.checked
  }, () => {
    status.textContent = "Options saved.";
    setTimeout(() => {
      status.textContent = "";
    }, 1800);
  });
});
