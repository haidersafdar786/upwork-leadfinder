# Upwho

Upwho recovers the public identity behind an anonymized Upwork job. The result
is one row per `buyerId`, with all matching jobs, quoted evidence, confidence,
and cautiously verified web presence.

This is a local tool for one freelancer. It binds the dashboard to loopback and
stores runs as ordinary folders under `runs/`.

## Requirements

- Node.js 24 or newer.
- A logged-in Chrome, Brave, Edge, Vivaldi, Opera, Arc, or Chromium browser.
  Upwho starts or attaches to it through Playwright `connectOverCDP`. Safari and
  Firefox are detected and an installed Chromium browser is used instead.
- The `opencode` CLI on `PATH`, configured with a free model. The default is
  `opencode/deepseek-v4-flash-free`; set `OPENCODE_MODEL` to change it.
- `npm install`.

Direct HTTP requests to Upwork are not used. The browser loads a normal feed,
observes the bearer tokens already used by the app, selects one by proving it
can fetch job details, and performs same-origin GraphQL calls.

## Run a feed

```sh
npm run cli -- run --feed best-matches
npm run cli -- run --feed most-recent --force
npm run cli -- run --feed search --query "shopify app"
```

The default country skip list is India, Israel, Pakistan, Bangladesh,
Philippines, and Ukraine. Override it with a comma-separated `--countries`
value; pass an empty value to disable it. Existing job IDs are skipped across
runs unless `--force` is supplied.

`--no-model` skips identity claims and web enrichment for a safe collection-only
diagnostic. Normal runs use an OpenCode analyst followed by two separate
adversarial verification passes for identity and public-web matches. A claim is
stored only when every verifier accepts it and its exact quote or URL exists in
the observed source data. Disagreement, invalid output, and model failure produce
an empty field instead of a deterministic guess.

Model calls have a per-attempt timeout, an overall budget, one retry, and a
shared concurrency permit. They run in disposable directories with shell,
filesystem, and task tools denied.

## Dashboard

```sh
npm run dashboard
# open http://127.0.0.1:4040
```

The dashboard can start every supported feed, stream progress over SSE, sort the
buyer table, open saved runs, and rerun a single saved client. The server binds
only to `127.0.0.1` and allows one run at a time.

## Run folders

Each run is `runs/<timestamp>_<feed>/`:

- `data/<job-id>.json` contains the preserved feed state, authenticated detail,
  attachment text, and attachment failures.
- `result.json` contains the final client-level result.

Accepted public-web results retain their search or fetch evidence in each
client's `webEvidence` array. Contact details must appear in accepted official-site
evidence and pass both adversarial verifiers; email domains must also match that
site. Company, product, person, and website anchors are searched independently.
Additional verified organization profiles are retained as supporting links, and
social URLs that return a definitive 404 or 410 are discarded. The dashboard
shows these web sources alongside Upwork identity evidence.

There are no locks, resume stages, migrations, or versioned artifacts. A failed
run starts over.

## Checks

```sh
npm test
npm run cli -- --help
```

The saved fixtures include the old implementation's 100 identity records and
six web-enrichment cases. Regression tests exercise analyst/verifier agreement,
exact evidence provenance, ambiguous matches, competitor references, and contact
source restrictions. The old repository remains read-only reference data; its
implementation is not imported.

## Dependencies

Playwright pays for cross-platform Chromium CDP control and page-context HTTP.
Zod validates every untrusted analyst and verifier response for identity and
enrichment. Node's standard library handles the CLI, server, persistence,
attachment parsing, and concurrency.
