import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UrlFrontier, normalizeUrl } from '../src/crawl/frontier.ts';
import type { Provenance } from '../src/archive/store.ts';

const BASE = new URL('http://example.test/');
const FROM_LINK: Provenance = { discoveryMethod: 'anchor-href', discoveredFromUrl: null };

test('resolves relative URLs and drops the fragment', () => {
  assert.equal(normalizeUrl('/docs/', BASE)?.url, 'http://example.test/docs/');
  assert.equal(normalizeUrl('docs/x.html#section', BASE)?.url, 'http://example.test/docs/x.html');
});

test('strips tracking parameters the site was measured to ignore', () => {
  const normalized = normalizeUrl('/docs/?ref=related&utm_source=sidebar&v=7', BASE);
  assert.equal(normalized?.url, 'http://example.test/docs/');
  assert.deepEqual(normalized?.droppedParameters, ['ref', 'utm_source', 'v']);
});

test('keeps parameters that select real content', () => {
  assert.equal(normalizeUrl('/report/?page=2', BASE)?.url, 'http://example.test/report/?page=2');
  assert.equal(
    normalizeUrl('/report/?page=2&ref=nav', BASE)?.url,
    'http://example.test/report/?page=2',
  );
});

test('refuses schemes that are not worth fetching', () => {
  assert.equal(normalizeUrl('mailto:someone@example.test', BASE), null);
  assert.equal(normalizeUrl('javascript:void(0)', BASE), null);
  assert.equal(normalizeUrl('data:text/plain,hello', BASE), null);
});

test('queues a URL once and reports repeats as already seen', () => {
  const frontier = new UrlFrontier(BASE);
  assert.equal(frontier.add('/docs/', FROM_LINK), true);
  assert.equal(frontier.add('/docs/', FROM_LINK), false);
  assert.equal(frontier.rejections['already-seen'], 1);
});

test('distinguishes a tracking-tag duplicate from a plain repeat', () => {
  const frontier = new UrlFrontier(BASE);
  frontier.add('/docs/', FROM_LINK);
  frontier.add('/docs/?utm_source=sidebar', FROM_LINK);
  assert.equal(frontier.rejections['normalized-duplicate'], 1);
  assert.equal(frontier.rejections['already-seen'], undefined);
});

test('turns away URLs on other origins', () => {
  const frontier = new UrlFrontier(BASE);
  assert.equal(frontier.add('https://elsewhere.test/page', FROM_LINK), false);
  assert.equal(frontier.rejections['off-site'], 1);
});

test('empties in breadth-first order and then reports done', () => {
  const frontier = new UrlFrontier(BASE);
  frontier.add('/a', FROM_LINK);
  frontier.add('/b', FROM_LINK);
  assert.equal(frontier.next()?.url, 'http://example.test/a');
  assert.equal(frontier.next()?.url, 'http://example.test/b');
  assert.equal(frontier.next(), null);
  assert.equal(frontier.pendingCount, 0);
});

test('skips URLs already fetched by a previous run', () => {
  const frontier = new UrlFrontier(BASE, { alreadySeen: ['http://example.test/docs/'] });
  assert.equal(frontier.add('/docs/', FROM_LINK), false);
});

test('samples a numeric pagination sequence and caps the rest as a trap', () => {
  const frontier = new UrlFrontier(BASE, { paginationSample: 3 });
  const accepted = [1, 2, 3, 4, 5].map((page) =>
    frontier.add(`/report/?page=${page}`, FROM_LINK),
  );
  assert.deepEqual(accepted, [true, true, true, false, false]);
  assert.equal(frontier.rejections['pagination-capped'], 2);
});

test('counts each paginated path against its own budget', () => {
  const frontier = new UrlFrontier(BASE, { paginationSample: 1 });
  assert.equal(frontier.add('/report/?page=1', FROM_LINK), true);
  assert.equal(frontier.add('/archive/?page=1', FROM_LINK), true);
  assert.equal(frontier.add('/report/?page=2', FROM_LINK), false);
});

test('does not treat a non-numeric query parameter as pagination', () => {
  const frontier = new UrlFrontier(BASE, { paginationSample: 1 });
  assert.equal(frontier.add('/search/?q=alpha', FROM_LINK), true);
  assert.equal(frontier.add('/search/?q=beta', FROM_LINK), true);
});
