import type { Locator, Page } from 'playwright';
import type { SelectorCandidate, Selectors } from './contracts.js';

export type SelectorSource = 'config' | 'hardcoded' | 'heuristic';

export interface ResolvedSelectors {
  source: SelectorSource;
  input: string;
  send: string;
  bubble: string;
  doneSignal?: string;
  candidates: SelectorCandidate[];
}

export interface MessageSnapshot {
  entries: MessageSnapshotEntry[];
  container: string;
}

interface MessageSnapshotEntry {
  key: string;
}

export interface SendResult {
  sent: boolean;
  bubble: string;
  send: string;
}

type SendConfirmation = Omit<SendResult, 'send'>;

interface HeuristicLocatorResult {
  selectors: ResolvedSelectors | null;
  candidates: SelectorCandidate[];
}

export async function resolveSelectors(
  page: Page,
  _url: string,
  selectors: Selectors | undefined,
): Promise<ResolvedSelectors | null> {
  if (selectors) {
    return { source: 'config', ...selectors, candidates: [] };
  }
  const heuristic = await heuristicLocate(page);
  return heuristic.selectors;
}

export async function heuristicLocate(page: Page): Promise<HeuristicLocatorResult> {
  return await page.evaluate(() => {
    type Candidate = { el: string; score: number; reason: string };
    type Result = {
      selectors: {
        source: 'heuristic';
        input: string;
        send: string;
        bubble: string;
        candidates: Candidate[];
      } | null;
      candidates: Candidate[];
    };

    const isElementVisible = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.visibility !== 'hidden' &&
        style.display !== 'none' &&
        rect.width > 0 &&
        rect.height > 0 &&
        rect.bottom >= 0 &&
        rect.right >= 0 &&
        rect.top <= window.innerHeight &&
        rect.left <= window.innerWidth
      );
    };

    const isEditable = (element: Element): boolean => {
      if (element instanceof HTMLTextAreaElement) return !element.disabled && !element.readOnly;
      if (element instanceof HTMLInputElement) {
        const type = (element.getAttribute('type') || 'text').toLowerCase();
        return (
          ['text', 'search', 'email', 'url', 'tel'].includes(type) &&
          !element.disabled &&
          !element.readOnly
        );
      }
      if (element instanceof HTMLElement && element.isContentEditable) return true;
      return false;
    };

    const cssEscape = (value: string): string => {
      const css = globalThis.CSS as { escape?: (text: string) => string } | undefined;
      return css?.escape ? css.escape(value) : value.replace(/["\\#.:,[\]>+~*'=]/g, '\\$&');
    };

    const uniqueSelector = (element: Element): string => {
      if (element.id) return `#${cssEscape(element.id)}`;
      const testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id');
      if (testId) return `[data-testid="${cssEscape(testId)}"]`;
      const aria = element.getAttribute('aria-label');
      if (aria) return `${element.tagName.toLowerCase()}[aria-label="${cssEscape(aria)}"]`;
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 4) {
        let part = current.tagName.toLowerCase();
        const classNames = Array.from(current.classList).filter(Boolean).slice(0, 2);
        if (classNames.length > 0) part += `.${classNames.map(cssEscape).join('.')}`;
        const parent: Element | null = current.parentElement;
        if (parent) {
          const tagName = current.tagName;
          const siblings = Array.from(parent.children).filter(
            (child: Element) => child.tagName === tagName,
          );
          if (siblings.length > 1) part += `:nth-of-type(${siblings.indexOf(current) + 1})`;
        }
        parts.unshift(part);
        const selector = parts.join(' > ');
        if (document.querySelectorAll(selector).length === 1) return selector;
        current = parent;
      }
      return parts.join(' > ') || element.tagName.toLowerCase();
    };

    const compactText = (text: string | null | undefined): string =>
      (text ?? '').replace(/\s+/g, ' ').trim();
    const keywordText = (element: Element): string =>
      [
        element.getAttribute('placeholder'),
        element.getAttribute('aria-label'),
        element.getAttribute('title'),
        element.getAttribute('name'),
        element.getAttribute('role'),
        compactText(element.textContent),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

    const scoreInput = (element: Element): Candidate => {
      const rect = element.getBoundingClientRect();
      let score = 0;
      const reasons: string[] = [];
      if (element instanceof HTMLTextAreaElement) {
        score += 25;
        reasons.push('textarea');
      } else if (element instanceof HTMLInputElement) {
        score += 18;
        reasons.push('text input');
      } else if (element instanceof HTMLElement && element.isContentEditable) {
        score += 22;
        reasons.push('contenteditable');
      }
      if (rect.top > window.innerHeight * 0.45) {
        score += 18;
        reasons.push('lower viewport');
      }
      if (rect.width >= Math.min(320, window.innerWidth * 0.35)) {
        score += 16;
        reasons.push('wide');
      }
      const text = keywordText(element);
      if (/(输入|消息|提问|问题|ask|message|chat|prompt|question)/i.test(text)) {
        score += 24;
        reasons.push('placeholder/label keyword');
      }
      if (element instanceof HTMLElement) {
        element.focus();
        if (document.activeElement === element || element.contains(document.activeElement)) {
          score += 10;
          reasons.push('focusable');
        }
      }
      if (element.getAttribute('role') === 'textbox') {
        score += 8;
        reasons.push('textbox role');
      }
      return {
        el: uniqueSelector(element),
        score,
        reason: reasons.join(', ') || 'editable candidate',
      };
    };

    const inputCandidates = Array.from(
      document.querySelectorAll(
        'textarea,input,[contenteditable="true"],[contenteditable=true],[role="textbox"]',
      ),
    )
      .filter((element) => isElementVisible(element) && isEditable(element))
      .map(scoreInput)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    const input = inputCandidates[0];
    if (!input || input.score < 35) {
      return { selectors: null, candidates: inputCandidates } satisfies Result;
    }

    const inputElement = document.querySelector(input.el);
    if (!inputElement) return { selectors: null, candidates: inputCandidates } satisfies Result;
    const inputRect = inputElement.getBoundingClientRect();

    const scoreSend = (element: Element): Candidate => {
      const rect = element.getBoundingClientRect();
      let score = 0;
      const reasons: string[] = [];
      if (element instanceof HTMLButtonElement) {
        if (element.disabled) {
          score -= 8;
          reasons.push('disabled while empty');
        }
        score += 18;
        reasons.push('button');
      }
      const text = keywordText(element);
      if (/(send|submit|发送|提交|问|arrow|paper|plane)/i.test(text)) {
        score += 30;
        reasons.push('send label');
      }
      const svg = element.querySelector('svg');
      if (svg && /(send|arrow|plane|发送)/i.test(keywordText(svg))) {
        score += 16;
        reasons.push('send svg');
      }
      const horizontallyNear =
        rect.left >= inputRect.left - 24 &&
        rect.left <= inputRect.right + 160 &&
        Math.abs((rect.top + rect.bottom) / 2 - (inputRect.top + inputRect.bottom) / 2) < 90;
      if (horizontallyNear) {
        score += 18;
        reasons.push('beside input');
      }
      if (rect.width <= 180 && rect.height <= 120) {
        score += 6;
        reasons.push('compact control');
      }
      return { el: uniqueSelector(element), score, reason: reasons.join(', ') || 'send candidate' };
    };

    const sendCandidates = Array.from(
      document.querySelectorAll('button,[role="button"],input[type="submit"]'),
    )
      .filter(isElementVisible)
      .map(scoreSend)
      .sort((a, b) => b.score - a.score)
      .slice(0, 8);

    const send =
      sendCandidates[0]?.score && sendCandidates[0].score >= 35 ? sendCandidates[0].el : 'Enter';
    const bubble = guessBubbleSelector(inputElement);
    const candidates = [...inputCandidates, ...sendCandidates];
    return {
      selectors: { source: 'heuristic', input: input.el, send, bubble, candidates },
      candidates,
    } satisfies Result;

    function guessBubbleSelector(inputElementForBubble: Element): string {
      const thread = findLikelyThread(inputElementForBubble);
      if (!thread) return 'body *';
      const children = Array.from(thread.children).filter(isElementVisible);
      const scored = children
        .map((child) => {
          const text = compactText(child.textContent);
          const rect = child.getBoundingClientRect();
          let score = text.length > 0 ? 12 : 0;
          if (rect.width > 80 && rect.height > 12) score += 8;
          if (child.classList.length > 0) score += 10;
          return { child, score };
        })
        .sort((a, b) => b.score - a.score);
      const best = scored[0]?.child;
      if (!best) return `${uniqueSelector(thread)} > *`;
      const stableClasses = Array.from(best.classList).filter(
        (name) => !/(mine|user|me|human|own)/i.test(name),
      );
      if (stableClasses.length > 0) return `.${stableClasses.map(cssEscape).join('.')}`;
      return `${uniqueSelector(thread)} > ${best.tagName.toLowerCase()}`;
    }

    function findLikelyThread(inputElementForThread: Element): Element | null {
      let current = inputElementForThread.parentElement;
      for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
        const candidates = Array.from(current.querySelectorAll('section,main,div,ul,ol')).filter(
          (element) => {
            if (element.contains(inputElementForThread)) return false;
            const rect = element.getBoundingClientRect();
            return rect.width > 120 && rect.height > 40 && element.children.length > 0;
          },
        );
        const scored = candidates
          .map((element) => {
            const rect = element.getBoundingClientRect();
            let score = 0;
            if (rect.bottom <= inputRect.top + 20) score += 20;
            score += Math.min(20, element.children.length * 4);
            if (/(messages|chat|thread|conversation)/i.test(element.id + ' ' + element.className))
              score += 20;
            return { element, score };
          })
          .sort((a, b) => b.score - a.score);
        if (scored[0]) return scored[0].element;
      }
      return null;
    }
  });
}

