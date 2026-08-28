# Visualping password crawler

Finds passwords matching `VISUALPING\{[0-9a-f]{16}\}` hidden across a small Basic Auth'd website.

The site is crawled with a real browser, because not every route on it is an `<a href>` in the HTML
source. Every response is archived byte-for-byte, and the search then runs **offline** against the
archive — so iterating on "where could a password be hiding" costs zero further requests.

> Note: the target site's address and credentials are not in this repository. They are read from a
> gitignored `.env`, along with everything the crawler downloads.

## Setup

Requires Node 22.18 or newer (TypeScript runs directly, no build step).

```bash
npm install
cp .env.example .env   # then fill in BASE_URL, BASIC_AUTH_USER, BASIC_AUTH_PASS
```

## Commands

| Command | What it does |
| --- | --- |
| `npm run crawl` | Fetches the site and archives every response, headers included, into `out/` |
| `npm run analyze` | Searches the archived responses for passwords. No network access |
| `npm run verify` | Re-crawls and reports whether anything new was found |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Unit tests |

## How it works

Two commands, deliberately separated:

**`crawl`** uses the browser to *find* pages, then a plain HTTP client to *download* them. The
browser is what makes discovery complete — it runs the site's JavaScript, loads its stylesheets,
fonts and images, and can click elements that behave like links without being anchors. But a
browser hands you a rendered DOM, not the bytes the server sent, so each discovered URL is
re-fetched over `node:https` and stored exactly as it came off the wire, compression and all.

Credentials are attached to every in-scope request — including subresources and each hop of a
redirect chain, where most HTTP clients drop the `Authorization` header — and never to an
off-origin request.

**`analyze`** walks the archive and expands each response into a tree of decoded *views*: gunzipped
bodies, base64 and hex runs, HTML comments and attributes, JS string literals, response headers and
cookies, image metadata, PDF text, font name tables. Each view carries the chain of decodes that
produced it, so every password found is reported with its source URL, resource type, decode chain,
and surrounding context.

Full methodology and the completeness evidence are documented here once the crawl is complete.

## Output

Everything lands in `out/` (gitignored):

```
out/
  archive/     one file per response, byte-for-byte, plus a .meta.json sidecar of status + headers
  manifest.json  the crawl index: every URL, how it was discovered, and its content hash
  report.md      findings with provenance, near-misses, and crawl statistics
  findings.json  the same, machine-readable
```
