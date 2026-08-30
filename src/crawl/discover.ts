import type { Page } from 'puppeteer';
import type { DiscoveryMethod } from '../archive/store.ts';

/** A URL the browser revealed, tagged with the mechanism that revealed it. */
export interface DiscoveredUrl {
  url: string;
  discoveryMethod: DiscoveryMethod;
}

/** Collects URLs the browser requested while a page loaded. */
export interface NetworkRecorder {
  /** Everything requested since recording began, deduplicated. */
  collected(): DiscoveredUrl[];
}

/**
 * Starts recording every request the browser makes, and must be called before navigation.
 *
 * This is the single most complete discovery mechanism: it sees stylesheets, scripts, fonts,
 * images, media, iframes and XHR/fetch traffic, whether they came from markup, from CSS, or from
 * JavaScript at runtime. Anything the browser genuinely loaded ends up here, regardless of how the
 * page asked for it.
 */
export function startNetworkRecorder(page: Page): NetworkRecorder {
  const urls = new Set<string>();
  page.on('request', (request) => urls.add(request.url()));
  return {
    collected: () =>
      [...urls].map((url) => ({ url, discoveryMethod: 'network-request' as DiscoveryMethod })),
  };
}

/**
 * Reads URL-bearing attributes out of the rendered DOM, after scripts have run.
 *
 * Complements the network recorder rather than duplicating it: a link the browser has not followed
 * and an image below the fold that was never fetched leave no network trace, but are both plainly
 * present in the DOM.
 */
export async function extractDomUrls(page: Page): Promise<DiscoveredUrl[]> {
  const collected = await page.evaluate(() => {
    const found: Array<{ url: string; discoveryMethod: string }> = [];
    const push = (value: string | null | undefined, discoveryMethod: string) => {
      if (!value?.trim()) return;
      try {
        found.push({ url: new URL(value, document.baseURI).href, discoveryMethod });
      } catch {
        // Not a resolvable URL — javascript: handlers and template placeholders land here.
      }
    };

    const attributeSources: Array<[string, string, string]> = [
      ['a[href]', 'href', 'anchor-href'],
      ['area[href]', 'href', 'anchor-href'],
      ['link[href]', 'href', 'dom-attribute'],
      ['script[src]', 'src', 'dom-attribute'],
      ['img[src]', 'src', 'dom-attribute'],
      ['source[src]', 'src', 'dom-attribute'],
      ['iframe[src]', 'src', 'dom-attribute'],
      ['frame[src]', 'src', 'dom-attribute'],
      ['embed[src]', 'src', 'dom-attribute'],
      ['object[data]', 'data', 'dom-attribute'],
      ['video[src]', 'src', 'dom-attribute'],
      ['video[poster]', 'poster', 'dom-attribute'],
      ['audio[src]', 'src', 'dom-attribute'],
      ['track[src]', 'src', 'dom-attribute'],
      ['form[action]', 'action', 'dom-attribute'],
    ];
    for (const [selector, attribute, method] of attributeSources) {
      for (const element of document.querySelectorAll(selector)) {
        push(element.getAttribute(attribute), method);
      }
    }

    for (const element of document.querySelectorAll('img[srcset], source[srcset]')) {
      for (const candidate of (element.getAttribute('srcset') ?? '').split(',')) {
        push(candidate.trim().split(/\s+/)[0], 'dom-attribute');
      }
    }

    for (const element of document.querySelectorAll('meta[http-equiv]')) {
      if ((element.getAttribute('http-equiv') ?? '').toLowerCase() !== 'refresh') continue;
      const target = /url\s*=\s*(.+)$/i.exec(element.getAttribute('content') ?? '');
      if (target?.[1]) push(target[1].trim().replace(/^['"]|['"]$/g, ''), 'dom-attribute');
    }

    // data-* attributes are a common place to stash a path that JavaScript will later fetch.
    const URL_SHAPED = /^(https?:\/\/|\/|\.\.?\/)/;
    const FILE_SHAPED = /\.(html?|css|js|json|txt|xml|pdf|png|jpe?g|gif|svg|webp|woff2?|ttf|otf|zip)$/i;
    for (const element of document.querySelectorAll('*')) {
      for (const attribute of element.attributes) {
        if (!attribute.name.startsWith('data-')) continue;
        const value = attribute.value.trim();
        if (URL_SHAPED.test(value) || FILE_SHAPED.test(value)) push(value, 'dom-attribute');
      }
    }

    return found;
  });

  return asDiscoveredUrls(collected);
}

/**
 * Finds resources referenced from CSS, which are invisible to markup scraping entirely.
 *
 * Two passes, because they catch different things. Computed styles reveal what is actually applied
 * to rendered elements, including pseudo-element content. Walking the stylesheet rules also picks
 * up declarations that matched nothing on this page, so a background image on a selector used
 * elsewhere still surfaces.
 */
export async function extractStyleUrls(page: Page): Promise<DiscoveredUrl[]> {
  const collected = await page.evaluate(() => {
    const found: Array<{ url: string; discoveryMethod: string }> = [];
    const push = (value: string, discoveryMethod: string) => {
      if (!value.trim() || value.startsWith('data:')) return;
      try {
        found.push({ url: new URL(value, document.baseURI).href, discoveryMethod });
      } catch {
        // Malformed url() token.
      }
    };
    const urlsIn = (text: string): string[] =>
      [...text.matchAll(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g)].map((match) => match[2] ?? '');

    const properties = [
      'background-image',
      'list-style-image',
      'border-image-source',
      'mask-image',
      'content',
      'cursor',
    ];
    const readStyle = (element: Element, pseudo: string | null) => {
      const style = getComputedStyle(element, pseudo);
      for (const property of properties) {
        const value = style.getPropertyValue(property);
        if (!value || value === 'none') continue;
        for (const url of urlsIn(value)) push(url, 'computed-style');
      }
    };

    for (const element of document.querySelectorAll('*')) {
      readStyle(element, null);
      readStyle(element, '::before');
      readStyle(element, '::after');
    }

    const walkRules = (rules: CSSRuleList) => {
      for (const rule of rules) {
        for (const url of urlsIn(rule.cssText)) push(url, 'css-reference');
        const nested = (rule as CSSGroupingRule).cssRules;
        if (nested) walkRules(nested);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walkRules(sheet.cssRules);
      } catch {
        // Cross-origin stylesheets refuse rule access; the network recorder still saw the file.
      }
    }

    return found;
  });

  return asDiscoveredUrls(collected);
}

/**
 * Re-attaches the `DiscoveryMethod` union to values that crossed the browser boundary. The in-page
 * code cannot reference a TypeScript type, so it labels with plain strings drawn from that union.
 */
function asDiscoveredUrls(
  collected: Array<{ url: string; discoveryMethod: string }>,
): DiscoveredUrl[] {
  return collected.map(({ url, discoveryMethod }) => ({
    url,
    discoveryMethod: discoveryMethod as DiscoveryMethod,
  }));
}

/**
 * Runs every discovery mechanism against a loaded page and returns the union, keeping the earliest
 * (most specific) attribution when several mechanisms found the same URL.
 */
export async function discoverUrls(
  page: Page,
  recorder: NetworkRecorder,
): Promise<DiscoveredUrl[]> {
  const all = [
    ...(await extractDomUrls(page)),
    ...(await extractStyleUrls(page)),
    ...recorder.collected(),
  ];

  const byUrl = new Map<string, DiscoveredUrl>();
  for (const discovered of all) {
    if (!byUrl.has(discovered.url)) byUrl.set(discovered.url, discovered);
  }
  return [...byUrl.values()];
}
