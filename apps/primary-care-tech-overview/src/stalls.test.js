import { describe, it, expect } from "vitest";
import { aggregate, buildContext, buildJourney, median, resolveGoLive } from "./stalls.js";

const NOW = new Date("2026-08-28T00:00:00Z");
const onb = (recall = "todo") => [
  { step: "EMIS Notified", key: "emis_notified", state: "done" },
  { step: "Bloods automation", key: "bloods_automation", state: "pending" },
  { step: "Recall Session", key: "recall_session", state: recall },
];
const deal = (o) => ({ deal_id: "1", name: "A", ods: "A1", ehr: "EMIS", stage: "dpa_signed", created: "2026-01-01", stage_dates: {}, onboarding: onb(), ...o });

describe("stalls", () => {
  it("median handles even/odd/empty", () => {
    expect(median([])).toBeNull(); expect(median([3, 1, 2])).toBe(2); expect(median([1, 2, 3, 4])).toBe(3);
  });

  it("resolves go-live from the best source, in order", () => {
    const base = deal({ stage_dates: { dpa_signed: "2026-02-01", live: "2026-03-01" } });
    const visits = { A1: { history: [{ status: "happened", date: "2026-01-15" }, { status: "happened", date: "2026-03-10" }] } };
    const events = { steps: [{ ods: "A1", step_key: "recall_session", to_state: "done", changed_at: "2026-03-20T10:00:00Z" }], blocks: [] };
    expect(resolveGoLive(base, buildContext({ visits, events })).date).toBe("2026-03-10"); // visit on/after DPA wins
    expect(resolveGoLive(base, buildContext({ events }))).toEqual({ date: "2026-03-20", source: "event" });
    expect(resolveGoLive(base, buildContext({ recallers: [{ ods: "A1", first_recall_month: "2026-04" }] }))).toEqual({ date: "2026-04-01", source: "recalls" });
    expect(resolveGoLive(deal({ ...base, onboarding: onb("done") }), buildContext({}))).toEqual({ date: "2026-03-01", source: "sheet" });
    expect(resolveGoLive(base, buildContext({}))).toBeNull();
  });

  it("builds monotonic segments and an in-flight current stage", () => {
    const j = buildJourney(deal({ stage_dates: { dpa_sent: "2026-01-11", dpa_signed: "2026-01-05", live: "2026-02-10" } }), buildContext({}), NOW);
    // dpa_signed (Jan 5) is earlier than dpa_sent (Jan 11) → skipped as out-of-order
    expect(j.segments.map((s) => `${s.from}>${s.to}:${s.days}`)).toEqual(["created>dpa_sent:10", "dpa_sent>live:30"]);
    expect(j.completed).toBe(false);
    expect(j.current).toMatchObject({ key: "live", days: 199 });
    expect(j.totalDays).toBe(239);
    expect(j.onboarding.nextStep.key).toBe("bloods_automation");
  });

  it("aggregates phases, cohorts and blocked steps", () => {
    const ctx = buildContext({
      events: { steps: [], blocks: [{ ods: "A1", step_key: "bloods_automation", waiting_on: "third_party", reason: "labs", blocked_at: "2026-08-01T00:00:00Z", cleared_at: null }] },
      recallers: [{ ods: "B1", first_recall_month: "2026-05" }],
    });
    const js = [
      buildJourney(deal({ stage_dates: { dpa_signed: "2026-02-01" } }), ctx, NOW),
      buildJourney(deal({ deal_id: "2", ods: "B1", created: "2026-03-01", stage_dates: { dpa_signed: "2026-03-11" } }), ctx, NOW),
    ];
    const a = aggregate(js, ctx, NOW);
    expect(a.completed).toBe(1); expect(a.inflight).toBe(1);
    expect(a.medianTotal).toBe(61);
    expect(a.phases.find((p) => p.key === "dpa_signed")).toMatchObject({ n: 1, median: 51, inflight: 1 });
    expect(a.steps.find((s) => s.key === "bloods_automation")).toMatchObject({ stuck: 1, blocked: 1, byWaiting: { third_party: 1 } });
    expect(a.activeBlockList[0]).toMatchObject({ ods: "A1", days: 27 });
    expect(a.cohorts.map((c) => [c.quarter, c.n, c.live])).toEqual([["2026 Q1", 2, 1]]);
  });
});
