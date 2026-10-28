import { describe, it, expect } from "vitest";
import { addDays, addMonths, buildLir, lastMondayOf, monday, monthsBetween, practiceSignal } from "./lir.js";

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
    expect(jul[0]).toMatchObject({ k: 1, month: "2026-08", hit: 1, of: 2, pct: 50 }); // judged w/c 31 Aug
    expect(jul[1]).toMatchObject({ k: 2, month: "2026-09", hit: 0, pct: 0 });
    expect(jul.length).toBe(2); // never the in-progress month
    expect(r.watch[0].ods).toBe("A"); // A: on track in Aug, nothing since -> stopped, listed first
    expect(r.watch[0].status).toBe("stopped");
    expect([r.onTrack, r.judged]).toEqual([1, 3]);
  });
});
