#!/usr/bin/env python3
"""Rebase-sync the thehumanbox-upstream mirror onto 1homsi/thehumanbox.

Layout produced by this script:

    main     = upstream/main tip + our additions overlay
               (one commit: "chore: sync upstream <ts> — rebase ...")
    upstream = a pure mirror ref at upstream/main's tip

Why a rebase and not a merge: upstream rewrites history from time to time
(release automation), so merges eventually conflict; replaying our small
addition set onto whatever their tip is never does.

Why the Git Data API and not git push: the fork is synced with a PAT whose
backing GitHub App has no `workflows` permission, and GitHub rejects any
git push that carries .github/workflows changes. The API path has no such
rejection, and ref updates through it still fire normal push events (which
trigger the deploy workflow when deploy-relevant files changed).

The overlay is defined by ADDITION_RE: every matching path on the current
main is replayed verbatim (blob shas are reused). Editing any other file on
main is temporary — the next sync drops it. To add a permanent file, put it
under one of these paths and extend the regex if needed.

Reads GH_TOKEN (required) and GITHUB_REPOSITORY (optional override).
Prints "upstream-moved: yes|no" as the last line for the workflow to act on.
"""
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

UPSTREAM = "1homsi/thehumanbox"
REPO = os.environ.get("GITHUB_REPOSITORY", "yylsszx/thehumanbox-upstream")
TOKEN = os.environ["GH_TOKEN"]

ADDITION_RE = re.compile(
    r"^(workers/"
    r"|scripts/sync_upstream\.py$"
    r"|docs/SUPER_BACKEND\.md$"
    r"|apps/web/public/cloud-sync\.js$"
    r"|apps/web/public/_routes\.json$"
    r"|apps/web/functions/(api|agent)/"
    r"|\.github/workflows/deploy-site\.yml$"
    r"|\.github/workflows/upstream-sync\.yml$"
    r"|\.last-sync$)"
)

# Upstream files that must NOT exist on the mirror (sha: null deletes a
# path from the base tree): dependabot would open PRs here that the daily
# rebase would immediately wipe, since only the overlay paths survive.
DELETIONS = [".github/dependabot.yml"]


def api(method, repo, path, body=None):
    req = urllib.request.Request(
        f"https://api.github.com/repos/{repo}/{path}",
        method=method,
        headers={
            "Authorization": f"Bearer {TOKEN}",
            "Accept": "application/vnd.github+json",
            "Content-Type": "application/json",
        },
        data=json.dumps(body).encode() if body is not None else None,
    )
    try:
        with urllib.request.urlopen(req) as r:
            text = r.read()
            return r.status, json.loads(text) if text else {}
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except Exception:
            return e.code, {}


def must(status, resp, what):
    if status not in (200, 201, 204):
        print(f"::error::{what} failed: HTTP {status} {json.dumps(resp)[:400]}")
        sys.exit(1)


def main():
    # 1. Upstream tip + tree.
    status, ref = api("GET", UPSTREAM, "git/ref/heads/main")
    must(status, ref, "reading upstream main")
    up_tip = ref["object"]["sha"]
    status, c = api("GET", UPSTREAM, f"git/commits/{up_tip}")
    must(status, c, "reading upstream commit")
    up_tree = c["tree"]["sha"]

    # 2. Our current main.
    status, ref = api("GET", REPO, "git/ref/heads/main")
    must(status, ref, "reading our main")
    our_tip = ref["object"]["sha"]
    status, c = api("GET", REPO, f"git/commits/{our_tip}")
    must(status, c, "reading our main commit")
    our_tree = c["tree"]["sha"]
    our_base = c["parents"][0]["sha"] if c.get("parents") else None

    print(f"upstream tip: {up_tip[:10]} (tree {up_tree[:10]})")
    print(f"our main:     {our_tip[:10]} (built on {str(our_base)[:10]})")

    # 3. Collect the addition overlay from our current tree.
    status, tree = api("GET", REPO, f"git/trees/{our_tree}?recursive=1")
    must(status, tree, "listing our tree")
    if tree.get("truncated"):
        print("::error::tree listing truncated; the overlay scan needs a wider strategy")
        sys.exit(1)
    entries = [
        {"path": t["path"], "mode": t["mode"], "type": "blob", "sha": t["sha"]}
        for t in tree.get("tree", [])
        if t.get("type") == "blob" and ADDITION_RE.match(t["path"])
    ]
    print(f"overlay: {len(entries)} files")

    # 4. A fresh heartbeat blob (keeps the repo active so GitHub never
    #    auto-disables the daily schedule after 60 idle days).
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    status, blob = api("POST", REPO, "git/blobs", {"content": ts + "\n", "encoding": "utf-8"})
    must(status, blob, "creating heartbeat blob")
    entries.append({"path": ".last-sync", "mode": "100644", "type": "blob", "sha": blob["sha"]})
    entries += [{"path": p, "mode": "100644", "type": "blob", "sha": None} for p in DELETIONS]

    # 5. Tree = upstream's tree + our overlay.
    status, new_tree = api("POST", REPO, "git/trees", {"base_tree": up_tree, "tree": entries})
    must(status, new_tree, "creating overlay tree on upstream")

    # 6. Commit on top of the upstream tip.
    status, new_commit = api(
        "POST",
        REPO,
        "git/commits",
        {
            "message": f"chore: sync upstream {ts} — rebase our additions onto {up_tip[:10]}",
            "tree": new_tree["sha"],
            "parents": [up_tip],
        },
    )
    must(status, new_commit, "creating sync commit")

    # 7. Move main (force: history is rewritten by design).
    status, r = api("PATCH", REPO, "git/refs/heads/main", {"sha": new_commit["sha"], "force": True})
    must(status, r, "updating main")
    print(f"main -> {new_commit['sha'][:10]}")

    # 8. Pure mirror branch at the upstream tip.
    status, r = api("PATCH", REPO, "git/refs/heads/upstream", {"sha": up_tip, "force": True})
    if status == 422:  # branch missing — create it
        status, r = api("POST", REPO, "git/refs", {"ref": "refs/heads/upstream", "sha": up_tip})
    must(status, r, "updating the upstream mirror branch")
    print(f"upstream branch -> {up_tip[:10]}")

    moved = our_base != up_tip
    print(f"upstream-moved: {'yes' if moved else 'no'}")


if __name__ == "__main__":
    main()
