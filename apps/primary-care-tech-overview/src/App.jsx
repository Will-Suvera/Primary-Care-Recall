import React, { useEffect, useRef, useState } from "react";
import FunnelBoard from "./components/FunnelBoard.jsx";
import OnboardingHub from "./components/OnboardingHub.jsx";
import { useGoogleAuth } from "./auth.js";
import { firstNameFromEmail, ONB_BASE } from "./onboarding.js";

const LOGO = "/assets/suvera-logo.png";

function SignInGate({ auth }) {
  const ref = useRef(null);
  useEffect(() => { auth.renderButton(ref.current); }, [auth.ready]);
  return (
    <div className="shell">
      <div className="signin-gate">
        <img className="signin-logo" src={LOGO} alt="Suvera" />
        <h1>Recalls Overview</h1>
        <p>Sign in with your <b>@suvera.co.uk</b> Google account to continue.</p>
        <div ref={ref} />
      </div>
    </div>
  );
}

const tabFromUrl = () =>
  new URLSearchParams(window.location.search).get("tab") === "onboarding" ? "onboarding" : "overview";

// Single-page Recalls Overview with two tabs (?tab=overview|onboarding):
//  • Overview — the read-only funnel analytics ("where everyone's at"); the
//    interactive onboarding checklist also lives in its DPA-Signed slide-over.
//  • Onboarding Hub — the action surface for DPA-signed-onwards practices; step
//    toggles write to Neon and flow back into the Overview's "X/9" roll-up.
export default function App() {
  const auth = useGoogleAuth();
  const [data, setData] = useState(null);
  const [visits, setVisits] = useState({}); // practice_visits.json (Notion recall/impl sessions, keyed by ODS)
  const [err, setErr] = useState(null);
  const [tab, setTab] = useState(tabFromUrl);

  // The dashboard data is served behind the login: the board + visits come from
  // the authenticated API, not public files, so the CS/deal data stays private
  // without any edge gate. Wait for sign-in in prod so the request carries the
  // token; in local dev (auth disabled) it loads immediately and openly.
  useEffect(() => {
    if (auth.enabled && !auth.user) return;
    const headers = auth.user?.token ? { Authorization: `Bearer ${auth.user.token}` } : {};
    fetch(`${ONB_BASE}/board`, { headers })
      .then((r) => (r.ok ? r.json() : Promise.reject(`HTTP ${r.status}`)))
      .then(setData)
      .catch((e) => setErr(String(e)));
    // recall/implementation sessions (best-effort; the Hub degrades to "not booked" without it)
    fetch(`${ONB_BASE}/visits`, { headers }).then((r) => (r.ok ? r.json() : {})).then(setVisits).catch(() => {});
  }, [auth.enabled, auth.user]);

  // keep tab state in sync with browser back/forward
  useEffect(() => {
    const onPop = () => setTab(tabFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const selectTab = (t) => {
    setTab(t);
    const u = new URL(window.location.href);
    if (t === "overview") u.searchParams.delete("tab");
    else u.searchParams.set("tab", t);
    window.history.pushState({}, "", u.pathname + u.search + u.hash);
  };

  // A 401/403 means the API rejected our Google token (expired session, or signed
  // in against a different OAuth client than the server trusts) — not a data
  // problem. Offer a clean re-sign-in rather than a dev-only "run python3" hint.
  if (err) {
    const authErr = err === "HTTP 401" || err === "HTTP 403";
    return (
      <div className="shell">
        <div className="signin-gate">
          <img className="signin-logo" src={LOGO} alt="Suvera" />
          <h1>Recalls Overview</h1>
          {authErr ? (
            <>
              <p>Your session wasn’t accepted. Sign in again with your <b>@suvera.co.uk</b> Google account.</p>
              <button className="su-signout" onClick={() => { setErr(null); auth.signOut?.(); }}>Sign in again</button>
            </>
          ) : (
            <p style={{ color: "var(--bad)" }}>Couldn’t load the dashboard: {err}.</p>
          )}
        </div>
      </div>
    );
  }

  // Google SSO gate (prod only — enabled when VITE_GOOGLE_CLIENT_ID is set)
  if (auth.enabled && auth.ready && !auth.user) return <SignInGate auth={auth} />;

  // DPA-signed-onwards cohort with an ODS code — matches what the Onboarding Hub lists.
  const cohortCount = data
    ? (data.deals || []).filter((d) => (d.stage === "dpa_signed" || d.stage === "live") && d.ods).length
    : 0;

  // greet the signed-in user by first name (falls back to the local "who" value in dev)
  const greetName = auth.user?.email
    ? firstNameFromEmail(auth.user.email)
    : firstNameFromEmail(typeof localStorage !== "undefined" ? localStorage.getItem("pcto.who") : null);

  return (
    <div className="su-app">
      <aside className="su-sidebar">
        <div className="su-brand"><img src={LOGO} alt="Suvera" /></div>
        {greetName && <div className="su-greeting">Hello, {greetName}</div>}
        {data && <div className="su-brand-meta">updated {new Date(data.generated_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</div>}

        <nav className="su-nav">
          <button className={"su-nav-item" + (tab === "overview" ? " active" : "")} onClick={() => selectTab("overview")}>
            Overview{data && <span className="su-navcount">{(data.deals || []).length}</span>}
          </button>
          <button className={"su-nav-item" + (tab === "onboarding" ? " active" : "")} onClick={() => selectTab("onboarding")}>
            Onboarding Hub{data && <span className="su-navcount">{cohortCount}</span>}
          </button>
        </nav>

        {tab === "overview" ? (
          <>
            <div className="su-onpage">
              <div className="su-onpage-title">On this page</div>
              <a href="#funnel">Acquisition funnel</a>
              <a href="#weekly">Week-by-week</a>
              <a href="#revenue">Revenue goal</a>
              <a href="#sources">Lead sources</a>
              <a href="#stalls">Time to go-live & stalls</a>
            </div>
            <div className="su-spacer" />
          </>
        ) : (
          /* the Onboarding Hub portals its "on this page" nav here, so there's one column */
          <div id="su-hubslot" className="su-hubnav" />
        )}
        {auth.user && (
          <div className="su-user">
            <span className="su-user-email">{auth.user.email}</span>
            <button className="su-signout" onClick={auth.signOut}>sign out</button>
          </div>
        )}
      </aside>

      <main className={"su-content" + (tab === "onboarding" ? " hub" : "")}>
        {!data ? (
          <div className="loading">Loading…</div>
        ) : tab === "onboarding" ? (
          <OnboardingHub data={data} visits={visits} auth={auth.user} />
        ) : (
          <FunnelBoard data={data} auth={auth.user} visits={visits} />
        )}
      </main>
    </div>
  );
}
