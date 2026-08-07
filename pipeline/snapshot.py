#!/usr/bin/env python3
"""
Takes a snapshot of dashboard metrics for historical tracking.
Saves to snapshots/ directory as JSON with date-stamped filename.

Tracks two live tiers:
  - live_full_planner  → practices using all planner functionality
  - live_planner       → practices using planner only
  - live (legacy)      → total live (planner + full_planner) for back-compat
"""

import json
from datetime import datetime, timezone
from pathlib import Path

SCRIPT_DIR = Path(__file__).parent
PROJECT_ROOT = SCRIPT_DIR.parent
DATA_DIR = PROJECT_ROOT / "apps" / "tech-growth-map" / "public" / "data"
SNAPSHOT_DIR = PROJECT_ROOT / "apps" / "tech-growth-map" / "public" / "snapshots"


def load_set(path):
    if not path.exists():
        return set()
    with open(path) as f:
        return set(c.upper() for c in json.load(f))


def take_snapshot():
    now = datetime.now(timezone.utc)
    date_str = now.strftime("%Y-%m-%d")

    live_all_ods = load_set(DATA_DIR / "live_customers.json")
    full_planner_ods = load_set(DATA_DIR / "live_customers_full_planner.json")
    waitlist_ods = load_set(DATA_DIR / "waitlist_ods.json")
    # Gold tier + onboarding — snapshotted so the map's timeline scrub shows
    # the tier a practice actually had on that date (files may predate the
    # feature; load_set returns empty for a missing file).
    paid_ods = load_set(DATA_DIR / "paid_customers.json")
    onboarding_ods = load_set(DATA_DIR / "onboarding_ods.json")

    # Full planner is a subset of live → planner-only is the difference.
    planner_only_ods = live_all_ods - full_planner_ods

    with open(DATA_DIR / "practices_geocoded.json") as f:
        practices = json.load(f)

    counts = {"live_planner": 0, "live_full_planner": 0, "waitlist": 0}
    patients = {"live_planner": 0, "live_full_planner": 0, "waitlist": 0}

    for p in practices:
        ods = p["ods"].upper()
        pat = p.get("patients", 0) or 0
        if ods in full_planner_ods:
            counts["live_full_planner"] += 1
            patients["live_full_planner"] += pat
        elif ods in planner_only_ods:
            counts["live_planner"] += 1
            patients["live_planner"] += pat
        elif ods in waitlist_ods:
            counts["waitlist"] += 1
            patients["waitlist"] += pat

    live_total = counts["live_planner"] + counts["live_full_planner"]
    live_patients_total = patients["live_planner"] + patients["live_full_planner"]
    pipeline_practices = live_total + counts["waitlist"]
    pipeline_patients = live_patients_total + patients["waitlist"]

    snapshot = {
        "date": date_str,
        "timestamp": now.isoformat(),
        "practices": {
            # New tier breakdown:
            "live_planner": counts["live_planner"],
            "live_full_planner": counts["live_full_planner"],
            # Legacy: total live (subsumes both tiers) — kept so old timeline
            # entries and any external consumers don't break.
            "live": live_total,
            "waitlist": counts["waitlist"],
            "pipeline": pipeline_practices,
            "total": len(practices),
            "coverage_pct": round((pipeline_practices / len(practices)) * 100, 2) if practices else 0,
        },
        "patients": {
            "live_planner": patients["live_planner"],
            "live_full_planner": patients["live_full_planner"],
            "live": live_patients_total,
            "waitlist": patients["waitlist"],
            "pipeline": pipeline_patients,
        },
        "live_ods": sorted(live_all_ods),
        "live_full_planner_ods": sorted(full_planner_ods),
        "waitlist_ods": sorted(waitlist_ods),
        "paid_ods": sorted(paid_ods),
        "onboarding_ods": sorted(onboarding_ods),
    }

    SNAPSHOT_DIR.mkdir(exist_ok=True)
    with open(SNAPSHOT_DIR / f"{date_str}.json", "w") as f:
        json.dump(snapshot, f, indent=2)

    # Update lightweight timeline (no ODS lists, just counts).
    timeline_file = SNAPSHOT_DIR / "timeline.json"
    timeline = json.loads(timeline_file.read_text()) if timeline_file.exists() else []
    entry = {k: v for k, v in snapshot.items() if k not in ("live_ods", "live_full_planner_ods", "waitlist_ods", "paid_ods", "onboarding_ods")}
    timeline = [t for t in timeline if t["date"] != date_str] + [entry]
    timeline.sort(key=lambda t: t["date"])
    with open(timeline_file, "w") as f:
        json.dump(timeline, f, indent=2)

    print(f"Snapshot saved: {date_str}")
    print(f"  Pipeline: {pipeline_practices} practices ({pipeline_patients:,} patients)")
    print(f"  Live full planner: {counts['live_full_planner']} | Live planner: {counts['live_planner']} | Waitlist: {counts['waitlist']}")


if __name__ == "__main__":
    take_snapshot()
