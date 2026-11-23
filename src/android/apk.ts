// Packs an APK: the shell's manifest (filled per app) and resources linked by aapt2, then the dex, Node
// (lib/<abi>/libnode.so) and the app's files (assets/app/) added to the zip, aligned and debug-signed.
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
  entry: string; // the file Node runs, relative to appDir
  output: string;
}

/** The shell's manifest template with its {{field}}s filled in (XML-escaped); an unknown field throws. */
export function fillManifest(template: string, fields: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in fields)) throw new Error(`unknown manifest field {{${k}}}`);
    return xml(fields[k]!);
  });
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Build, align and sign the APK at `opts.output`. */
export async function buildApk(opts: ApkOptions): Promise<string> {
  const { sdk } = opts;
  if (!existsSync(join(opts.appDir, opts.entry))) throw new Error(`entry ${opts.entry} not found in ${opts.appDir}`);
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
    await writeFile(join(work, "AndroidManifest.xml"), fillManifest(template, fields));

    const base = join(work, "base.apk");
    await run(sdk.aapt2, ["compile", "--dir", join(opts.shellDir, "res"), "-o", join(work, "res.zip")]);
    await run(sdk.aapt2, [
      "link", "-o", base, "-I", sdk.androidJar, "--manifest", join(work, "AndroidManifest.xml"), join(work, "res.zip"),
    ]);

    const stage = join(work, "stage");
    await mkdir(stage);
    await cp(dex, join(stage, "classes.dex"));
    for (const [abi, file] of Object.entries(opts.node)) {
      await mkdir(join(stage, "lib", abi), { recursive: true });
      await cp(file, join(stage, "lib", abi, "libnode.so"));
    }
    await cp(opts.appDir, join(stage, "assets", "app"), { recursive: true });
    await writeFile(join(stage, "assets", "app", ".entry"), opts.entry);
    // -X: no extra fields (they fight zipalign)
    await run("zip", ["-q", "-X", "-r", base, "classes.dex", "lib", "assets"], { cwd: stage });

    await mkdir(dirname(opts.output), { recursive: true });
    // align first (-p: page-align the .so), then sign: signing preserves alignment, the reverse breaks the signature
    await run(sdk.zipalign, ["-f", "-p", "4", base, opts.output]);
    const key = await debugKeystore();
    await run(sdk.apksigner, [
      "sign", "--ks", key, "--ks-key-alias", KEY_ALIAS, "--ks-pass", `pass:${KEY_PASS}`, "--key-pass", `pass:${KEY_PASS}`,
      "--v2-signing-enabled", "true", "--v3-signing-enabled", "true", opts.output,
    ]);
    return opts.output;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

const KEY_ALIAS = "nodeapkdebug";
const KEY_PASS = "android";

async function debugKeystore(): Promise<string> {
  const path = join(cacheDir(), "debug.keystore");
  if (existsSync(path)) return path;
  console.error(`generating a debug signing key in ${path}`);
  await run("keytool", [
    "-genkeypair", "-keystore", path, "-alias", KEY_ALIAS, "-storepass", KEY_PASS, "-keypass", KEY_PASS,
    "-keyalg", "RSA", "-keysize", "2048", "-validity", "10950", "-dname", "CN=nodeapk debug, O=nodeapk",
  ]);
  return path;
}
