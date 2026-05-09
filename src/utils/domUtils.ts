import type { Page } from 'playwright';

export interface DomElementData {
  selector: string;
  tagName: string;
  role: string | undefined;
  text: string | undefined;
  placeholder: string | undefined;
  ariaLabel: string | undefined;
  href: string | undefined;
  id: string | undefined;
  className: string | undefined;
  value: string | undefined;
  inputType: string | undefined;
  name: string | undefined;
  label: string | undefined;
}

export interface DomSnapshot {
  url: string;
  currentUrl: string;
  pageTitle: string;
  title: string;
  elements: DomElementData[];
}

export async function getDomSnapshot(page: Page): Promise<DomSnapshot> {
  const pageScript = `(() => {
    const interactiveSelectors = [
      'button',
      'input',
      'textarea',
      'select',
      'a',
      '[role="button"]',
      '[role="link"]',
      '[role="checkbox"]',
      '[role="menuitem"]',
      '[role="tab"]',
      '[role="radio"]',
      '[role="switch"]',
      'summary',
      '[tabindex]:not([tabindex="-1"])'
    ].join(',');

    const elements = [];
    const seenIds = new Set();

    function generateUniqueId() {
      let id = '';
      for (let i = 0; i < 8; i++) {
        id += Math.floor(Math.random() * 36).toString(36);
      }
      return 'ai-' + id;
    }

    function ensureSelector(el) {
      const existing = el.getAttribute('data-ai-id');
      if (existing && !seenIds.has(existing)) {
        seenIds.add(existing);
        return '[data-ai-id="' + existing + '"]';
      }

      let uid = generateUniqueId();
      while (seenIds.has(uid) || document.querySelector('[data-ai-id="' + uid + '"]')) {
        uid = generateUniqueId();
      }
      el.setAttribute('data-ai-id', uid);
      seenIds.add(uid);
      return '[data-ai-id="' + uid + '"]';
    }

    function getRole(el) {
      const role = el.getAttribute('role');
      if (role) return role;
      const tag = el.tagName.toLowerCase();
      if (tag === 'a') return 'link';
      if (tag === 'button') return 'button';
      if (tag === 'input') {
        const type = el.type;
        if (type === 'checkbox' || type === 'radio' || type === 'submit' || type === 'button') {
          return type;
        }
        return 'textbox';
      }
      if (tag.match(/^h[1-6]$/)) return 'heading';
      return undefined;
    }

    function getLabel(element) {
      const id = element.id;
      if (!id) return undefined;
      const label = document.querySelector('label[for="' + CSS.escape(id) + '"]');
      return label ? label.textContent?.trim().substring(0, 80) : undefined;
    }

    function normalizeText(value) {
      if (!value) return undefined;
      const text = value.trim().replace(/\s+/g, ' ');
      return text.length === 0 ? undefined : text.substring(0, 120);
    }

    function isVisible(el) {
      const style = window.getComputedStyle(el);
      if (!el.isConnected) return false;
      if (style.visibility === 'hidden' || style.display === 'none' || style.opacity === '0') return false;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return false;
      if (rect.bottom < 0 || rect.right < 0) return false;
      if (rect.top > (window.innerHeight || document.documentElement.clientHeight)) return false;
      if (rect.left > (window.innerWidth || document.documentElement.clientWidth)) return false;
      return true;
    }

    function buildElementData(el, selector) {
      const text = normalizeText(el.textContent || el.innerText || '');
      const tagName = el.tagName.toLowerCase();
      const type = (el.getAttribute('type') || '').toLowerCase();

      return {
        selector,
        tagName,
        role: getRole(el),
        text,
        placeholder: normalizeText(el.placeholder || ''),
        ariaLabel: normalizeText(el.getAttribute('aria-label') || ''),
        href: normalizeText(el.getAttribute('href') || ''),
        id: normalizeText(el.id || ''),
        className: normalizeText(el.className || ''),
        value: normalizeText(el.value || ''),
        inputType: type || undefined,
        name: normalizeText(el.name || ''),
        label: normalizeText(getLabel(el))
      };
    }

    function traverse(root) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT, null);
      let node = walker.currentNode;
      while (node && elements.length < 300) {
        try {
          if (node instanceof HTMLElement && node.matches(interactiveSelectors) && isVisible(node)) {
            const selector = ensureSelector(node);
            elements.push(buildElementData(node, selector));
          }
          if (node.shadowRoot) {
            traverse(node.shadowRoot);
          }
        } catch (e) {
          // Ignore nodes that fail due to cross-origin or invalid state
        }
        node = walker.nextNode();
      }
    }

    traverse(document.body || document.documentElement);

    return {
      url: window.location.href,
      currentUrl: window.location.href,
      pageTitle: document.title,
      title: document.title,
      elements
    };
  })()`;
  return page.evaluate(pageScript);
}
