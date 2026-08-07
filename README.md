Upwork Leadfinder

Upwork Leadfinder finds the public identity behind anonymized Upwork jobs. It groups jobs by buyer, keeps the evidence used for each match, and links verified public websites and contact paths.

It runs locally for one freelancer. The dashboard listens on 127.0.0.1 and runs are saved under runs/. Upwork Leadfinder is not affiliated with Upwork or OpenCode. Review possible matches and contact details before using them.

How it works

1. Upwork Leadfinder opens an Upwork feed or one job URL in a logged-in Chromium browser. It uses that browser session and same-origin requests, not direct HTTP requests to Upwork.
2. It collects job details, attachments, reviews, and selected public past jobs, then groups matching jobs by buyer ID.
3. OpenCode analysts and verifiers compare the collected text. Upwork Leadfinder keeps a claim only when it has exact supporting evidence and labels the result verified, possible, or unknown.
4. It searches public web sources using the recovered names, companies, products, and websites. It keeps a link or contact detail only when the source supports the match.
5. It saves raw job records and a client-level result that the dashboard can reopen later.

Requirements

* Node.js 24 or newer
* The opencode CLI on PATH for identity and web enrichment
* A logged-in Chrome, Brave, Edge, Vivaldi, Opera, Arc, or Chromium browser

Upwork Leadfinder uses Chrome DevTools Protocol to connect to the browser. If no endpoint is available at http://127.0.0.1:9222, it tries to start an installed Chromium-family browser.

If your browser is already open without remote debugging, fully quit it and run Upwork Leadfinder again.

Set UPWORK_LEADFINDER_CDP_URL to use another endpoint.

Quick start

git clone https://github.com/NomanGul/upwho.git
cd upwho
npm install
opencode --version

Start the dashboard:

npm run dashboard
# open http://127.0.0.1:4040

Choose a feed, add search filters if needed, and click Run.

Open a saved result from Run history. Click an evidence row to inspect the source quotes and public web evidence.

For the CLI, run one of these:

npm run cli -- run --feed best-matches
npm run cli -- run --feed search --query "shopify app"
npm run cli -- run --job-url "https://www.upwork.com/jobs/~0123456789abcdef"

Search queries can also be complete Upwork search URLs.

Existing job IDs are skipped across runs; add --force to process them again.

Add --no-model for collection-only runs without identity or web enrichment.

Output

Each run is stored in:

runs/<timestamp>_<feed>/

The structure is:

data/<job-id>.json   raw feed and job data
result.json          one result per buyer
manifest.json        completion marker

The runs/ directory can contain job descriptions and public contact details. It is ignored by Git, but treat it as private.

Development

npm test
npm run cli -- --help

npm run test:accuracy runs the model-backed identity corpus and is separate from the fast regression suite.

⚡ Upwork Leadfinder

Find the real people and companies behind Upwork opportunities — with evidence.

Find the lead. Verify the identity. Win the client.
