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
- The `opencode` CLI on `PATH`, connected to OpenCode Go. The default is
  `opencode-go/deepseek-v4-flash`; set `OPENCODE_MODEL` to use another
  configured provider and model.
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
Philippines, Ukraine, Kenya, and Nigeria. Override it with a comma-separated `--countries`
value; pass an empty value to disable it. Existing job IDs are skipped across
runs unless `--force` is supplied.

`--no-model` skips identity claims and web enrichment for a safe collection-only
diagnostic. Identity analysis uses three independent OpenCode analysts followed
by two shared adversarial verification passes. Public-web matches also require
two verifier passes. A claim is stored only when every verifier accepts it and
its exact quote or URL exists in the observed source data. Disagreement produces
an empty field. A model failure fails that client, and a total provider outage
fails the run without publishing an inaccurate result.

Model calls have a per-attempt timeout, an overall budget, one retry, and a
shared concurrency permit. They run in disposable directories with shell,
filesystem, and task tools denied, and with any MCP server from the global
OpenCode config switched off so no foreign tool reaches a run.

When a model returns nothing at all — its attempt deadline passes without a
single streamed event — a run of such attempts stops the run with a message naming
the model, rather than spending every remaining call to learn the same thing. The
threshold defaults to half of `OPENCODE_CONCURRENCY` (minimum 3), because calls in
flight together fail together; override it with `OPENCODE_MUTE_TIMEOUT_LIMIT`. Any
response at all, including an error or a slow partial answer, clears the streak, so
a provider that is merely saturated does not doom the clients that follow.

Past-job research reads a buyer's four newest and four oldest public past jobs —
the newest say what they want now, and the oldest are where a client still new to
the platform tends to have spelled out who they are — through concurrent in-page
requests. Whatever those cannot produce falls back to a rendered page, one at a
time. Because a rendered page can also clear a bot challenge, the first fallback
is followed by another round of cheap reads instead of a navigation per remaining
job. Every past job still gets its own rendered attempt if it needs one, so a
challenged buyer is slow rather than silently less complete; cap that with
`UPWHO_PAST_JOB_NAVIGATIONS` (default `-1`, meaning no cap), which trades past-job
completeness for time and records the reason against each job it skips.

Tune throughput with `--clients` (buyers analysed at once, maximum and default 3),
`--research-tabs` (browser tabs for past-job research, default 3), and
`--details` (job detail requests in flight, default 4). Each research tab reads
`UPWHO_PAST_JOB_CONCURRENCY` past jobs at once (default 4), so the two multiply;
raising them past what Upwork tolerates earns challenge pages instead of speed.
`OPENCODE_CONCURRENCY` bounds model calls across the whole run (default 8).

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
