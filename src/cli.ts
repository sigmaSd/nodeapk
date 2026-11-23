#!/usr/bin/env node
// The nodeapk command:
//
//   nodeapk build [dir] [--out <file.apk>] [--runtime <archive|node>] [--install] [--serial <device>]
//
// Builds the project in `dir` (default: here) from its package.json `nodeapk` block (src/config.ts). With
// --install, installs it on the phone connected through adb and starts it.

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { build } from "./build.ts";
import { readConfig } from "./config.ts";
import { run } from "./run.ts";

const USAGE = `usage: nodeapk build [dir] [--out <file.apk>] [--runtime <archive|node>] [--install] [--serial <device>]`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      runtime: { type: "string" },
      install: { type: "boolean", default: false },
      serial: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [command, dir = "."] = positionals;
  if (values.help || command !== "build") {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }

  const app = await readConfig(resolve(dir));
  const started = performance.now();
  const apk = await build(app, { output: values.out && resolve(values.out), runtime: values.runtime });
  console.log(
    `built ${apk} (${app.name} ${app.version}) in ${((performance.now() - started) / 1000).toFixed(1)} s`,
  );

  if (values.install) {
    const adb = (...args: string[]) => run("adb", values.serial ? ["-s", values.serial, ...args] : args);
    await adb("install", "-r", apk);
    await adb("shell", "am", "start", "-n", `${app.id}/dev.nodeapk.shell.MainActivity`);
    console.log(`installed and started; its output: adb logcat -s nodeapk`);
  }
}

main().catch((e: unknown) => {
  console.error(`nodeapk: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
