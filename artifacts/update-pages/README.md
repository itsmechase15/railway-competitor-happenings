# Before/After pictures for `update_pages` issues

The bot writes PNGs here. Nobody edits this folder by hand.

When an alert says a Railway compare, migrate, pricing, or features page is now
wrong, the issue it opens carries the copy to paste. A picture of the paragraph
with that copy in it answers the first question the person making the edit has,
and GitHub only renders an image it can fetch, so the PNG is committed here and
the issue body embeds it from this path.

Each file is named for the page and a hash of the edit, so re-running the same
recommendation lands on the same file rather than a second copy of it, and a
rewritten edit gets a file of its own rather than changing the picture an
already-open issue points at.

Pruning is safe once the issues that reference the files are closed. Turning the
whole thing off is `SKIP_PAGE_VISUALS=true`, after which issues say the same
thing in words.

See [`src/media/page-edit.ts`](../../src/media/page-edit.ts) for what is drawn
and [`src/media/visual.ts`](../../src/media/visual.ts) for what draws it.
