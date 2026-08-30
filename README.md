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
bodies, base64 / hex / percent / HTML-entity / char-code decodings, UTF-16 text, PNG metadata chunks
and trailing bytes, response headers, and text OCR'd out of image pixels. Decoders are applied
recursively — a password behind several layers is peeled open one at a time — with a depth limit and
a content-hash cycle guard. Each view carries the chain of decodes that produced it, so every
password is reported with its source URL, resource type, decode chain, and surrounding context.

## The eight passwords, and where they hid

The point of the exercise is that a password can be anywhere in *anything* the server sends. The
eight turned up in eight different kinds of place:

| Hiding place | How it was found |
| --- | --- |
| Plain text on a deep page | reachable only by crawling the whole site |
| A JavaScript source file (`var ADMIN_PASSWORD`) | scanning JS as text |
| A custom response header (`X-Provisioning-Note`) | headers are searched, not just bodies |
| A `String.fromCharCode([...])` array | char-code decoder |
| An image's EXIF comment, stored as UTF-16 | UTF-16 text decoder |
| Rendered into image pixels | OCR, with hex-normalization of misread digits |
| A page geo-gated to one region | see below |

The JS `ADMIN_PASSWORD` is the one that reads like a *real* leak — a credential left in shipped code
with a `// remove before prod. TODO: rotate` comment — rather than a puzzle planted for the exercise.

### The geo-gated page (out-of-band)

One password sits behind a page that returns **403 to anyone outside Germany**. The block is on the
real TCP source address (a GeoIP lookup), not on any request header — every spoofed `X-Forwarded-For`,
`X-Real-IP`, `CF-IPCountry`, cookie and `?region=` still read as the caller's true location. It is
linked from the homepage, so it is meant to be reachable; a browser just has to reach it from the
right place. It was fetched with one authenticated GET routed through a **German egress** (a Tor
circuit pinned to a German exit, `ExitNodes {de}`), which returns 200 with the password.

The automated crawl can't reach it, so it is handled as a documented *out-of-band* finding
([`src/analyze/geoGated.ts`](src/analyze/geoGated.ts)): the obstacle and its solution live in the
code and appear in every report, while the password value — like every other — is read at analysis
time from the gitignored output directory and never committed. `analyze` reports **7 of 8 by
automated analysis, plus this one via German egress**.

## Knowing the crawl is complete

Completeness rests on three things, all reproducible:

- The crawl is breadth-first over a frontier with a seen-set, so it **terminates exactly when no
  reachable URL is left unfetched** — not on a page cap. A clean run prints `Frontier emptied`.
- An infinite pagination trap (`/report/?page=N`, which never ends) is **sampled, not followed
  forever**, and the skipped pages are counted so nothing is hidden.
- Every response is accounted for, including the 401/403s — an unexplained auth failure would mean a
  credential-plumbing bug, and there are none.

## Output

Everything lands in `out/` (gitignored):

```
out/
  archive/       one file per response, byte-for-byte, plus a .meta.json sidecar of status + headers
  manifest.json  the crawl index: every URL, how it was discovered, and its content hash
  report.md      findings with provenance, the geo-gated write-up, near-misses, and statistics
  findings.json  the same, machine-readable
  ocr-cache.json cached OCR results, keyed by content hash
```
