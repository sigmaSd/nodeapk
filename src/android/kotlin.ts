// Compiles the Kotlin shell (shell/kotlin/) to classes.dex: kotlinc against android.jar, then R8 (shipped
// inside build-tools' d8.jar) with the Kotlin standard library, keeping only what the shell uses
// (shell/r8.pro). The only slow step of a build (the JVM compiler takes seconds), so the dex is
// cached under a hash of the sources and the compiler version: editing the shell rebuilds it, nothing else
// does. kotlinc itself is downloaded once into the cache (a pinned release, checked).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { cacheDir, download, run } from "../run.ts";
import type { Sdk } from "./sdk.ts";

const KOTLIN = "2.4.21";
const KOTLIN_SHA256 = "7cc140e76daf416a0424a5557f99afd7ca89ebd463ea1101261e3e01c33e75cd";
/** The lowest Android the shell runs on (Node is built for API 28, runtime/build.sh). */
export const MIN_SDK = 28;

async function ensureKotlinc(): Promise<string> {
  const dir = join(cacheDir(), "kotlin", KOTLIN);
  const kotlinc = join(dir, "kotlinc", "bin", "kotlinc");
  if (existsSync(kotlinc)) return join(dir, "kotlinc");
  await mkdir(dir, { recursive: true });
  const zip = join(dir, "kotlin-compiler.zip");
  const url = `https://github.com/JetBrains/kotlin/releases/download/v${KOTLIN}/kotlin-compiler-${KOTLIN}.zip`;
  await download(url, zip, KOTLIN_SHA256);
  await run("unzip", ["-q", "-o", zip, "-d", dir]);
  await rm(zip);
  return join(dir, "kotlinc");
}

async function sources(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && e.name.endsWith(".kt"))
    .map((e) => join(e.parentPath, e.name))
    .sort();
}

/** The shell's classes.dex, compiled if its sources changed since the last build. */
export async function ensureShellDex(sdk: Sdk, shellDir: string): Promise<string> {
  const files = await sources(join(shellDir, "kotlin"));
  if (!files.length) throw new Error(`no Kotlin sources in ${shellDir}/kotlin`);
  const hash = createHash("sha256").update(`kotlin ${KOTLIN} min ${MIN_SDK}\n`);
  for (const f of [...files, join(shellDir, "r8.pro")]) hash.update(f.slice(shellDir.length)).update(await readFile(f));
  const out = join(cacheDir(), "dex", hash.digest("hex").slice(0, 16));
  const dex = join(out, "classes.dex");
  if (existsSync(dex)) return dex;

  const kotlinHome = await ensureKotlinc();
  console.error(`compiling the shell (${files.length} Kotlin files)`);
  await mkdir(out, { recursive: true });
  const jar = join(out, "shell.jar");
  // -no-jdk: java.* comes from android.jar, as on the device
  await run(join(kotlinHome, "bin", "kotlinc"), [
    "-no-jdk", "-no-reflect", "-jvm-target", "17", "-classpath", sdk.androidJar, "-d", jar, ...files,
  ]);
  await run("java", [
    "-cp", join(dirname(sdk.d8), "lib", "d8.jar"), "com.android.tools.r8.R8",
    "--release", "--min-api", String(MIN_SDK), "--lib", sdk.androidJar, "--pg-conf", join(shellDir, "r8.pro"),
    "--output", out, jar, join(kotlinHome, "lib", "kotlin-stdlib.jar"),
  ]);
  await rm(jar);
  if (!existsSync(dex)) throw new Error(`R8 produced no ${dex}`);
  return dex;
}