export async function snapshotMessages(
  page: Page,
  inputSelector: string,
): Promise<MessageSnapshot> {
  return await page.evaluate((inputSelectorText) => {
    const input = document.querySelector(inputSelectorText);
    const compactText = (text: string | null | undefined): string =>
      (text ?? '').replace(/\s+/g, ' ').trim();
    const visible = (element: Element): boolean => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const path = (element: Element): string => {
      const parts: string[] = [];
      let current: Element | null = element;
      while (current && current !== document.body && parts.length < 5) {
        const parent: Element | null = current.parentElement;
        const index = parent ? Array.from(parent.children).indexOf(current) : 0;
        parts.unshift(`${current.tagName.toLowerCase()}:${index}`);
        current = parent;
      }
      return parts.join('/');
    };
    const cssEscape = (value: string): string => {
      const css = globalThis.CSS as { escape?: (text: string) => string } | undefined;
      return css?.escape ? css.escape(value) : value.replace(/["\\#.:,[\]>+~*'=]/g, '\\$&');
    };
    const uniqueSelector = (element: Element): string => {
      if (element.id) return `#${cssEscape(element.id)}`;
      const testId = element.getAttribute('data-testid') || element.getAttribute('data-test-id');
      if (testId) return `[data-testid="${cssEscape(testId)}"]`;
      const classNames = Array.from(element.classList).filter(Boolean).slice(0, 2);
      if (classNames.length > 0)
        return `${element.tagName.toLowerCase()}.${classNames.map(cssEscape).join('.')}`;
      return element.tagName.toLowerCase();
    };
    const findLikelyThread = (): Element => {
      if (!input) return document.body;
      const inputRect = input.getBoundingClientRect();
      let current = input.parentElement;
      for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
        const candidates = Array.from(current.querySelectorAll('section,main,div,ul,ol')).filter(
          (element) => {
            if (element.contains(input)) return false;
            const rect = element.getBoundingClientRect();
            return visible(element) && rect.width > 120 && rect.height > 24;
          },
        );
        const scored = candidates
          .map((element) => {
            const rect = element.getBoundingClientRect();
            let score = 0;
            if (rect.bottom <= inputRect.top + 30) score += 20;
            score += Math.min(24, element.children.length * 4);
            if (/(messages|chat|thread|conversation)/i.test(element.id + ' ' + element.className))
              score += 24;
            return { element, score };
          })
          .sort((a, b) => b.score - a.score);
        if (scored[0] && scored[0].score > 0) return scored[0].element;
      }
      return document.body;
    };
    const isLeafMessage = (element: Element): boolean =>
      !Array.from(element.children).some((child) => compactText(child.textContent).length > 0);
    const container = findLikelyThread();
    const nodes = Array.from(container.querySelectorAll('article,li,p,div,section > *')).filter(
      (element) => {
        if (input && (element === input || element.contains(input))) return false;
        const text = compactText(element.textContent);
        return (
          visible(element) && isLeafMessage(element) && text.length > 0 && text.length < 20_000
        );
      },
    );
    return {
      entries: nodes.map((element) => ({
        key: `${path(element)}|${compactText(element.textContent)}`,
      })),
      container: uniqueSelector(container),
    };
  }, inputSelector);
}

export async function fillInput(input: Locator, prompt: string): Promise<void> {
  const editable = await input.evaluate((element: Element) => {
    return element instanceof HTMLElement && element.isContentEditable;
  });
  if (editable) {
    await input.click({ timeout: 10_000 });
    await input.evaluate((element: Element) => {
      element.textContent = '';
    });
    await input.page().keyboard.type(prompt);
    return;
  }
  await input.fill(prompt);
}

export async function sendPrompt(
  page: Page,
  selectors: ResolvedSelectors,
  before: MessageSnapshot,
  prompt: string,
): Promise<SendResult> {
  if (selectors.source === 'heuristic') {
    await page.keyboard.press('Enter');
    const enterResult = await waitForSendConfirmation(page, selectors.input, before, 1_200);
    if (enterResult.sent) return { ...enterResult, send: 'Enter' };
    if (selectors.send === 'Enter') return { ...enterResult, send: 'Enter' };

    await fillInput(page.locator(selectors.input).first(), prompt);
    try {
      await page.locator(selectors.send).first().click({ timeout: 10_000 });
    } catch {
      return { sent: false, bubble: '', send: selectors.send };
    }
    const clickResult = await waitForSendConfirmation(page, selectors.input, before, 3_000);
    return { ...clickResult, send: selectors.send };
  }

  if (selectors.send === 'Enter') {
    await page.keyboard.press('Enter');
  } else {
    await page.locator(selectors.send).first().click({ timeout: 10_000 });
  }
  const result = await waitForSendConfirmation(page, selectors.input, before, 3_000);
  return { ...result, send: selectors.send };
}

export async function waitForSendConfirmation(
  page: Page,
  inputSelector: string,
  before: MessageSnapshot,
  timeoutMs: number,
): Promise<SendConfirmation> {
  return await page.evaluate(
    async ({ inputSelectorText, beforeKeys, beforeContainer, timeoutMsValue }) => {
      const startedAt = Date.now();
      const before = new Set(beforeKeys);
      const compactText = (text: string | null | undefined): string =>
        (text ?? '').replace(/\s+/g, ' ').trim();
      const cssEscape = (value: string): string => {
        const css = globalThis.CSS as { escape?: (text: string) => string } | undefined;
        return css?.escape ? css.escape(value) : value.replace(/["\\#.:,[\]>+~*'=]/g, '\\$&');
      };
      const uniqueSelector = (element: Element): string => {
        if (element.id) return `#${cssEscape(element.id)}`;
        const classNames = Array.from(element.classList).filter(Boolean);
        if (classNames.length > 0) return `.${classNames.map(cssEscape).join('.')}`;
        return element.tagName.toLowerCase();
      };
      const inputValue = (): string => {
        const input = document.querySelector(inputSelectorText);
        if (!input) return '';
        if ('value' in input) return String((input as HTMLInputElement).value ?? '');
        return input.textContent ?? '';
      };
      const path = (element: Element): string => {
        const parts: string[] = [];
        let current: Element | null = element;
        while (current && current !== document.body && parts.length < 5) {
          const parent: Element | null = current.parentElement;
          const index = parent ? Array.from(parent.children).indexOf(current) : 0;
          parts.unshift(`${current.tagName.toLowerCase()}:${index}`);
          current = parent;
        }
        return parts.join('/');
      };
      const visible = (element: Element): boolean => {
        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          rect.width > 0 &&
          rect.height > 0
        );
      };
      const isLeafMessage = (element: Element): boolean =>
        !Array.from(element.children).some((child) => compactText(child.textContent).length > 0);
      const currentMessageNodes = () =>
        Array.from(
          (document.querySelector(beforeContainer) || document.body).querySelectorAll(
            'article,li,p,div,section > *',
          ),
        ).filter((element) => {
          const input = document.querySelector(inputSelectorText);
          if (input && (element === input || element.contains(input))) return false;
          const text = compactText(element.textContent);
          return (
            visible(element) && isLeafMessage(element) && text.length > 0 && text.length < 20_000
          );
        });
      let sawSentCondition = false;
      while (Date.now() - startedAt < timeoutMsValue) {
        const nodes = currentMessageNodes();
        const additions = nodes.filter(
          (element) => !before.has(`${path(element)}|${compactText(element.textContent)}`),
        );
        const inputCleared = compactText(inputValue()).length === 0;
        if (inputCleared || additions.length > 0) {
          sawSentCondition = true;
          const nonMine = additions.find(
            (element) => !/(mine|user|human|own|sent|question)/i.test(element.className),
          );
          if (nonMine) return { sent: true, bubble: uniqueSelector(nonMine) };
        }
        await new Promise((resolve) => setTimeout(resolve, 75));
      }
      return { sent: sawSentCondition, bubble: '' };
    },
    {
      inputSelectorText: inputSelector,
      beforeKeys: before.entries.map((entry) => entry.key),
      beforeContainer: before.container,
      timeoutMsValue: timeoutMs,
    },
  );
}
