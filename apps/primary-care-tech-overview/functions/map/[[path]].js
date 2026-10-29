// ops.suvera.com/map/* -> the growth map, which lives in its own Cloudflare Pages
// project (growth-map) so it can redeploy straight after each ~5-min data refresh
// (refresh-waitlist.yml) instead of waiting on this app's slower deploy. The map
// is built with base /map/, so its files sit at the root of that project.
const ORIGIN = "https://growth-map.pages.dev";

export async function onRequest({ request }) {
  const url = new URL(request.url);
  if (url.pathname === "/map") return Response.redirect(`${url.origin}/map/${url.search}`, 301);
  const upstream = new URL(url.pathname.replace(/^\/map/, "") + url.search, ORIGIN);
  const resp = await fetch(upstream, { method: request.method, headers: request.headers, redirect: "manual" });
  const out = new Response(resp.body, resp);
  // keep upstream redirects (e.g. Pages' trailing-slash ones) under /map
  const loc = out.headers.get("location");
  if (loc && loc.startsWith("/")) out.headers.set("location", "/map" + loc);
  return out;
}
