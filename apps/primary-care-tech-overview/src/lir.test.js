import { describe, it, expect } from "vitest";
import { addDays, addMonths, buildLir, lastMondayOf, mix, monday, monthsBetween, passes, practiceSignal } from "./lir.js";

// lastWeek = w/c Mon 19 Oct 2026; data from Mon 1 Jun 2026
const ctx = { need: 3, lastWeek: "2026-10-19", firstWeek: "2026-06-01" };
// recalls on the Wednesday of each listed week
const wk = (mondays, n = 10) => Object.fromEntries(mondays.map((m) => [addDays(m, 2), n]));
const P = (o) => ({ name: "A", ods: "A1", signed: "2026-06-03", paid: false, days: {}, users: {}, ...o });
const LAST4 = ["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19"];

describe("lir (weekly usage)", () => {
  it("date helpers", () => {
    expect(monday("2026-10-28")).toBe("2026-10-26");
    expect(monday("2026-10-26")).toBe("2026-10-26");
    expect(lastMondayOf("2026-09")).toBe("2026-09-28");
    expect(addMonths("2025-12", 1)).toBe("2026-01");
    expect(monthsBetween("2025-11", "2026-02")).toBe(3);
  });

  it("on track = at least K of the last 4 weeks with 5+ recalls", () => {
    expect(practiceSignal(P({ days: wk(LAST4.slice(1)) }), ctx).status).toBe("on_track");
    expect(practiceSignal(P({ days: wk(LAST4.slice(2)) }), ctx).used).toBe(2);
    // a few test clicks each week isn't usage
    expect(practiceSignal(P({ days: wk(LAST4, 4) }), ctx).used).toBe(0);
  });

  it("one bulk week then silence is a churn signal, not health", () => {
    const s = practiceSignal(P({ days: wk(["2026-09-07"], 800) }), ctx);
    expect(s.status).toBe("stopped");
  });

  it("dropped = was on track in the previous 8 weeks, now isn't", () => {
    const s = practiceSignal(P({ days: wk(["2026-09-07", "2026-09-14", "2026-09-21", "2026-10-19"]) }), ctx);
    expect(s.status).toBe("dropped");
  });

  it("new practices get time; old ones that never used it are flagged", () => {
    expect(practiceSignal(P({ signed: "2026-10-01" }), ctx).status).toBe("ramping");
    expect(practiceSignal(P({ signed: "2026-06-03" }), ctx).status).toBe("not_reached");
  });

  it("never reads weeks before the data as unused", () => {
    expect(practiceSignal(P(), { ...ctx, firstWeek: "2026-10-12" }).status).toBe("unknown");
  });

  it("totals recalls up to the last full week", () => {
    const s = practiceSignal(P({ days: { "2026-06-10": 100, "2026-10-21": 7, "2026-10-27": 50 } }), ctx);
    expect([s.totalRecalls, s.recentRecalls]).toEqual([107, 7]); // 27 Oct is in the unfinished week
  });

  it("counts staff who recalled in the last 4 weeks", () => {
    const s = practiceSignal(P({ users: { "a@nhs.net": ["2026-10-20"], "b@nhs.net": ["2026-08-01"] } }), ctx);
    expect(s.activeUsers).toEqual(["a@nhs.net"]);
  });

  it("builds cohorts judged on each month's last week, with no-data cells", () => {
    const lir = {
      from: "2026-08-03",
      practices: [
        P({ ods: "A", signed: "2026-07-10", days: wk(["2026-08-10", "2026-08-17", "2026-08-24", "2026-08-31"]) }),
        P({ ods: "B", signed: "2026-07-20" }),
        P({ ods: "C", signed: "2026-09-02", days: wk(LAST4) }),
      ],
    };
    const r = buildLir(lir, { today: "2026-10-28" }); // Oct in progress -> last full month Sep
    expect(r.lastWeek).toBe("2026-10-19");
    expect(r.cohorts.map((c) => [c.month, c.n])).toEqual([["2026-07", 2], ["2026-09", 0 + 1]]);
    const jul = r.cohorts[0].cells;
    expect(jul[0]).toMatchObject({ k: 0, month: "2026-07", noData: true }); // signing month, before the data
    expect(jul[1]).toMatchObject({ k: 1, month: "2026-08", hit: 1, of: 2, pct: 50 }); // judged w/c 31 Aug
    expect(jul[2]).toMatchObject({ k: 2, month: "2026-09", hit: 0, pct: 0 });
    expect(jul.length).toBe(3); // never the in-progress month
    // signed in Sep: its signing month (Sep) is already judged, Oct isn't
    expect(r.cohorts[1].cells.map((c) => c.k)).toEqual([0]);
    expect(r.watch[0].ods).toBe("A"); // A: on track in Aug, nothing since -> stopped, listed first
    expect(r.watch[0].status).toBe("stopped");
    expect([r.onTrack, r.judged]).toEqual([1, 3]);
  });

  it("bulk and suggestions are shares of patients, blank below 20", () => {
    const p = P({ days: { "2026-07-01": 60, "2026-10-20": 40 }, bulk: { "2026-07-01": 50 }, sugg: { "2026-07-01": [45, 50], "2026-10-20": [30, 40] } });
    const m = mix(p, null, "2026-10-25");
    expect([m.bulk, Math.round(m.sugg)]).toEqual([50, 83]);
    expect(mix(P({ days: { "2026-07-01": 19 }, bulk: { "2026-07-01": 19 } }), null, "2026-10-25").bulk).toBeNull();
  });

  it("reads all-time share with a last-4-weeks arrow", () => {
    // 100 bulk in July, then 40 single in the last 4 weeks: 71% bulk overall, 0% lately
    const s = practiceSignal(P({ days: { "2026-07-01": 100, "2026-10-20": 40 }, bulk: { "2026-07-01": 100 } }), ctx);
    expect(Math.round(s.allMix.bulk)).toBe(71);
    expect(s.trends.bulk).toBe("down");
    expect(passes(s, "bulk", 70)).toBe(true);
    expect(passes(s, "sugg", 90)).toBeNull();
    // the weekly strip carries the split for the hover card
    expect(s.strip.at(-1)).toMatchObject({ count: 40, bulk: 0 });
  });

  it("cohort cells for bulk count only practices with enough recalls", () => {
    const lir = {
      from: "2026-08-03",
      practices: [
        P({ ods: "A", signed: "2026-07-10", days: { "2026-08-12": 100 }, bulk: { "2026-08-12": 80 } }),
        P({ ods: "B", signed: "2026-07-20", days: { "2026-08-12": 100 }, bulk: { "2026-08-12": 10 } }),
        P({ ods: "C", signed: "2026-07-20", days: { "2026-08-12": 5 } }),
      ],
    };
    const r = buildLir(lir, { today: "2026-10-28", metric: "bulk", bars: { bulk: 50 } });
    expect(r.cohorts[0].cells[1]).toMatchObject({ month: "2026-08", hit: 1, of: 2, pct: 50 });
    expect(r.cards.bulk).toMatchObject({ pass: 1, of: 2, all: 44 }); // 90 bulk of 205 patients
  });
});
