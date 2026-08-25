#!/usr/bin/env python3
"""
One-off backfill: repair the clickTier on admin-added cases.

Why this exists: until the fix in api/index.ts, POST /api/admin/cases hardcoded
clickTier: 'Starting near zero (0-100)' on every uploaded case, so 26 of the 27 cases
in data/added-cases.json carried a tier nobody ever measured. The corrections live in
data/click-tier-backfill.json, each with the quote from the case PDF it came from.

This is the no-Node path — it needs nothing but the python3 that ships with macOS.
(scripts/backfill-click-tiers.ts does the same thing if you have Node.)

It reads and writes data/added-cases.json on GitHub directly, which is where the live
site reads it from. It never touches your local clone, so a stale checkout is harmless.

Usage:
    export GITHUB_TOKEN=ghp_…
    python3 scripts/backfill-click-tiers.py            # dry run, prints the diff
    python3 scripts/backfill-click-tiers.py --write    # commits to the repo
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

GH_REPO = "martijndereeper-a11y/use-case-finder"
GH_PATH = "data/added-cases.json"
API = f"https://api.github.com/repos/{GH_REPO}/contents/{GH_PATH}"
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

token = os.environ.get("GITHUB_TOKEN", "")
if not token:
    sys.exit("GITHUB_TOKEN is not set. Export the deploy token first.")
write = "--write" in sys.argv


def gh(method, body=None):
    req = urllib.request.Request(API, method=method)
    req.add_header("Authorization", f"token {token}")
    req.add_header("Accept", "application/vnd.github.v3+json")
    if body is not None:
        req.add_header("Content-Type", "application/json")
        req.data = json.dumps(body).encode()
    try:
        with urllib.request.urlopen(req) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        detail = e.read().decode()[:300]
        if e.code == 401:
            sys.exit(f"GitHub rejected the token (401). It has expired or been revoked.\n{detail}")
        sys.exit(f"GitHub {method} failed: {e.code}\n{detail}")


backfill = json.load(open(os.path.join(ROOT, "data", "click-tier-backfill.json")))["cases"]

meta = gh("GET")
cases = json.loads(base64.b64decode(meta["content"]).decode())
by_id = {c["id"]: c for c in cases}
print(f"Read {len(cases)} admin-added cases from GitHub.\n")

changed, already, missing = 0, 0, []
for row in backfill:
    target = by_id.get(row["id"])
    if target is None:
        missing.append(row["id"])
        continue
    if target.get("clickTier") == row["clickTier"]:
        already += 1
        continue
    flag = "" if row["confidence"] == "stated" else "   (inferred — confirm)"
    print(f"  {row['company'][:34]:36s} {target.get('clickTier'):27s} -> {row['clickTier']}{flag}")
    target["clickTier"] = row["clickTier"]
    changed += 1

if missing:
    print(f"\nNot found in {GH_PATH}, check by hand: {', '.join(missing)}")
print(f"\n{changed} to change, {already} already correct.")

if not write:
    sys.exit("Dry run — re-run with --write to commit.")
if not changed:
    sys.exit(0)

gh("PUT", {
    "message": "Backfill clickTier on admin-added cases from their PDFs",
    "content": base64.b64encode(json.dumps(cases, indent=2, ensure_ascii=False).encode()).decode(),
    "sha": meta["sha"],
})
print(f"Wrote {changed} correction(s) to {GH_PATH}.")
print("The live site picks these up on its next /api/use-cases call — no redeploy needed.")
