// Packs an APK: the shell's manifest (filled per app) and resources linked by aapt2, then the dex, Node
// (lib/<abi>/libnode.so), the app's files (assets/app/) and the shell's runtime options
// (assets/nodeapk.json) added to the zip, aligned and debug-signed.
//
// The manifest is generated and compiled, not binary-patched: aapt2 link on a handful of resources takes
// well under a second (denoapk's finding). Signing uses a debug key generated once in the cache — fine for
// sideloading and `adb install`, not for a store.

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cacheDir, run } from "../run.ts";
import { ensureShellDex } from "./kotlin.ts";
import type { Sdk } from "./sdk.ts";

export interface ApkOptions {
  sdk: Sdk;
  shellDir: string; // shell/: AndroidManifest.xml, res/, kotlin/
  packageName: string; // e.g. dev.nodeapk.demo
  label: string; // the launcher name
  versionName: string;
  versionCode: number;
  /** Node per Android ABI, e.g. { "arm64-v8a": ".../libnode.so" }. */
  node: Record<string, string>;
  appDir: string; // copied to assets/app/
  /** What the shell reads at start (assets/nodeapk.json): the entry, relative to appDir, and the options. */
  runtime: { entry: string } & Record<string, unknown>;
  /** Extra manifest lines (<uses-permission …/>). */
  permissions: readonly string[];
  icon?: string; // a PNG, replaces the shell's launcher icon
  /** A release key; without one, the debug key in the cache (a different one on every machine). */
  signing?: Signing;
  output: string;
}

/**
 * A release key: a keystore made once (`nodeapk keygen`) and kept, since Android only updates an app with
 * the key it was installed with. The passwords come from the environment (apksigner reads them there, so
 * they are never on a command line): NODEAPK_KEYSTORE_PASSWORD, and NODEAPK_KEY_PASSWORD when the key's
 * own differs (a PKCS12 keystore, keytool's default, has one password for both).
 */
export interface Signing {
  keystore: string;
  alias?: string; // needed only when the keystore holds several keys
}

/** apksigner's key arguments for a release key. */
export function releaseKeyArgs(signing: Signing, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(signing.keystore)) throw new Error(`keystore ${signing.keystore} not found`);
  if (!env.NODEAPK_KEYSTORE_PASSWORD) {
    throw new Error("set NODEAPK_KEYSTORE_PASSWORD to the keystore's password (--keystore)");
  }
  return [
    "--ks",
    signing.keystore,
    ...(signing.alias ? ["--ks-key-alias", signing.alias] : []),
    "--ks-pass",
    "env:NODEAPK_KEYSTORE_PASSWORD",
    "--key-pass",
    env.NODEAPK_KEY_PASSWORD ? "env:NODEAPK_KEY_PASSWORD" : "env:NODEAPK_KEYSTORE_PASSWORD",
  ];
}

/**
 * The shell's manifest template with its {{field}}s filled in: `fields` XML-escaped, `raw` (manifest lines
 * nodeapk wrote) as is. An unknown field throws.
 */
export function fillManifest(
  template: string,
  fields: Record<string, string>,
  raw: Record<string, string> = {},
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (k in raw) return raw[k]!;
    if (!(k in fields)) throw new Error(`unknown manifest field {{${k}}}`);
    return xml(fields[k]!);
  });
}

const xml = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Build, align and sign the APK at `opts.output`. */
export async function buildApk(opts: ApkOptions): Promise<string> {
  const { sdk } = opts;
  if (!existsSync(join(opts.appDir, opts.runtime.entry))) {
    throw new Error(`entry ${opts.runtime.entry} not found in ${opts.appDir}`);
  }
  if (opts.icon && !(await readFile(opts.icon)).subarray(0, 8).equals(PNG)) {
    throw new Error(`icon ${opts.icon} is not a PNG`);
  }
  const dex = await ensureShellDex(sdk, opts.shellDir);
  await mkdir(cacheDir(), { recursive: true });
  const work = await mkdtemp(join(cacheDir(), "build-"));
  try {
    const fields: Record<string, string> = {
      package: opts.packageName,
      label: opts.label,
      versionName: opts.versionName,
      versionCode: String(opts.versionCode),
    };
    const template = await readFile(join(opts.shellDir, "AndroidManifest.xml"), "utf8");
    const permissions = opts.permissions.map((line) => `    ${line}`).join("\n");
    await writeFile(join(work, "AndroidManifest.xml"), fillManifest(template, fields, { permissions }));

    const res = join(work, "res");
    await cp(join(opts.shellDir, "res"), res, { recursive: true });
    if (opts.icon) await cp(opts.icon, join(res, "mipmap", "ic_launcher.png"));
    const base = join(work, "base.apk");
    await run(sdk.aapt2, ["compile", "--dir", res, "-o", join(work, "res.zip")]);
    await run(sdk.aapt2, [
      "link",
      "-o",
      base,
      "-I",
      sdk.androidJar,
      "--manifest",
      join(work, "AndroidManifest.xml"),
      join(work, "res.zip"),
    ]);

    const stage = join(work, "stage");
    await mkdir(stage);
    await cp(dex, join(stage, "classes.dex"));
    for (const [abi, file] of Object.entries(opts.node)) {
      await mkdir(join(stage, "lib", abi), { recursive: true });
      await cp(file, join(stage, "lib", abi, "libnode.so"));
    }
    await cp(opts.appDir, join(stage, "assets", "app"), { recursive: true });
    await writeFile(join(stage, "assets", "nodeapk.json"), JSON.stringify(opts.runtime));
    // -X: no extra fields (they fight zipalign)
    await run("zip", ["-q", "-X", "-r", base, "classes.dex", "lib", "assets"], { cwd: stage });

    await mkdir(dirname(opts.output), { recursive: true });
    // align first (-p: page-align the .so), then sign: signing preserves alignment, the reverse breaks the signature
    await run(sdk.zipalign, ["-f", "-p", "4", base, opts.output]);
    const keyArgs = opts.signing
      ? releaseKeyArgs(opts.signing)
      : [
          "--ks",
          await debugKeystore(),
          "--ks-key-alias",
          KEY_ALIAS,
          "--ks-pass",
          `pass:${KEY_PASS}`,
          "--key-pass",
          `pass:${KEY_PASS}`,
        ];
    await run(sdk.apksigner, [
      "sign",
      ...keyArgs,
      "--v2-signing-enabled",
      "true",
      "--v3-signing-enabled",
      "true",
      "--v4-signing-enabled",
      "false",
      opts.output,
    ]);
    return opts.output;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const KEY_ALIAS = "nodeapkdebug";
const KEY_PASS = "android";

async function debugKeystore(): Promise<string> {
  const path = join(cacheDir(), "debug.keystore");
  if (existsSync(path)) return path;
  console.error(`generating a debug signing key in ${path}`);
  await run("keytool", [
    "-genkeypair",
    "-keystore",
    path,
    "-alias",
    KEY_ALIAS,
    "-storepass",
    KEY_PASS,
    "-keypass",
    KEY_PASS,
    "-keyalg",
    "RSA",
    "-keysize",
    "2048",
    "-validity",
    "10950",
    "-dname",
    "CN=nodeapk debug, O=nodeapk",
  ]);
  return path;
}
