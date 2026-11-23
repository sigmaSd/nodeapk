import "./_env.ts";
import { expect, test } from "vite-plus/test";
import { runProbes } from "../demo/probes.ts";

test("probes: all pass on the desktop, except the Android-only shell and the network", async () => {
  const results = await runProbes();
  const allowed = new Set([
    "child_process",
    "fetch https",
    "dns.lookup",
    "dns.resolve4 (c-ares)",
    "dgram broadcast",
  ]);
  const failed = results.filter((r) => !r.ok && !allowed.has(r.name));
  expect(failed).toEqual([]);
}, 60_000);
