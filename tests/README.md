# Netheraxia tests

Headless regression tests for the static pages. They stub a minimal DOM and a
fake GitHub API, so no browser and no network access are required.

```bash
node tests/run.mjs
```

Covers:

- both 3D backgrounds (voxel tunnel + wire terrain) across themes and viewports
- the server-status presets and how they drive the home page
- the connect-button switch (hidden button must also block the modal)
- server addresses staying inside the modal, version staying on the page
- the GitHub sync: auth, create, skip-unchanged, single-file publish,
  UTF-8 round-trip, 409 retry, pull, no push loops and offline behaviour
