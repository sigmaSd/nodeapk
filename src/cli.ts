#!/usr/bin/env node
// The nodeapk command:
//
//   nodeapk build [dir] [--out <file.apk>] [--keystore <file> [--key-alias <name>] | --unsigned]
//                 [--runtime <archive|node>] [--install] [--serial <device>]
//   nodeapk keygen <file.keystore> [--name <who signs>]
//
// build: the project in `dir` (default: here), from its package.json `nodeapk` block (src/config.ts); with
// --install, installs it on the phone connected through adb and starts it. Signed with the cache's debug key,
// or with --keystore (its password in NODEAPK_KEYSTORE_PASSWORD: src/android/apk.ts); --unsigned leaves it
// unsigned, for a store that signs it itself or checks it against the published one (F-Droid).
// keygen: a release key, made once and kept (keytool asks for its password).

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { build } from "./build.ts";
import { readConfig } from "./config.ts";
import { run } from "./run.ts";

const USAGE = `usage:
  nodeapk build [dir] [--out <file.apk>] [--keystore <file> [--key-alias <name>] | --unsigned]
                [--runtime <archive|node>] [--install] [--serial <device>]
  nodeapk keygen <file.keystore> [--name <who signs>]

A release key's password goes in NODEAPK_KEYSTORE_PASSWORD (and NODEAPK_KEY_PASSWORD if the key's differs).`;

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      out: { type: "string" },
      runtime: { type: "string" },
      keystore: { type: "string" },
      "key-alias": { type: "string" },
      name: { type: "string" },
      unsigned: { type: "boolean", default: false },
      install: { type: "boolean", default: false },
      serial: { type: "string" },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", short: "v", default: false },
    },
  });
  if (values.version) {
    console.log(pkg.version);
    return;
  }
  const [command, arg] = positionals;
  if (values.help || (command !== "build" && command !== "keygen")) {
    console.log(USAGE);
    process.exitCode = values.help ? 0 : 1;
    return;
  }
  if (command === "keygen") return keygen(arg, values.name);

  if (values.unsigned && (values.keystore || values.install)) {
    throw new Error("--unsigned can't be signed with --keystore, nor installed with --install");
  }
  const app = await readConfig(resolve(arg ?? "."));
  const started = performance.now();
  const apk = await build(app, {
    output: values.out && resolve(values.out),
    runtime: values.runtime,
    signing: values.unsigned
      ? "none"
      : values.keystore
        ? { keystore: resolve(values.keystore), alias: values["key-alias"] }
        : undefined,
  });
  const seconds = ((performance.now() - started) / 1000).toFixed(1);
  console.log(
    `built ${apk} (${app.name} ${app.version}, ${values.unsigned ? "unsigned" : values.keystore ? "release key" : "debug key"}) in ${seconds} s`,
  );

  if (values.install) {
    const adb = (...args: string[]) => run("adb", values.serial ? ["-s", values.serial, ...args] : args);
    await adb("install", "-r", apk);
    await adb("shell", "am", "start", "-n", `${app.id}/dev.nodeapk.shell.MainActivity`);
    console.log(`installed and started; its output: adb logcat -s nodeapk`);
  }
}

/** A release keystore (PKCS12, one key "nodeapk", 30 years); keytool asks for the password on the terminal. */
async function keygen(file: string | undefined, name = "nodeapk app"): Promise<void> {
  if (!file) throw new Error("usage: nodeapk keygen <file.keystore> [--name <who signs>]");
  if (existsSync(file)) throw new Error(`${file} exists: a key can't be replaced without losing app updates`);
  const args = ["-genkeypair", "-keystore", file, "-alias", "nodeapk", "-keyalg", "RSA", "-keysize", "4096"];
  args.push("-validity", "10950", "-dname", `CN=${name.replace(/[,=+<>#;"\\]/g, " ")}`);
  const code = await new Promise<number | null>((done, fail) => {
    spawn("keytool", args, { stdio: "inherit" }).on("error", fail).on("close", done);
  });
  if (code !== 0) throw new Error(`keytool exited with ${code}`);
  console.log(`\n${file}: keep it (and its password) safe and backed up. Every update must be signed with it:
  NODEAPK_KEYSTORE_PASSWORD=… nodeapk build --keystore ${file}`);
}

main().catch((e: unknown) => {
  console.error(`nodeapk: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
