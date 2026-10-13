// Production entry used by wrangler.deploy.toml: same Worker, console served from embedded files.
import worker from "./index";
import { FILES } from "./embedded-assets.gen";
import type { Env } from "./env";
export { AgentHome } from "./home/AgentHome";
export { JobRunner } from "./jobs/runner";

const SEC = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};
const embedded = {
  async fetch(req: Request): Promise<Response> {
    const p = new URL(req.url).pathname;
    const f = FILES[p] ?? FILES["/index.html"]; // SPA fallback
    const cache = p === "/" || f === FILES["/index.html"] ? "no-cache" : "public, max-age=300";
    return new Response(f.body, { headers: { "content-type": f.type, "cache-control": cache, ...SEC } });
  },
} as unknown as Fetcher;

export default {
  fetch: (req: Request, env: Env, ctx: ExecutionContext) => worker.fetch(req, { ...env, ASSETS: embedded }, ctx),
  scheduled: worker.scheduled,
  queue: worker.queue,
};
