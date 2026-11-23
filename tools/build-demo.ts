// Builds the demo APK (demo/: a node:http server and the probes) → dist/nodeapk-demo.apk, and with
// --install puts it on the connected phone (adb) and starts it.
//
//   node tools/build-demo.ts [--runtime <node-…-android-arm64.tar.xz | node executable>] [--install]
//
// Node comes from a node-android release (src/android/runtime.ts) unless --runtime points at a local build.
// This is milestone 1's hand-made APK; the `nodeapk build` CLI will grow from src/android/.

import { join } from "node:path";
import { parseArgs } from "node:util";
import { buildApk } from "../src/android/apk.ts";
import { ensureNode } from "../src/android/runtime.ts";
import { ensureSdk } from "../src/android/sdk.ts";
import { run } from "../src/run.ts";

const root = new URL("..", import.meta.url).pathname;
const PACKAGE = "dev.nodeapk.demo";
const { values } = parseArgs({
  options: {
    runtime: { type: "string" },
    install: { type: "boolean", default: false },
  },
});

const sdk = await ensureSdk();
const output = join(root, "dist/nodeapk-demo.apk");
const t = performance.now();
await buildApk({
  sdk,
  shellDir: join(root, "shell"),
  packageName: PACKAGE,
  label: "nodeapk demo",
  versionName: "0.1.0",
  versionCode: 1,
  node: { "arm64-v8a": await ensureNode("arm64", values.runtime) },
  appDir: join(root, "demo"),
  entry: "server.ts",
  output,
});
console.log(`built ${output} in ${Math.round(performance.now() - t)} ms`);

if (values.install) {
  await run("adb", ["install", "-r", output]);
  await run("adb", ["shell", "am", "start", "-W", "-n", `${PACKAGE}/dev.nodeapk.shell.MainActivity`]);
  console.log(`installed and started; logs: adb logcat -s nodeapk`);
}
