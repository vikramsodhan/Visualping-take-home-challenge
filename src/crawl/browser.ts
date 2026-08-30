import puppeteer, { type Browser, type Page } from 'puppeteer';
import { basicAuthHeader, isInScope, type Config } from '../config.ts';

/**
 * Chrome silently upgrades plain-HTTP navigations to HTTPS and, when that fails against a bare IP
 * address, refuses the request with `ERR_BLOCKED_BY_CLIENT` rather than falling back. A site served
 * over HTTP is unreachable until this is turned off.
 */
const NAVIGATION_ARGS = ['--disable-features=HttpsUpgrades,HttpsFirstBalancedMode'];

/**
 * Launches a headless Chrome for discovery. The caller owns closing it.
 *
 * `--no-sandbox` is included so the same command works inside containers and CI, where Chrome's
 * sandbox needs privileges that are usually unavailable.
 */
export async function launchBrowser(): Promise<Browser> {
  return await puppeteer.launch({ headless: true, args: ['--no-sandbox', ...NAVIGATION_ARGS] });
}

/**
 * Opens a page that sends HTTP Basic Auth on every in-scope request it makes — the navigation, and
 * every stylesheet, script, font, image and XHR underneath it.
 *
 * The header is attached up front rather than through `page.authenticate()`, for two reasons.
 * `authenticate()` only *reacts* to a 401 challenge, so a resource answering 403, or quietly
 * serving degraded content to an anonymous request, slips straight past it. And it cannot be
 * combined with a manual interception handler: both try to resolve the same request, and the
 * request ends up blocked rather than sent.
 *
 * The scope check is what keeps this safe. An off-site request gets no credentials, so a
 * third-party font or analytics beacon can never receive them.
 */
export async function openAuthenticatedPage(browser: Browser, config: Config): Promise<Page> {
  const page = await browser.newPage();

  await page.setUserAgent(config.userAgent);
  await page.setRequestInterception(true);

  page.on('request', (request) => {
    if (request.isInterceptResolutionHandled()) return;

    const headers = { ...request.headers() };
    if (isRequestInScope(request.url(), config)) {
      headers.authorization = basicAuthHeader(config.username, config.password);
    }
    void request.continue({ headers }).catch(() => {
      // A request aborted by a navigation cannot be continued; that is normal and not an error.
    });
  });

  return page;
}

function isRequestInScope(rawUrl: string, config: Config): boolean {
  try {
    return isInScope(new URL(rawUrl), config.baseUrl);
  } catch {
    return false;
  }
}
