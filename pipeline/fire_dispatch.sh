#!/usr/bin/env bash
# Fire a repository_dispatch event to trigger the refresh workflow RIGHT NOW.
#
# Why this exists: GitHub's `schedule: cron` trigger is notoriously
# unreliable on free-tier runners — we measured a ~65min median gap
# between successful scheduled runs. `repository_dispatch`, by contrast,
# starts the workflow in ~2 seconds. Use this endpoint for true
# near-realtime HubSpot → dashboard sync.
#
# End-to-end (measured 2026-04-08):
#   dispatch POST        →  2s   (workflow queues immediately)
#   workflow run         →  ~90s (Python refresh + snapshot + push)
#   Vercel redeploy      →  ~15s
#   ────────────────────
#   dispatch → LIVE      →  ~107s total
#
# Usage — from a HubSpot workflow webhook action, an external cron
# service (cron-job.org, EasyCron), or a shell:
#
#   GITHUB_TOKEN=ghp_xxxxxxxxxxxx ./scripts/fire_dispatch.sh
#
# Required scopes on the GitHub token:
#   - Classic PAT: `repo` (or `public_repo` for public repos)
#   - Fine-grained: "Contents: read-and-write" on Will-Suvera/Primary-Care-Recall
#                   (repository_dispatch fires under Contents, not Actions)
#
# Optional env vars:
#   REPO        default: Will-Suvera/Primary-Care-Recall
#   EVENT_TYPE  default: hubspot-waitlist-changed (must match workflow)
#   SOURCE      default: manual (free-form label logged in run metadata)
#
# HubSpot setup (push-based, instant):
#   1. HubSpot → Automation → Workflows → Create workflow (contact-based)
#   2. Trigger: "Contact added to list" → list 1535 (and a second
#      workflow for "Contact removed from list" → list 1535)
#   3. Action: "Send a webhook"
#        URL:    https://api.github.com/repos/Will-Suvera/Primary-Care-Recall/dispatches
#        Method: POST
#        Headers:
#          Authorization: token <GITHUB_PAT>
#          Accept:        application/vnd.github.v3+json
#          Content-Type:  application/json
#        Body:
#          {"event_type":"hubspot-waitlist-changed","client_payload":{"source":"hubspot"}}

set -euo pipefail

: "${GITHUB_TOKEN:?GITHUB_TOKEN env var is required (classic PAT with 'repo' scope)}"
REPO="${REPO:-Will-Suvera/Primary-Care-Recall}"
EVENT_TYPE="${EVENT_TYPE:-hubspot-waitlist-changed}"
SOURCE="${SOURCE:-manual}"

response=$(curl -sS -o /tmp/dispatch.out -w "%{http_code}" \
    -X POST "https://api.github.com/repos/${REPO}/dispatches" \
    -H "Authorization: token ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github.v3+json" \
    -H "Content-Type: application/json" \
    -d "{\"event_type\":\"${EVENT_TYPE}\",\"client_payload\":{\"source\":\"${SOURCE}\"}}")

if [[ "${response}" == "204" ]]; then
    echo "dispatch fired: ${EVENT_TYPE} on ${REPO} (source=${SOURCE})"
    exit 0
fi

echo "dispatch FAILED (HTTP ${response})" >&2
cat /tmp/dispatch.out >&2
exit 1
