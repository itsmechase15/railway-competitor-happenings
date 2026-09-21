# Before/After screenshots for `update_pages` issues

The bot writes PNGs here. Nobody edits this folder by hand.

When an alert says a Railway compare, migrate, pricing, or features page is now
wrong, the issue it opens carries the copy to paste. Two screenshots of the page
answer the first question the person making the edit has: one of the page as it
reads today, one of the same page with the proposed copy in it. A browser only
renders an image it can fetch, so the PNGs are committed here and the issue body
embeds them from these paths.

The After shot is taken with the copy put into a headless browser's own copy of
the document, between two screenshots, in a tab that is then thrown away.
Nothing in this folder was ever published to railway.com, and the caption in the
issue says so.

The embed is `github.com/<repo>/blob/<commit sha>/<path>?raw=true`, pinned to
the commit that wrote the file. This repo is public, so any reader's browser can
fetch it without signing in, and the SHA is what keeps it showing the same
picture a week later; an unsigned `raw.githubusercontent.com` address at that
SHA is the same file by another name. The `download_url` the contents API
returns is neither – it is a `raw.githubusercontent.com` URL with a signed token
on the end, good for minutes.

Each pair is named for the page, a hash of the edit, and the day it was taken,
ending `-before.png` and `-after.png`. Re-running the same recommendation the
same morning lands on the same files rather than a second copy of them; a run a
week later photographs the page as it is that week rather than embedding a
Before that has gone stale; and a rewritten edit gets its own pair rather than
changing the pictures an already-open issue points at.

Pruning breaks every open issue that embeds a pruned file, and a commit SHA
keeps the picture alive only while the commit is reachable, so prune once the
issues that reference the files are closed. Turning the whole thing off is
`SKIP_PAGE_VISUALS=true`, after which issues say the same thing in words.

See [`src/media/live-page.ts`](../../src/media/live-page.ts) for the browser
that takes them, [`src/media/page-edit.ts`](../../src/media/page-edit.ts) for
what the edit is and where each file goes, and
[`src/media/visual.ts`](../../src/media/visual.ts) for which edits get a pair.
