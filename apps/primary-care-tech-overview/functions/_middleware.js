// Send the old planner-onboarding.pages.dev address to the canonical domain
// (ops.suvera.com), keeping the path and query so bookmarks like ?tab=retention
// still land in the right place. Off until the CANONICAL_HOST secret is set — the
// deploy workflow sets it from the OPS_HOST repo variable once the domain is live.
export async function onRequest({ request, env, next }) {
  const host = (env.CANONICAL_HOST || "").trim();
  const url = new URL(request.url);
  if (host && host !== "off" && url.hostname.endsWith(".pages.dev")) {
    return Response.redirect(`https://${host}${url.pathname}${url.search}${url.hash}`, 301);
  }
  return next();
}
