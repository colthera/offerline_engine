# Offerline engine

The shared job scanner for Offerline. Every hour it reads the public job boards of the companies in `catalog.json` and publishes the US jobs it finds to the `data` branch:

- `jobs.json`: every US job found, with company, title, location, link and when it was first seen
- `health.json`: one line per board (worked or failed, response time, job counts)
- `history.jsonl`: one summary line per scan
- `report.md`: a readable summary of the latest scan

Each user's private watcher reads `jobs.json` and applies their own filters. The scanner uses no keys and no Claude usage.

The `data` branch is replaced on every scan, so it never grows.

## Company application limits

A catalog entry may carry `"applicationLimit": {"count": 3, "days": 30, "source": "<link to the company's own page stating it>"}`. Add one only when the company itself states the limit (its careers FAQ, apply page or confirmation email), or when the maintainer has confirmed it; say which in `source`. Every user's dashboard picks it up at their next morning run and warns before they go over it.
