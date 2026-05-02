# JLPT Page Practice Helper

A launch-ready Manifest V3 Chrome extension that adds an interactive correction layer to compatible JLPT practice pages on Japanesetest4you.com.

The extension is intentionally copyright-conscious: it does not bundle, copy, mirror, redistribute, bulk scrape, or permanently store Japanesetest4you quiz content. It only reads the DOM of the page currently open in the user's browser and injects controls beside the existing page content.

## Features

- Runs only on `https://japanesetest4you.com/*`.
- Detects compatible practice pages that include numbered questions and an `Answer Key` section.
- Parses answer key lines such as `Question 1: 2 (...)`.
- Adds one radio-style choice selector per answer choice.
- Uses accessible hidden radio inputs with clean numbered answer pills, avoiding duplicate visible controls.
- Adds a floating toolbar with:
  - Check answers
  - Reset
  - Show/hide answer key
  - Score
  - Progress count
  - Jump to first wrong answer
  - Copy mistake summary
- Hides the original answer key by default to reduce spoilers.
- Highlights correct choices in green, wrong selected choices in red, and unanswered questions neutrally.
- Stores only preferences and optional per-URL user notes. It does not store question text, choices, or answer keys.

## Local Installation

1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this extension folder.
5. Open a compatible page, for example:
   `https://japanesetest4you.com/japanese-language-proficiency-test-jlpt-n4-grammar-exercise-3/#more-33`

The `icons/` folder contains simple SVG placeholders. If you plan to package or publish the extension, replace them with production PNG icons and add an `icons` block to `manifest.json`.

## Manual Testing

1. Load the unpacked extension in Chrome.
2. Open the target Japanesetest4you page.
3. Confirm the answer key is hidden or collapsed.
4. Select one answer for several questions.
5. Click **Check answers**.
6. Confirm the score, green correct answers, and red wrong selections match the page's answer key.
7. Click **Jump to first wrong** and confirm the page scrolls to the first unanswered or incorrect question.
8. Click **Reset** and confirm selections and highlights are cleared.
9. Toggle **Show answer key** and confirm the original answer key appears.
10. Test at least one more Japanesetest4you exercise page, ideally from another JLPT level or category.

## How The Parser Works

The content script waits until the page is idle, then:

1. Searches likely article/content containers for both numbered questions and an `Answer Key` section.
2. Locates the answer key text with `findAnswerKeySection`.
3. Extracts correct choice numbers with `parseAnswerKey`.
4. Reads visible text nodes before the answer key and groups each numbered question into a block. The final answer-like lines in that block become choices, while earlier continuation lines remain part of the question prompt.
5. Injects radio controls beside the existing answer choice text with `injectQuizControls`.
6. Compares user selections to the DOM-derived answer key only when the user clicks **Check answers**.

The implementation exposes these functions on `window.JT4YHelper` for console inspection:

- `findAnswerKeySection`
- `parseAnswerKey`
- `parseQuestions`
- `injectQuizControls`
- `checkAnswers`
- `resetQuiz`

## Privacy And Copyright

This extension enhances the original website while the user is viewing it. It does not create a copied quiz database, mirror the content, or replace the website.

The extension does not send page content to external servers. It does not store questions, answer choices, or answer keys in Chrome extension storage. Stored data is limited to user preferences, toolbar state, and optional user-written notes scoped to the current URL.

The optional GPT helper is disabled by default. In this first version, the button only shows a warning. A future implementation should require explicit user approval and send only minimal context selected by the user.

## Known Limitations

- The parser is designed around Japanesetest4you pages that use plain numbered question lines followed by answer choice lines and an `Answer Key` section.
- Pages with unusual layouts, tables, audio-only questions, image-only choices, or heavily nested markup may not be detected.
- The answer key wrapper is conservative but may not perfectly collapse every possible page variant.
- The extension is tested for desktop Chrome. Mobile browsers are not a target for this version.

## Future Improvements

- Add a small parser test harness with saved synthetic DOM fixtures.
- Support pages where answer choices are inside tables or lists.
- Add richer review mode that shows only question numbers and result states.
- Add user-approved GPT integration that sends only minimal context and never runs automatically.
- Add per-site parser diagnostics in the popup for unsupported pages.
