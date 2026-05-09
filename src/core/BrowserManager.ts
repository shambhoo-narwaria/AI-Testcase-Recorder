import * as fs from 'fs';
import * as path from 'path';
import { chromium, type Browser, type Locator, type Page } from 'playwright';
import type { TestStep } from '../utils/types.js';

interface ExecutionOptions {
  stepIndex?: number;
  artifactDir?: string;
  isPlayback?: boolean;
}

interface ExecutionResult {
  selectors?: TestStep['selectors'];
  result?: TestStep['result'];
}

interface LocatorCandidate {
  selectorHint: string;
  locator: Locator;
  weight: number;
}

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DEFAULT_ARTIFACTS_DIR = path.resolve(process.cwd(), 'artifacts');

export class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;

  async init(headless = false): Promise<Page> {
    const launchOptions: Parameters<typeof chromium.launch>[0] = {
      headless,
      channel: 'chrome',
      args: [
        '--start-maximized',
        '--disable-blink-features=AutomationControlled',
        '--disable-infobars',
        '--no-sandbox',
        '--disable-dev-shm-usage',
      ],
    };

    if (process.env.PLAYWRIGHT_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PLAYWRIGHT_EXECUTABLE_PATH;
    } else if (process.env.PLAYWRIGHT_CHANNEL) {
      launchOptions.channel = process.env.PLAYWRIGHT_CHANNEL as 'chrome';
    }

    this.browser = await chromium.launch(launchOptions);
    const context = await this.browser.newContext({
      viewport: null,
      userAgent: DEFAULT_USER_AGENT,
    });

    // Keep the active page aligned with popup/login flows that open a new tab.
    context.on('page', async (newPage) => {
      console.log('[Browser] New tab detected. Switching active page.');
      this.page = newPage;
      await newPage.waitForLoadState().catch(() => undefined);
    });

    this.page = await context.newPage();
    return this.page;
  }

  async executeStep(step: TestStep, opts: ExecutionOptions = {}): Promise<ExecutionResult> {
    const page = this.requirePage();

    if (step.action === 'navigate') {
      return this.handleNavigate(page, step);
    }

    if (step.action === 'scroll') {
      return this.handleScroll(page, step);
    }

    if (step.action === 'press') {
      return this.handlePress(page, step);
    }

    if (step.action === 'wait') {
      const ms = Number(step.value || 500);
      await page.waitForTimeout(Math.max(50, ms));
      return { result: { urlAfter: page.url() } };
    }

    if (step.action === 'assert') {
      await this.withRetries(() => this.performAssert(step));
      return { selectors: step.selectors, result: { urlAfter: page.url() } };
    }

    const candidates = this.buildLocatorCandidates(step);
    if (candidates.length === 0) {
      return { selectors: step.selectors, result: { urlAfter: page.url() } };
    }

    let lastError: unknown;
    for (const candidate of candidates) {
      try {
        return await this.tryActionCandidate(step, candidate, opts);
      } catch (error) {
        lastError = error;
      }
    }

    const result = await this.captureFailureResult(lastError, opts);
    throw Object.assign(new Error('Failed to execute step.'), { cause: lastError, result });
  }

  private async handleNavigate(page: Page, step: TestStep): Promise<ExecutionResult> {
    const navigateUrl = step.url || step.value;

    if (navigateUrl) {
      await this.withRetries(async () => {
        try {
          await page.goto(navigateUrl, { waitUntil: 'load', timeout: 30000 });
        } catch {
          console.log('[Browser] Navigation timed out; continuing with the partially loaded page.');
        }

        await page.waitForTimeout(2000);
      });
    }

    return { result: { urlAfter: page.url() } };
  }

  private async handleScroll(page: Page, step: TestStep): Promise<ExecutionResult> {
    const direction = step.value || 'down';

    await this.withRetries(async () => {
      if (direction === 'up') {
        await page.evaluate(() => window.scrollBy({ top: -window.innerHeight * 0.8, behavior: 'smooth' }));
      } else {
        await page.evaluate(() => window.scrollBy({ top: window.innerHeight * 0.8, behavior: 'smooth' }));
      }

      await page.waitForTimeout(500);
    });

    return { result: { urlAfter: page.url() } };
  }

  private async handlePress(page: Page, step: TestStep): Promise<ExecutionResult> {
    const key = step.value || 'Enter';

    await this.withRetries(async () => {
      if (step.target) {
        const target = page.locator(step.target).first();
        await target.waitFor({ state: 'visible', timeout: 5000 }).catch(() => undefined);
        await target.focus().catch(() => undefined);
      }

      await page.keyboard.press(key);
    });

    return { result: { urlAfter: page.url() } };
  }

  private async tryActionCandidate(
    step: TestStep,
    candidate: LocatorCandidate,
    opts: ExecutionOptions,
  ): Promise<ExecutionResult> {
    const page = this.requirePage();
    const element = candidate.locator.first();
    const timeout = opts.isPlayback ? 3000 : 7000;

    return this.withRetries(async () => {
      await element.waitFor({ state: 'visible', timeout });

      const fingerprint = await this.captureFingerprint(element);
      console.log(`[Browser] Using: ${candidate.selectorHint} (score ${candidate.weight})`);
      await this.highlight(element, opts.isPlayback ? 300 : 500);

      // Capture a light before/after snapshot so the recorder knows whether a step
      // actually changed the page, even when navigation does not occur.
      const urlBefore = page.url();
      const titleBefore = await page.title();
      const contentBefore = await page.content();

      await this.performAction(step, element);
      await page.waitForTimeout(1500);

      const urlAfter = page.url();
      const titleAfter = await page.title();
      const contentAfter = await page.content();
      const stateChange =
        urlBefore === urlAfter &&
        titleBefore === titleAfter &&
        Math.abs(contentBefore.length - contentAfter.length) < 10
          ? 'NO_CHANGE_DETECTED'
          : 'Changed';

      if (stateChange === 'NO_CHANGE_DETECTED') {
        console.log(`[Browser] Action on ${step.target ?? candidate.selectorHint} did not change the visible page state.`);
      }

      return {
        selectors: fingerprint,
        result: {
          urlAfter: page.isClosed() ? '' : page.url(),
          stateChange,
        },
      };
    });
  }

  private buildLocatorCandidates(step: TestStep): LocatorCandidate[] {
    const page = this.page;
    if (!page) {
      return [];
    }

    const selectors = step.selectors;
    const candidates: LocatorCandidate[] = [];

    const push = (selectorHint: string, locator: Locator, weight: number): void => {
      if (candidates.some((candidate) => candidate.selectorHint === selectorHint)) {
        return;
      }

      candidates.push({ selectorHint, locator, weight });
    };

    if (selectors?.role && selectors.text) {
      push(
        `page.getByRole('${selectors.role}', { name: '${escapeForLog(selectors.text)}' })`,
        page.getByRole(selectors.role as never, { name: selectors.text, exact: false }),
        120,
      );
    }

    if (selectors?.role && selectors.ariaLabel) {
      push(
        `page.getByRole('${selectors.role}', { name: '${escapeForLog(selectors.ariaLabel)}' })`,
        page.getByRole(selectors.role as never, { name: selectors.ariaLabel, exact: false }),
        115,
      );
    }

    if (selectors?.label) {
      push(`page.getByLabel('${escapeForLog(selectors.label)}')`, page.getByLabel(selectors.label, { exact: false }), 110);
    }

    if (selectors?.text) {
      push(`page.getByText('${escapeForLog(selectors.text)}')`, page.getByText(selectors.text, { exact: false }), 100);
    }

    if (selectors?.placeholder) {
      push(
        `page.getByPlaceholder('${escapeForLog(selectors.placeholder)}')`,
        page.getByPlaceholder(selectors.placeholder, { exact: false }),
        105,
      );
    }

    if (selectors?.alt) {
      push(`page.getByAltText('${escapeForLog(selectors.alt)}')`, page.getByAltText(selectors.alt, { exact: false }), 95);
    }

    if (selectors?.title) {
      push(`page.getByTitle('${escapeForLog(selectors.title)}')`, page.getByTitle(selectors.title, { exact: false }), 92);
    }

    if (selectors?.testId) {
      push(`page.getByTestId('${escapeForLog(selectors.testId)}')`, page.getByTestId(selectors.testId), 108);
    }

    if (selectors?.id) {
      push(`page.locator('#${escapeForLog(selectors.id)}')`, page.locator(`#${selectors.id}`), 107);
    }

    if (selectors?.shortCss && selectors.text) {
      push(
        `page.locator('${escapeForLog(selectors.shortCss)}').filter({ hasText: '${escapeForLog(selectors.text)}' })`,
        page.locator(selectors.shortCss).filter({ hasText: selectors.text }),
        85,
      );
    }

    if (selectors?.name && selectors?.tagName) {
      push(
        `page.locator('${selectors.tagName}[name="${escapeForLog(selectors.name)}"]')`,
        page.locator(`${selectors.tagName}[name="${selectors.name}"]`),
        96,
      );
    }

    if (selectors?.href) {
      push(`page.locator('a[href="${escapeForLog(selectors.href)}"]')`, page.locator(`a[href="${selectors.href}"]`), 98);
    }

    if (selectors?.shortCss) {
      push(`page.locator('${escapeForLog(selectors.shortCss)}')`, page.locator(selectors.shortCss), 84);
    }

    if (selectors?.role) {
      push(`page.getByRole('${selectors.role}')`, page.getByRole(selectors.role as never), 75);
    }

    if (selectors?.css) {
      push(`css: ${selectors.css}`, page.locator(selectors.css), 30);
    }

    if (selectors?.xpath) {
      push(`xpath: ${selectors.xpath}`, page.locator(`xpath=${selectors.xpath}`), 20);
    }

    if (step.target) {
      push(`target: ${step.target}`, page.locator(step.target), 10);
    }

    return candidates.sort((left, right) => right.weight - left.weight);
  }

  private async captureFingerprint(element: Locator): Promise<TestStep['selectors']> {
    try {
      return await element.evaluate((el: HTMLElement) => {
        let labelText: string | undefined;
        let nthOfType = 1;

        if (el.id) {
          const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          labelText = label?.textContent?.trim().substring(0, 80);
        }

        const xpathParts: string[] = [];
        let currentNode: Node | null = el;
        while (currentNode && currentNode.nodeType === Node.ELEMENT_NODE) {
          let index = 0;
          const elementNode = currentNode as HTMLElement;
          let previousSibling = elementNode.previousElementSibling;

          while (previousSibling) {
            if (previousSibling.tagName === elementNode.tagName) {
              index += 1;
            }
            previousSibling = previousSibling.previousElementSibling;
          }

          xpathParts.unshift(`${elementNode.tagName.toLowerCase()}[${index + 1}]`);
          currentNode = currentNode.parentNode;
        }

        const cssParts: string[] = [];
        let currentElement: HTMLElement | null = el;
        while (currentElement && currentElement.nodeType === Node.ELEMENT_NODE) {
          let selector = currentElement.tagName.toLowerCase();

          if (currentElement.id) {
            selector += `#${CSS.escape(currentElement.id)}`;
            cssParts.unshift(selector);
            break;
          }

          let sibling: Element | null = currentElement;
          let nth = 1;
          while (sibling.previousElementSibling) {
            sibling = sibling.previousElementSibling;
            if (sibling.tagName.toLowerCase() === currentElement.tagName.toLowerCase()) {
              nth += 1;
            }
          }

          if (currentElement === el) {
            nthOfType = nth;
          }

          selector += `:nth-of-type(${nth})`;
          cssParts.unshift(selector);
          currentElement = currentElement.parentElement;
        }

        let role = el.getAttribute('role');
        if (!role) {
          const tagName = el.tagName.toLowerCase();
          if (tagName === 'a') role = 'link';
          if (tagName === 'button') role = 'button';
          if (tagName === 'img') role = 'img';
          if (tagName === 'input') {
            const inputType = el.getAttribute('type');
            if (inputType === 'checkbox' || inputType === 'radio') role = inputType;
            else if (inputType === 'submit' || inputType === 'button') role = 'button';
            else role = 'textbox';
          }
          if (tagName.match(/^h[1-6]$/)) role = 'heading';
        }

        let cleanText = Array.from(el.childNodes)
          .filter((node) => node.nodeType === Node.TEXT_NODE)
          .map((node) => node.textContent?.trim())
          .filter(Boolean)
          .join(' ');

        if (!cleanText) {
          cleanText = el.textContent?.trim() || '';
        }

        if (cleanText.length > 50) {
          cleanText = cleanText.substring(0, 50);
        }

        const parentTextRaw = el.parentElement?.textContent?.trim() || '';
        const parentText = parentTextRaw
          ? parentTextRaw.replace(/\s+/g, ' ').substring(0, 80)
          : undefined;

        let shortCss = el.tagName.toLowerCase();
        if (el.id) {
          shortCss += `#${CSS.escape(el.id)}`;
        } else if (typeof el.className === 'string' && el.className.trim()) {
          const classes = el.className
            .trim()
            .split(/\s+/)
            .filter((className) => className && !className.includes(':'))
            .slice(0, 2)
            .map((className) => `.${CSS.escape(className)}`)
            .join('');
          shortCss += classes;
        }

        return {
          id: el.id || undefined,
          tagName: el.tagName.toLowerCase(),
          inputType: (el.getAttribute('type') || '').toLowerCase() || undefined,
          text: cleanText || undefined,
          parentText,
          ariaLabel: el.getAttribute('aria-label') || undefined,
          title: el.getAttribute('title') || undefined,
          alt: el.getAttribute('alt') || undefined,
          testId:
            el.getAttribute('data-testid') ||
            el.getAttribute('data-test') ||
            el.getAttribute('data-qa') ||
            undefined,
          label: labelText || undefined,
          placeholder: (el as HTMLInputElement).placeholder || undefined,
          role: role || undefined,
          name: (el as HTMLInputElement).name || undefined,
          href: el.getAttribute('href') || undefined,
          shortCss,
          css: cssParts.join(' > '),
          xpath: `/${xpathParts.join('/')}`,
          nthOfType,
        };
      });
    } catch (error) {
      console.error('[Browser] Failed to capture selector fingerprint:', error);
      return {};
    }
  }

  private async performAction(step: TestStep, element: Locator): Promise<void> {
    if (step.action === 'click') {
      await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);

      try {
        await element.click({ timeout: 5000 });
      } catch {
        console.log('[Browser] Click intercepted; retrying with force.');
        await element.click({ timeout: 5000, force: true });
      }

      return;
    }

    if (step.action === 'type') {
      if (step.value === undefined) {
        throw new Error('Type value missing');
      }

      await element.scrollIntoViewIfNeeded({ timeout: 5000 }).catch(() => undefined);
      await element.click({ timeout: 5000, force: true }).catch(() => undefined);
      await element.fill(step.value, { timeout: 5000 });
    }
  }

  private async performAssert(step: TestStep): Promise<void> {
    const page = this.requirePage();
    const mode = step.assertion ?? (step.target ? 'visible' : 'urlIncludes');

    if (mode === 'urlIncludes') {
      const expected = step.expected ?? '';
      if (!page.url().includes(expected)) {
        throw new Error(`URL mismatch: ${page.url()}`);
      }
      return;
    }

    const [firstCandidate] = this.buildLocatorCandidates(step);
    if (!firstCandidate) {
      throw new Error('No target available for assert step');
    }

    const element = firstCandidate.locator.first();
    await element.waitFor({ state: mode === 'notVisible' ? 'hidden' : 'visible', timeout: 5000 });

    if (mode === 'textIncludes') {
      const text = (await element.innerText()).trim();
      if (!text.includes(step.expected ?? '')) {
        throw new Error('Text mismatch');
      }
    }
  }

  private async captureFailureResult(err: unknown, opts: ExecutionOptions): Promise<TestStep['result'] | undefined> {
    const page = this.page;
    if (!page) {
      return undefined;
    }

    const filePath = opts.artifactDir
      ? this.buildCustomArtifactPath(opts.artifactDir, opts.stepIndex ?? 0)
      : this.buildDefaultArtifactPath(opts.stepIndex ?? 0);

    try {
      await page.screenshot({ path: filePath, fullPage: true });
    } catch {
      return { error: stringifyError(err), urlAfter: page.url() };
    }

    return { error: stringifyError(err), screenshotPath: filePath, urlAfter: page.url() };
  }

  private buildCustomArtifactPath(artifactDir: string, stepIndex: number): string {
    if (!fs.existsSync(artifactDir)) {
      fs.mkdirSync(artifactDir, { recursive: true });
    }

    return path.join(artifactDir, `fail-${stepIndex}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
  }

  private buildDefaultArtifactPath(stepIndex: number): string {
    if (!fs.existsSync(DEFAULT_ARTIFACTS_DIR)) {
      fs.mkdirSync(DEFAULT_ARTIFACTS_DIR, { recursive: true });
    }

    return path.join(
      DEFAULT_ARTIFACTS_DIR,
      `fail-${stepIndex}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`,
    );
  }

  private async highlight(element: Locator, duration = 400): Promise<void> {
    try {
      await element.evaluate((el: HTMLElement, delay: number) => {
        const previousOutline = el.style.outline;
        const previousShadow = el.style.boxShadow;
        const previousTransition = el.style.transition;

        el.style.transition = 'all 0.2s ease';
        el.style.outline = '4px solid #ff00ff';
        el.style.boxShadow = '0 0 15px #ff00ff';

        setTimeout(() => {
          el.style.outline = previousOutline;
          el.style.boxShadow = previousShadow;
          el.style.transition = previousTransition;
        }, delay);
      }, duration);

      await this.page?.waitForTimeout(duration + 50);
    } catch {
      return;
    }
  }

  private async withRetries<T>(fn: () => Promise<T>, retries = 1): Promise<T> {
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (error) {
        attempt += 1;
        if (attempt > retries || !isRetryableError(error)) {
          throw error;
        }

        await this.page?.waitForTimeout(500 * attempt);
      }
    }
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
    }
  }

  getPage(): Page | null {
    return this.page;
  }

  private requirePage(): Page {
    if (!this.page) {
      throw new Error('Browser not initialized');
    }

    return this.page;
  }
}

function isRetryableError(error: unknown): boolean {
  const message = String(error);
  return (
    message.includes('Timeout') ||
    message.includes('attached') ||
    message.includes('visible') ||
    message.includes('pointer') ||
    message.includes('Execution context')
  );
}

function escapeForLog(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
