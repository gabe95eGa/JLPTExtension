(function () {
  "use strict";

  const EXT_NS = "jt4y-helper";
  const DEBUG = false;
  const DEFAULT_PREFS = {
    hideAnswerKeyByDefault: true,
    theme: "system",
    toolbarCollapsed: false,
    gptFeatureEnabled: false,
    ankiEnabled: true,
    ankiLastDeck: ""
  };

  const state = {
    root: null,
    answerKey: null,
    questions: [],
    selections: new Map(),
    checked: false,
    prefs: { ...DEFAULT_PREFS },
    answerKeyHidden: true,
    wrongQuestionNumbers: [],
    ankiDecks: [],
    ankiEndpoint: "http://127.0.0.1:8765"
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

    let endIndex = startIndex;
    let seenAnswerLine = false;
    let activeAnswerBlock = null;
    for (let i = startIndex + 1; i < nodes.length; i += 1) {
      const block = nodes[i].parentElement && (nodes[i].parentElement.closest("p, li, td, blockquote") || nodes[i].parentElement);
      const text = normalize(nodes[i].nodeValue);
      const blockText = normalize(block && block.innerText);
      const isAnswerLine = /^Question\s+\d+\s*:\s*[1-9]\d*/i.test(text) || /^Question\s+\d+\s*:\s*[1-9]\d*/i.test(blockText);
      const isSameAnswerBlock = seenAnswerLine && block && block === activeAnswerBlock;

      if (isAnswerLine || isSameAnswerBlock) {
        endIndex = i;
        seenAnswerLine = true;
        activeAnswerBlock = block;
        continue;
      }
      if (seenAnswerLine) break;
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

  const isBeforeAnswerKey = (node, answerKeySection) => {
    if (!answerKeySection || !answerKeySection.startNode || !node) return true;
    const position = node.compareDocumentPosition(answerKeySection.startNode);
    return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
  };

  const getNativeQuestionNumber = (input) => {
    const nameMatch = String(input.name || "").match(/^quest(?:ion)?(\d+)$/i);
    return nameMatch ? Number(nameMatch[1]) : null;
  };

  const getChoiceNodesAfterInput = (input) => {
    const nodes = [];
    let node = input.nextSibling;
    while (node) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.matches(`input[type="radio"], .${EXT_NS}`) || node.tagName === "BR") break;
        const display = window.getComputedStyle(node).display;
        if (display === "block" || display === "list-item" || display === "table-row") break;
      }
      nodes.push(node);
      node = node.nextSibling;
    }
    return nodes;
  };

  const getChoiceTextAfterInput = (input) => normalize(getChoiceNodesAfterInput(input).map((node) => node.textContent || "").join(" "));

  const parseNativeRadioQuestions = (root, answers, answerKeySection) => {
    const inputs = Array.from(root.querySelectorAll('input[type="radio"][name^="quest"]'))
      .filter((input) => isBeforeAnswerKey(input, answerKeySection))
      .filter((input) => {
        const questionNumber = getNativeQuestionNumber(input);
        return questionNumber && answers.has(questionNumber) && /^\d+$/.test(input.value || "");
      });

    const groups = new Map();
    inputs.forEach((input) => {
      const questionNumber = getNativeQuestionNumber(input);
      if (!groups.has(questionNumber)) groups.set(questionNumber, []);
      groups.get(questionNumber).push(input);
    });

    if (!groups.size) return [];

    const textNodes = textNodesUnder(root).filter((node) => isBeforeAnswerKey(node, answerKeySection));
    return Array.from(groups.entries())
      .sort(([left], [right]) => left - right)
      .map(([number, questionInputs]) => {
        const firstInput = questionInputs[0];
        const questionNode = textNodes
          .filter((node) => {
            const text = normalize(node.nodeValue);
            return new RegExp(`^${number}\\.\\s+`).test(text) && Boolean(node.compareDocumentPosition(firstInput) & Node.DOCUMENT_POSITION_FOLLOWING);
          })
          .pop();

        return {
          number,
          text: questionNode ? normalize(questionNode.nodeValue) : getQuestionTextBeforeChoice(firstInput),
          questionNode,
          bodyNodes: [],
          choices: questionInputs
            .sort((left, right) => Number(left.value) - Number(right.value))
            .map((input) => ({
              number: Number(input.value),
              text: getChoiceTextAfterInput(input),
              input,
              node: input
            })),
          grammarLinks: []
        };
      })
      .filter((question) => question.choices.length >= answers.get(question.number));
  };

  function parseQuestions(root, answers, answerKeySection) {
    const nativeQuestions = parseNativeRadioQuestions(root, answers, answerKeySection);

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

    const grammarLinks = getGrammarLinks(root);

    questions.forEach((question) => {
      question.grammarLinks = grammarLinks;
      if (!question.text) question.text = getQuestionTextBeforeChoice(question.choices[0] && question.choices[0].node);
    });

    const textQuestions = questions.filter((question) => answers.has(question.number) && question.choices.length >= answers.get(question.number));
    const mergedQuestions = new Map(textQuestions.map((question) => [question.number, question]));
    nativeQuestions.forEach((question) => {
      question.grammarLinks = grammarLinks;
      mergedQuestions.set(question.number, question);
    });

    return Array.from(mergedQuestions.values()).sort((left, right) => left.number - right.number);
  }

  const getGrammarLinks = (root) => Array.from(root.querySelectorAll("a[href]"))
    .filter((anchor) => !anchor.closest(`.${EXT_NS}`))
    .filter((anchor) => /grammar|jlpt|japanese/i.test(anchor.href) || /Grammar points/i.test(normalize(anchor.parentElement && anchor.parentElement.textContent)))
    .map((anchor) => ({ text: normalize(anchor.textContent), href: anchor.href }));

  const wrapAnswerKey = (answerKeySection) => {
    if (!answerKeySection || answerKeySection.wrapper) return answerKeySection && answerKeySection.wrapper;
    const start = answerKeySection.startNode;
    const end = answerKeySection.endNode;
    const commonParent = start.parentNode === end.parentNode ? start.parentNode : start.parentElement;
    if (!commonParent) return null;

    const wrapper = document.createElement("section");
    wrapper.className = `${EXT_NS} ${EXT_NS}__answer-key`;
    wrapper.setAttribute("aria-label", "Original answer key");
    const placeholder = document.createElement("div");
    placeholder.className = `${EXT_NS} ${EXT_NS}__answer-key-placeholder`;
    placeholder.setAttribute("role", "status");
    placeholder.textContent = "Answer key hidden by JLPT Helper";

    if (start.parentNode === end.parentNode) {
      const parent = start.parentNode;
      parent.insertBefore(placeholder, start);
      parent.insertBefore(wrapper, start);
      let node = start;
      while (node) {
        const next = node.nextSibling;
        wrapper.appendChild(node);
        if (node === end) break;
        node = next;
      }
    } else {
      const startBlock = start.parentElement.closest("p, li, td, blockquote") || start.parentElement;
      startBlock.parentNode.insertBefore(placeholder, startBlock);
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
    answerKeySection.placeholder = placeholder;
    answerKeySection.hiddenElements = [];
    return wrapper;
  };

  const updateAnswerKeyVisibility = () => {
    const wrapper = state.answerKey && state.answerKey.wrapper;
    if (!wrapper) return;
    wrapper.classList.toggle(`${EXT_NS}__answer-key--hidden`, state.answerKeyHidden);
    if (state.answerKey.placeholder) {
      state.answerKey.placeholder.hidden = !state.answerKeyHidden;
    }
    (state.answerKey.hiddenElements || []).forEach((element) => {
      element.classList.toggle(`${EXT_NS}__answer-key-line--hidden`, state.answerKeyHidden);
    });
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

        const input = choice.input || document.createElement("input");
        if (!choice.input) {
          input.type = "radio";
          input.name = `${EXT_NS}-q-${question.number}`;
          input.value = String(choice.number);
          input.classList.add(`${EXT_NS}__synthetic-input`);
        } else {
          input.classList.add(`${EXT_NS}__native-input`);
        }
        input.setAttribute("aria-label", `Question ${question.number}, answer ${choice.number}`);

        const badge = document.createElement("span");
        badge.className = `${EXT_NS}__choice-number`;
        badge.textContent = String(choice.number);

        const choiceNodes = choice.input ? getChoiceNodesAfterInput(choice.input) : [choice.node];
        const insertionParent = choice.input ? input.parentNode : choice.node.parentNode;
        const insertionBefore = choice.input ? input : choice.node;
        insertionParent.insertBefore(label, insertionBefore);
        label.appendChild(input);
        label.appendChild(badge);
        choiceNodes.forEach((node) => label.appendChild(node));
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

  const ankiRequest = async (action, params = {}) => {
    if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.sendMessage) {
      throw new Error("Extension runtime is unavailable.");
    }

    const response = await chrome.runtime.sendMessage({
      type: "ankiRequest",
      action,
      params
    });

    if (!response || !response.ok) {
      throw new Error(response && response.error ? response.error : "Could not connect to AnkiConnect.");
    }
    state.ankiEndpoint = response.endpoint || state.ankiEndpoint;
    return response.result;
  };

  const loadAnkiDecks = async () => {
    if (!state.prefs.ankiEnabled) return [];
    state.ankiDecks = await ankiRequest("deckNames");
    return state.ankiDecks;
  };

  const getSelectionText = () => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return "";
    if (!state.root || !state.root.contains(selection.anchorNode) || !state.root.contains(selection.focusNode)) return "";
    return normalize(selection.toString()).slice(0, 80);
  };

  const hideAnkiPopup = () => {
    const popup = document.querySelector(`#${EXT_NS}-anki-popup`);
    if (popup) popup.hidden = true;
  };

  const addSelectionToAnki = async (term, deckName) => {
    if (!term || !deckName) return;

    // Anki integration stores only the user-highlighted term plus a source link.
    // It does not copy whole questions, choices, or answer keys into Anki.
    await ankiRequest("addNote", {
      note: {
        deckName,
        modelName: "Basic",
        fields: {
          Front: term,
          Back: `Source: <a href="${escapeHtml(`${location.origin}${location.pathname}`)}">${escapeHtml(document.title || location.hostname)}</a>`
        },
        tags: ["jlpt-helper", "japanesetest4you"],
        options: {
          allowDuplicate: false,
          duplicateScope: "deck"
        }
      }
    });

    state.prefs.ankiLastDeck = deckName;
    await storageSet({ ankiLastDeck: deckName });
    showToast(`Added "${term}" to Anki.`);
    hideAnkiPopup();
  };

  const ensureAnkiPopup = () => {
    let popup = document.querySelector(`#${EXT_NS}-anki-popup`);
    if (popup) return popup;

    popup = document.createElement("div");
    popup.id = `${EXT_NS}-anki-popup`;
    popup.className = `${EXT_NS} ${EXT_NS}__anki-popup`;
    popup.hidden = true;
    popup.innerHTML = `
      <div class="${EXT_NS}__anki-term" id="${EXT_NS}-anki-term"></div>
      <div class="${EXT_NS}__anki-controls">
        <select id="${EXT_NS}-anki-deck" aria-label="Choose Anki deck"></select>
        <button type="button" id="${EXT_NS}-anki-add">Add to Anki</button>
      </div>
      <div class="${EXT_NS}__anki-status" id="${EXT_NS}-anki-status" role="status"></div>
    `;
    document.body.appendChild(popup);

    popup.addEventListener("mousedown", (event) => event.preventDefault());
    popup.querySelector(`#${EXT_NS}-anki-add`).addEventListener("click", async () => {
      const term = popup.dataset.term || "";
      const deckName = popup.querySelector(`#${EXT_NS}-anki-deck`).value;
      const status = popup.querySelector(`#${EXT_NS}-anki-status`);
      try {
        status.textContent = "Adding...";
        await addSelectionToAnki(term, deckName);
      } catch (error) {
        status.textContent = "Open Anki with AnkiConnect enabled, then try again.";
        console.warn("[JLPT Helper] Anki add failed:", error);
      }
    });

    document.addEventListener("mousedown", (event) => {
      if (!popup.hidden && !popup.contains(event.target)) hideAnkiPopup();
    });

    return popup;
  };

  const showAnkiPopupForSelection = async () => {
    if (!state.prefs.ankiEnabled) return;
    const term = getSelectionText();
    if (!term || term.length > 80) {
      hideAnkiPopup();
      return;
    }

    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) {
      hideAnkiPopup();
      return;
    }
    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) return;

    const popup = ensureAnkiPopup();
    const deckSelect = popup.querySelector(`#${EXT_NS}-anki-deck`);
    const status = popup.querySelector(`#${EXT_NS}-anki-status`);
    popup.dataset.term = term;
    popup.querySelector(`#${EXT_NS}-anki-term`).textContent = term;
    status.textContent = "Loading decks...";
    popup.hidden = false;
    popup.style.left = `${Math.min(window.innerWidth - 280, Math.max(10, rect.left + window.scrollX))}px`;
    popup.style.top = `${rect.bottom + window.scrollY + 8}px`;

    try {
      const decks = await loadAnkiDecks();
      deckSelect.innerHTML = decks
        .map((deck) => `<option value="${escapeHtml(deck)}">${escapeHtml(deck)}</option>`)
        .join("");
      const preferredDeck = state.prefs.ankiLastDeck && decks.includes(state.prefs.ankiLastDeck)
        ? state.prefs.ankiLastDeck
        : decks[0];
      if (preferredDeck) deckSelect.value = preferredDeck;
      status.textContent = decks.length ? "" : "No decks found.";
    } catch (error) {
      deckSelect.innerHTML = `<option value="">Anki unavailable</option>`;
      status.textContent = "Open Anki with AnkiConnect enabled.";
      console.warn("[JLPT Helper] Anki deck load failed:", error);
    }
  };

  const initAnkiSelection = () => {
    if (!state.prefs.ankiEnabled) return;
    let timer = null;
    const schedule = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(showAnkiPopupForSelection, 160);
    };
    document.addEventListener("mouseup", schedule);
    document.addEventListener("keyup", (event) => {
      if (event.key === "Escape") {
        hideAnkiPopup();
        return;
      }
      schedule();
    });
    document.addEventListener("selectionchange", () => {
      if (!getSelectionText()) hideAnkiPopup();
    });
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
    initAnkiSelection();
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
