## What and why

Adds a chat section to the privacy page. Static HTML only.

## How I verified it

Static page, no build and no tests reference it (`grep` over `test/`, `scripts/`, `.github/`, `package.json` found nothing).

    python3 html.parser walk of apps/legal/public/privacy.html
    -> unclosed tags: none; mismatched end tags: none; duplicate ids: none
    -> TOC hrefs unresolved: none (who, website, workers, chat, limited-use, retention, sharing, rights, security, changes)
    -> TOC numbering equals h2 numbering 1 to 10
    -> U+2014 and U+2013 count: 0 and 0

Not verified: a rendered browser view (no screenshot taken), and the live Messenger and retention facts above.

## Checklist

- [x] No test suite applies to a static legal page
- [x] No new dependencies
