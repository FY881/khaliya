import { audit } from "../audit";
import type { Env } from "../env";
import { Governor } from "../governor/governor";
import { retireFlaky } from "./ladder";

/** Cheap eval upkeep (no LLM calls): retire items whose verdicts flip across reruns. Skipped under the global kill switch. */
export async function evalMaintenance(env: Env): Promise<{ skipped?: string; retired?: number; scanned?: number; error?: string }> {
  try {
    if ((await new Governor(env).isKilled()).killed) {
      await audit(env.DB, "system", "maintenance.eval.skipped", null, { reason: "kill_global" });
      return { skipped: "kill_global" };
    }
    const r = await retireFlaky(env);
    await audit(env.DB, "system", "maintenance.eval", null, { retired: r.retired, scanned: r.scanned });
    return { retired: r.retired.length, scanned: r.scanned };
  } catch (e) {
    const error = String((e as Error)?.message ?? e).slice(0, 300);
    console.error("eval maintenance failed", error);
    try {
      await audit(env.DB, "system", "maintenance.eval.error", null, { error });
    } catch {}
    return { error };
  }
}
