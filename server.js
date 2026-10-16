// Temporary latency probe: measures network vs. database time from this Render region to Supabase and OpenRouter.
const http = require("http");
const SUPABASE_URL = process.env.SUPABASE_URL;
const KEY = process.env.SUPABASE_PUBLISHABLE_KEY;

async function timed(url, headers = {}) {
  const t0 = performance.now();
  const res = await fetch(url, { headers });
  await res.arrayBuffer();
  const total = performance.now() - t0;
  const upstream = Number(res.headers.get("x-envoy-upstream-service-time"));
  return { status: res.status, total: Math.round(total), server: Number.isFinite(upstream) ? upstream : null };
}
const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, min: s[0], p50: q(0.5), p90: q(0.9), max: s[s.length - 1], avg: Math.round(s.reduce((a, b) => a + b, 0) / s.length) };
};

async function probe(n) {
  const sbHeaders = { apikey: KEY, Authorization: `Bearer ${KEY}` };
  const restUrl = `${SUPABASE_URL}/rest/v1/messages?select=id&limit=1`;
  const first = await timed(restUrl, sbHeaders);
  const warm = [];
  for (let i = 0; i < n; i++) warm.push(await timed(restUrl, sbHeaders));
  const p0 = performance.now();
  const parallel = await Promise.all(Array.from({ length: 6 }, () => timed(restUrl, sbHeaders)));
  const parallelWall = Math.round(performance.now() - p0);
  const s0 = performance.now();
  for (let i = 0; i < 20; i++) await timed(restUrl, sbHeaders);
  const sequential20 = Math.round(performance.now() - s0);
  const orFirst = await timed("https://openrouter.ai/api/v1/models?supported_parameters=__none__");
  const orWarm = [];
  for (let i = 0; i < 5; i++) orWarm.push((await timed("https://openrouter.ai/api/v1/models?supported_parameters=__none__")).total);
  return {
    region: process.env.RENDER_REGION || process.env.PROBE_REGION,
    supabase: {
      first_request_ms: first,
      warm_total_ms: stats(warm.map((r) => r.total)),
      warm_server_ms: stats(warm.map((r) => r.server ?? 0)),
      warm_network_ms: stats(warm.map((r) => r.total - (r.server ?? 0))),
      six_parallel_wall_ms: parallelWall,
      twenty_sequential_wall_ms: sequential20,
    },
    openrouter: { first_ms: orFirst.total, warm_ms: stats(orWarm) },
  };
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (url.pathname !== "/probe") { res.end("ok"); return; }
  try {
    const result = await probe(Math.min(30, Number(url.searchParams.get("n")) || 15));
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(result, null, 2));
  } catch (e) { res.statusCode = 500; res.end(String(e)); }
}).listen(process.env.PORT || 3000);
