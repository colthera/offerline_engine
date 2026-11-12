# Offerline engine

The shared job scanner for Offerline. Every hour it reads the public job boards of the companies in `catalog.json` and publishes the US jobs it finds to the `data` branch:

- `jobs.json`: every US job found, with company, title, location, link and when it was first seen
- `health.json`: one line per board (worked or failed, response time, job counts)
- `history.jsonl`: one summary line per scan
- `report.md`: a readable summary of the latest scan

Each user's private watcher reads `jobs.json` and applies their own filters. The scanner uses no keys and no Claude usage.

The `data` branch is replaced on every scan, so it never grows.
