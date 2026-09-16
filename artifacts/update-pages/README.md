# Before/After pictures for `update_pages` issues

The bot writes PNGs here. Nobody edits this folder by hand.

When an alert says a Railway compare, migrate, pricing, or features page is now
wrong, the issue it opens carries the copy to paste. A picture of the paragraph
with that copy in it answers the first question the person making the edit has,
and a browser only renders an image it can fetch, so the PNG is committed here
and the issue body embeds it from this path.

The embed is `github.com/<repo>/blob/<commit sha>/<path>?raw=true`, pinned to
the commit that wrote the file. This repo is private, so the address has to be
one the reader's own browser can authenticate: github.com is the host their
session is on, and GitHub serves its own URLs directly rather than through the
camo image proxy, which fetches anonymously and could never read a private repo.
The `download_url` the contents API returns is not that address – it is a
`raw.githubusercontent.com` URL with a signed token on the end, good for
minutes.

Each file is named for the page and a hash of the edit, so re-running the same
recommendation lands on the same file rather than a second copy of it, and a
rewritten edit gets a file of its own rather than changing the picture an
already-open issue points at.

Pruning breaks every open issue that embeds a pruned file, and a commit SHA
keeps the picture alive only while the commit is reachable, so prune once the
issues that reference the files are closed. Turning the whole thing off is
`SKIP_PAGE_VISUALS=true`, after which issues say the same thing in words.

See [`src/media/page-edit.ts`](../../src/media/page-edit.ts) for what is drawn
and [`src/media/visual.ts`](../../src/media/visual.ts) for what draws it.
