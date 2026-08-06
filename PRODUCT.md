# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Upwho is a local, single-user tool for a freelancer who wants to identify the people or companies behind anonymized Upwork job posts and find public ways to contact them directly.

## Product Purpose

Upwho runs against Upwork feeds, primarily Best Matches, groups jobs by buyer, recovers the buyer's public identity, and gathers enough evidence and public contact information for the user to decide whether and how to reach out. A successful run turns 20 to 30 anonymized buyers into a list that can be scanned quickly for usable contact paths and trustworthy identity matches.

## Positioning

Upwho connects an anonymized Upwork buyer to a cautiously verified public identity. It keeps the evidence behind each match visible instead of returning an unsupported name or company guess.

## Operating Context

The user normally starts a Best Matches run, waits while Upwho gathers and enriches client records, then scans the completed result for a person's name and public contact paths. Person name, website, LinkedIn, other social profiles, email, and other contact details matter most. Verified, possible, and unknown status plus source evidence help the user judge whether a match is reliable.

The dashboard also supports other Upwork feeds, skipped-country settings, forced reprocessing, saved-run history, sorting, and rerunning a single client. These are needed but secondary to the main Best Matches workflow.

## Capabilities and Constraints

- Keep the existing local, loopback-only web application and one-run-at-a-time execution model.
- Preserve all supported feeds and current run controls, but secondary controls may carry less visual weight.
- Expand the stored client result to include discovered email addresses, phone numbers, WhatsApp links, and other public contact paths when available.
- Contact links should open in a new browser tab. Dedicated copy controls are unnecessary.
- Results should use a lean table that exposes useful links and the strongest evidence with few clicks.
- Full evidence should expand inline within the table.
- The product does not track outreach status, replies, or CRM workflow.
- A normal run contains about 20 to 30 client records.

## Brand Commitments

The product name is Upwho. Product copy should be direct and restrained. The interface should use a polished, familiar prospecting-table language at the craft level of Apollo, Clay, and Upwork. It should be light, minimal, icon-led where the action is universally recognizable, and free of ornamental motion, dashboard card collages, dark themes, and unnecessary explanatory copy. The result should avoid a stiff corporate tone even while using established product conventions.

## Evidence on Hand

- Saved run results under `runs/*/result.json` provide realistic client and evidence data.
- `src/identity-extraction.ts` already detects email addresses in gathered text, but the current final result does not preserve them.
- Current identity and web-enrichment fields live in `src/types.ts`.
- No testimonials, public customer claims, or marketing proof are available or needed for this local tool.

## Product Principles

- Put the fastest path to a trustworthy contact method first.
- Make identity status and evidence strength inspectable through source provenance.
- Allow a run to target one Upwork job URL directly.
- Let search runs apply multiple Upwork filters from the dashboard.
- Keep recovered names visibly separate from verified identity claims and abstain from web enrichment for possible matches.
- Keep the common Best Matches workflow immediate and move occasional controls out of the way.
- Prefer dense, readable results over card-heavy presentation or extra navigation.
- Show only public contact data that the system actually found. Never invent missing details.
