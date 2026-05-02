(function () {
  "use strict";

  const EXT_NS = "jt4y-helper";
  const DEBUG = false;
  const DEFAULT_PREFS = {
    hideAnswerKeyByDefault: true,
    theme: "system",
    toolbarCollapsed: false,
    gptFeatureEnabled: false
  };

  const state = {
    root: null,
    answerKey: null,
    questions: [],
    selections: new Map(),
    checked: false,
    prefs: { ...DEFAULT_PREFS },
    answerKeyHidden: true,
    wrongQuestionNumbers: []
  };

  const log = (...args) => {
    if (DEBUG) console.debug("[JLPT Helper]", ...args);
  };

  const escapeHtml = (value) =>
    String(value).replace(/[&<>"']/g, (char) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "\"": "&quot;",
      "'": "&#039;"
    })[char]);

  const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const getChromeStorage = () => {
    if (typeof chrome === "undefined" || !chrome.storage) return null;
    return chrome.storage;
  };

  const storageGet = (keys) => new Promise((resolve) => {
    const storage = getChromeStorage();
    if (!storage) {
      resolve({});
      return;
    }
    storage.sync.get(keys, resolve);
  });

  const storageSet = (items) => new Promise((resolve) => {
    const storage = getChromeStorage();
    if (!storage) {
      resolve();
      return;
    }
    storage.sync.set(items, resolve);
  });

  const isVisibleElement = (element) => {
    if (!element || element.nodeType !== Node.ELEMENT_NODE) return true;
    if (element.closest(`.${EXT_NS}, script, style, noscript, template`)) return false;
    const style = window.getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden";
  };

  const textNodesUnder = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = normalize(node.nodeValue);
        if (!text || !isVisibleElement(node.parentElement)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const nodes = [];
    let node = walker.nextNode();
    while (node) {
      nodes.push(node);
      node = walker.nextNode();
    }
    return nodes;
  };

  const findSmallestCompatibleRoot = () => {
    const candidates = Array.from(document.querySelectorAll("article, main, .entry-content, .post, .post-content, .content, #content"));
    const scored = candidates
      .filter((element) => !element.closest(`.${EXT_NS}`))
      .map((element) => {
        const text = element.innerText || "";
        const keyMatches = text.match(/Question\s+\d+\s*:\s*\d/gi) || [];
        const questionMatches = text.match(/(?:^|\n)\s*\d+\.\s+/g) || [];
        return { element, score: keyMatches.length * 4 + questionMatches.length, length: text.length };
      })
      .filter((item) => item.score >= 8 && /Answer\s+Key\s*:/i.test(item.element.innerText || ""))
      .sort((a, b) => b.score - a.score || a.length - b.length);

    if (scored.length) return scored[0].element;

    const bodyText = document.body.innerText || "";
    if (/Answer\s+Key\s*:/i.test(bodyText) && /Question\s+\d+\s*:\s*\d/i.test(bodyText)) {
      return document.body;
    }
    return null;
  };

  function findAnswerKeySection(root) {
    const nodes = textNodesUnder(root);
    const startIndex = nodes.findIndex((node) => /Answer\s+Key\s*:/i.test(node.nodeValue));
    if (startIndex === -1) return null;

    const stopPatterns = [
      /^New words\s*:/i,
      /^Grammar points/i,
      /^If you find/i,
      /^Featured posts/i,
      /^Categories/i,
      /^JLPT\s+N\d/i
    ];
    let endIndex = nodes.length - 1;
    for (let i = startIndex + 1; i < nodes.length; i += 1) {
      const text = normalize(nodes[i].nodeValue);
      if (stopPatterns.some((pattern) => pattern.test(text))) {
        endIndex = i - 1;
        break;
      }
    }

    const text = nodes.slice(startIndex, endIndex + 1).map((node) => node.nodeValue).join("\n");
    return {
      startNode: nodes[startIndex],
      endNode: nodes[endIndex],
      text,
      wrapper: null
    };
  }

  function parseAnswerKey(answerKeyText) {
    const answers = new Map();
    const regex = /Question\s+(\d+)\s*:\s*([1-9]\d*)/gi;
    let match = regex.exec(answerKeyText);
    while (match) {
      answers.set(Number(match[1]), Number(match[2]));
      match = regex.exec(answerKeyText);
    }
    return answers;
  }

  const previousElementSiblingDeep = (node) => {
    let current = node;
    while (current && current !== state.root) {
      if (current.previousSibling) {
        current = current.previousSibling;
        while (current.lastChild) current = current.lastChild;
        return current.nodeType === Node.ELEMENT_NODE ? current : current.parentElement;
      }
      current = current.parentNode;
    }
    return null;
  };

  const getQuestionTextBeforeChoice = (choiceNode) => {
    let current = choiceNode;
    for (let guard = 0; guard < 20; guard += 1) {
      current = previousElementSiblingDeep(current);
      if (!current) break;
      const text = normalize(current.textContent);
      if (/^\d+\.\s+/.test(text)) return text;
      if (/Answer\s+Key\s*:/i.test(text)) break;
    }
    return "";
  };

  function parseQuestions(root, answers, answerKeySection) {
    const nodes = textNodesUnder(root);
    const startIndex = answerKeySection ? nodes.indexOf(answerKeySection.startNode) : nodes.length;
    const usableNodes = startIndex > -1 ? nodes.slice(0, startIndex) : nodes;
    const questions = [];
    let current = null;
    const expectedChoiceCount = Math.max(4, ...Array.from(answers.values()));

    usableNodes.forEach((node) => {
      const text = normalize(node.nodeValue);
      const questionMatch = text.match(/^(\d+)\.\s+(.+)/);
      if (questionMatch && answers.has(Number(questionMatch[1]))) {
        current = {
          number: Number(questionMatch[1]),
          text,
          questionNode: node,
          bodyNodes: [],
          choices: [],
          grammarLinks: []
        };
        questions.push(current);
        return;
      }

      if (!current) return;
      if (/^(Answer\s+Key|Question\s+\d+\s*:|New words|Grammar points)/i.test(text)) return;
      if (/^\d+\.\s+/.test(text)) return;

      current.bodyNodes.push({ text, node });
    });

    questions.forEach((question) => {
      const answerLikeNodes = question.bodyNodes.filter((item) => item.text.length <= 140);
      const choiceItems = answerLikeNodes.slice(-expectedChoiceCount);
      const promptItems = question.bodyNodes.slice(0, Math.max(0, question.bodyNodes.length - choiceItems.length));

      question.text = [question.text].concat(promptItems.map((item) => item.text)).join(" ");
      question.choices = choiceItems.map((item, index) => ({
        number: index + 1,
        text: item.text,
        node: item.node
      }));
    });

    const grammarLinks = Array.from(root.querySelectorAll("a[href]"))
      .filter((anchor) => !anchor.closest(`.${EXT_NS}`))
      .filter((anchor) => /grammar|jlpt|japanese/i.test(anchor.href) || /Grammar points/i.test(normalize(anchor.parentElement && anchor.parentElement.textContent)))
      .map((anchor) => ({ text: normalize(anchor.textContent), href: anchor.href }));

    questions.forEach((question) => {
      question.grammarLinks = grammarLinks;
      if (!question.text) question.text = getQuestionTextBeforeChoice(question.choices[0] && question.choices[0].node);
    });

    return questions.filter((question) => answers.has(question.number) && question.choices.length >= answers.get(question.number));
  }

  const wrapAnswerKey = (answerKeySection) => {
    if (!answerKeySection || answerKeySection.wrapper) return answerKeySection && answerKeySection.wrapper;
    const start = answerKeySection.startNode;
    const end = answerKeySection.endNode;
    const commonParent = start.parentNode === end.parentNode ? start.parentNode : start.parentElement;
    if (!commonParent) return null;

    const wrapper = document.createElement("section");
    wrapper.className = `${EXT_NS} ${EXT_NS}__answer-key`;
    wrapper.setAttribute("aria-label", "Original answer key");

    if (start.parentNode === end.parentNode) {
      const parent = start.parentNode;
      parent.insertBefore(wrapper, start);
      let node = start;
      while (node) {
        const next = node.nextSibling;
        wrapper.appendChild(node);
        if (node === end) break;
        node = next;
      }
    } else {
      const startBlock = start.parentElement;
      startBlock.parentNode.insertBefore(wrapper, startBlock);
      let node = startBlock;
      while (node) {
        const next = node.nextSibling;
        wrapper.appendChild(node);
        if (node.contains(end)) break;
        node = next;
      }
    }

    answerKeySection.wrapper = wrapper;
    return wrapper;
  };

  const updateAnswerKeyVisibility = () => {
    const wrapper = state.answerKey && state.answerKey.wrapper;
    if (!wrapper) return;
    wrapper.classList.toggle(`${EXT_NS}__answer-key--hidden`, state.answerKeyHidden);
    const toggle = document.querySelector(`#${EXT_NS}-toggle-key`);
    if (toggle) {
      toggle.textContent = state.answerKeyHidden ? "Show answer key" : "Hide answer key";
      toggle.setAttribute("aria-pressed", String(!state.answerKeyHidden));
    }
  };

  const markQuestionElement = (question, status) => {
    const elements = [question.questionNode && question.questionNode.parentElement]
      .concat(question.choices.map((choice) => choice.wrapper))
      .filter(Boolean);
    elements.forEach((element) => {
      element.classList.remove(`${EXT_NS}--correct`, `${EXT_NS}--wrong`, `${EXT_NS}--unanswered`);
      if (status) element.classList.add(`${EXT_NS}--${status}`);
    });
  };

  const updateProgress = () => {
    const answered = state.questions.filter((question) => state.selections.has(question.number)).length;
    const total = state.questions.length;
    const progress = document.querySelector(`#${EXT_NS}-progress`);
    if (progress) progress.textContent = `${answered}/${total} answered`;
  };

  const updateScore = (correct, total) => {
    const score = document.querySelector(`#${EXT_NS}-score`);
    if (!score) return;
    if (typeof correct !== "number") {
      score.textContent = `Score: -/${total}`;
      return;
    }
    const percentage = total ? Math.round((correct / total) * 100) : 0;
    score.textContent = `Score: ${correct}/${total} (${percentage}%)`;
  };

  const setTheme = () => {
    document.documentElement.dataset.jt4yHelperTheme = state.prefs.theme || "system";
  };

  function injectQuizControls(questions) {
    questions.forEach((question) => {
      question.choices.forEach((choice) => {
        const label = document.createElement("label");
        label.className = `${EXT_NS} ${EXT_NS}__choice`;
        label.dataset.question = String(question.number);
        label.dataset.choice = String(choice.number);

        const input = document.createElement("input");
        input.type = "radio";
        input.name = `${EXT_NS}-q-${question.number}`;
        input.value = String(choice.number);
        input.setAttribute("aria-label", `Question ${question.number}, answer ${choice.number}`);

        const badge = document.createElement("span");
        badge.className = `${EXT_NS}__choice-number`;
        badge.textContent = String(choice.number);

        choice.node.parentNode.insertBefore(label, choice.node);
        label.appendChild(input);
        label.appendChild(badge);
        label.appendChild(choice.node);
        choice.wrapper = label;
        choice.input = input;

        input.addEventListener("change", () => {
          state.selections.set(question.number, choice.number);
          state.checked = false;
          question.choices.forEach((item) => item.wrapper.classList.remove(`${EXT_NS}--selected`));
          label.classList.add(`${EXT_NS}--selected`);
          markQuestionElement(question, null);
          updateProgress();
          updateScore(undefined, state.questions.length);
        });
      });
    });

    injectToolbar();
    updateProgress();
    updateScore(undefined, state.questions.length);
  }

  function checkAnswers() {
    let correct = 0;
    state.wrongQuestionNumbers = [];

    state.questions.forEach((question) => {
      const selected = state.selections.get(question.number);
      const correctChoice = state.answerKey.answers.get(question.number);

      question.choices.forEach((choice) => {
        choice.wrapper.classList.remove(`${EXT_NS}--correct`, `${EXT_NS}--wrong`, `${EXT_NS}--unanswered`);
        if (choice.number === correctChoice) choice.wrapper.classList.add(`${EXT_NS}--correct`);
        if (selected && choice.number === selected && selected !== correctChoice) choice.wrapper.classList.add(`${EXT_NS}--wrong`);
      });

      if (!selected) {
        markQuestionElement(question, "unanswered");
        state.wrongQuestionNumbers.push(question.number);
      } else if (selected === correctChoice) {
        correct += 1;
      } else {
        state.wrongQuestionNumbers.push(question.number);
      }
    });

    state.checked = true;
    updateScore(correct, state.questions.length);
    updateReviewPanel(correct);
  }

  function resetQuiz() {
    state.selections.clear();
    state.checked = false;
    state.wrongQuestionNumbers = [];
    state.questions.forEach((question) => {
      question.choices.forEach((choice) => {
        choice.input.checked = false;
        choice.wrapper.classList.remove(`${EXT_NS}--selected`, `${EXT_NS}--correct`, `${EXT_NS}--wrong`, `${EXT_NS}--unanswered`);
      });
      markQuestionElement(question, null);
    });
    updateProgress();
    updateScore(undefined, state.questions.length);
    updateReviewPanel();
  }

  const firstProblemQuestion = () => {
    const number = state.wrongQuestionNumbers[0];
    return state.questions.find((question) => question.number === number);
  };

  const jumpToFirstWrong = () => {
    if (!state.checked) checkAnswers();
    const question = firstProblemQuestion();
    if (!question) return;
    const target = question.questionNode.parentElement || question.choices[0].wrapper;
    target.scrollIntoView({ behavior: "smooth", block: "center" });
    target.classList.add(`${EXT_NS}__focus-pulse`);
    setTimeout(() => target.classList.remove(`${EXT_NS}__focus-pulse`), 1200);
  };

  const copyMistakeSummary = async () => {
    if (!state.checked) checkAnswers();
    const lines = [
      `JLPT practice result for ${location.href}`,
      `Total questions: ${state.questions.length}`,
      `Needs review: ${state.wrongQuestionNumbers.length ? state.wrongQuestionNumbers.join(", ") : "none"}`
    ];
    state.questions.forEach((question) => {
      const selected = state.selections.get(question.number) || "unanswered";
      const correct = state.answerKey.answers.get(question.number);
      const result = selected === correct ? "correct" : "review";
      lines.push(`Question ${question.number}: selected ${selected}, answer ${correct}, ${result}`);
    });
    await navigator.clipboard.writeText(lines.join("\n"));
    showToast("Mistake summary copied without question text.");
  };

  const showGptWarning = () => {
    window.alert("GPT help is disabled by default. If enabled in options, share only the minimal context you approve. This extension does not automatically send page content anywhere.");
  };

  const updateReviewPanel = (correct) => {
    let panel = document.querySelector(`#${EXT_NS}-review`);
    if (!panel) {
      panel = document.createElement("div");
      panel.id = `${EXT_NS}-review`;
      panel.className = `${EXT_NS} ${EXT_NS}__review`;
      document.body.appendChild(panel);
    }
    if (!state.checked) {
      panel.hidden = true;
      return;
    }
    const wrong = state.wrongQuestionNumbers;
    const total = state.questions.length;
    const scoreText = typeof correct === "number" ? `${correct}/${total}` : "";
    const grammarLinks = [];
    const seenLinks = new Set();
    state.questions
      .flatMap((question) => question.grammarLinks || [])
      .forEach((link) => {
        if (!link.href || seenLinks.has(link.href) || grammarLinks.length >= 8) return;
        seenLinks.add(link.href);
        grammarLinks.push(link);
      });
    const linkHtml = grammarLinks.length
      ? `<div class="${EXT_NS}__review-links">${grammarLinks.map((link) => `<a href="${escapeHtml(link.href)}">${escapeHtml(link.text || "Study link")}</a>`).join("")}</div>`
      : "";
    panel.hidden = false;
    panel.innerHTML = `
      <strong>Review</strong>
      <span>${escapeHtml(scoreText)} ${wrong.length ? `Questions to review: ${escapeHtml(wrong.join(", "))}` : "All checked answers are correct."}</span>
      ${linkHtml}
    `;
  };

  const showToast = (message) => {
    const toast = document.createElement("div");
    toast.className = `${EXT_NS} ${EXT_NS}__toast`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 2200);
  };

  const injectToolbar = () => {
    if (document.querySelector(`#${EXT_NS}-toolbar`)) return;
    const toolbar = document.createElement("aside");
    toolbar.id = `${EXT_NS}-toolbar`;
    toolbar.className = `${EXT_NS} ${EXT_NS}__toolbar`;
    toolbar.setAttribute("aria-label", "JLPT practice helper toolbar");
    if (state.prefs.toolbarCollapsed) toolbar.classList.add(`${EXT_NS}__toolbar--collapsed`);

    toolbar.innerHTML = `
      <div class="${EXT_NS}__toolbar-head">
        <strong>JLPT Helper</strong>
        <button type="button" id="${EXT_NS}-collapse" aria-label="Collapse toolbar" aria-expanded="${String(!state.prefs.toolbarCollapsed)}">-</button>
      </div>
      <div class="${EXT_NS}__toolbar-body">
        <div class="${EXT_NS}__metrics">
          <span id="${EXT_NS}-score">Score: -/${state.questions.length}</span>
          <span id="${EXT_NS}-progress">0/${state.questions.length} answered</span>
        </div>
        <button type="button" id="${EXT_NS}-check">Check answers</button>
        <button type="button" id="${EXT_NS}-reset">Reset</button>
        <button type="button" id="${EXT_NS}-toggle-key" aria-pressed="false">Show answer key</button>
        <button type="button" id="${EXT_NS}-jump">Jump to first wrong</button>
        <button type="button" id="${EXT_NS}-copy">Copy mistake summary</button>
        <button type="button" id="${EXT_NS}-gpt">Ask GPT about mistake</button>
      </div>
    `;

    document.body.appendChild(toolbar);
    toolbar.querySelector(`#${EXT_NS}-check`).addEventListener("click", checkAnswers);
    toolbar.querySelector(`#${EXT_NS}-reset`).addEventListener("click", resetQuiz);
    toolbar.querySelector(`#${EXT_NS}-jump`).addEventListener("click", jumpToFirstWrong);
    toolbar.querySelector(`#${EXT_NS}-copy`).addEventListener("click", copyMistakeSummary);
    toolbar.querySelector(`#${EXT_NS}-gpt`).addEventListener("click", showGptWarning);
    toolbar.querySelector(`#${EXT_NS}-toggle-key`).addEventListener("click", async () => {
      state.answerKeyHidden = !state.answerKeyHidden;
      updateAnswerKeyVisibility();
    });
    toolbar.querySelector(`#${EXT_NS}-collapse`).addEventListener("click", async (event) => {
      state.prefs.toolbarCollapsed = !state.prefs.toolbarCollapsed;
      toolbar.classList.toggle(`${EXT_NS}__toolbar--collapsed`, state.prefs.toolbarCollapsed);
      event.currentTarget.setAttribute("aria-expanded", String(!state.prefs.toolbarCollapsed));
      await storageSet({ toolbarCollapsed: state.prefs.toolbarCollapsed });
    });
  };

  const initNotes = () => {
    const container = document.createElement("section");
    container.className = `${EXT_NS} ${EXT_NS}__notes`;
    container.innerHTML = `
      <label for="${EXT_NS}-notes"><strong>Local notes for this URL</strong></label>
      <textarea id="${EXT_NS}-notes" rows="3" placeholder="Your private note. Avoid pasting full questions here."></textarea>
    `;
    state.root.appendChild(container);
    const textarea = container.querySelector("textarea");
    const key = `notes:${location.origin}${location.pathname}`;
    storageGet([key]).then((items) => {
      textarea.value = items[key] || "";
    });
    textarea.addEventListener("change", () => {
      storageSet({ [key]: textarea.value.slice(0, 4000) });
    });
  };

  const init = async () => {
    if (document.documentElement.dataset.jt4yHelperInitialized === "true") return;
    if (location.hostname !== "japanesetest4you.com") return;

    const storedPrefs = await storageGet(Object.keys(DEFAULT_PREFS));
    state.prefs = { ...DEFAULT_PREFS, ...storedPrefs };
    setTheme();

    const root = findSmallestCompatibleRoot();
    if (!root) {
      log("Compatible quiz structure not found.");
      return;
    }

    const answerKeySection = findAnswerKeySection(root);
    if (!answerKeySection) return;
    const answers = parseAnswerKey(answerKeySection.text);
    if (answers.size === 0) return;

    state.root = root;
    state.answerKey = { ...answerKeySection, answers };
    state.questions = parseQuestions(root, answers, answerKeySection);
    if (state.questions.length < Math.min(answers.size, 3)) {
      log("Question parsing produced too few questions.", state.questions);
      return;
    }

    document.documentElement.dataset.jt4yHelperInitialized = "true";

    // Copyright-conscious design: the extension reads only the page the user is
    // viewing, injects controls beside the existing DOM, and does not copy quiz
    // content into extension storage or any bundled database.
    wrapAnswerKey(state.answerKey);
    state.answerKeyHidden = Boolean(state.prefs.hideAnswerKeyByDefault);
    injectQuizControls(state.questions);
    updateAnswerKeyVisibility();
    initNotes();
  };

  window.JT4YHelper = {
    findAnswerKeySection,
    parseAnswerKey,
    parseQuestions,
    injectQuizControls,
    checkAnswers,
    resetQuiz
  };

  init().catch((error) => {
    console.warn("[JLPT Helper] Failed to initialize:", error);
  });
})();
