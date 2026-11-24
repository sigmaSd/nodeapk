// `nodeapk build`: from a project's package.json `nodeapk` block (src/config.ts) to a signed APK.
//
// The entry and `files` are copied at their project-relative paths into a staging folder, which becomes the
// APK's assets/app/. Native addons (.node files) are refused: Node runs as a plain executable on the phone and
// an addon built for the desktop can't load there (and nobody builds them for Android).

import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { buildApk, type Signing } from "./android/apk.ts";
import { ensureNode } from "./android/runtime.ts";
import { ensureSdk } from "./android/sdk.ts";
import { type AppConfig, PERMISSIONS } from "./config.ts";
import { cacheDir } from "./run.ts";

/** nodeapk's own folder (shell/ lives there). */
const home = new URL("..", import.meta.url).pathname;

export interface BuildOptions {
  output?: string; // default: <project>/dist/<id>.apk
  runtime?: string; // a local node-android archive or executable instead of the release
  signing?: Signing | "none"; // a release key, or none (default: the cache's debug key)
}

/** Every .node file under `dir` (relative paths). */
export async function nativeAddons(dir: string): Promise<string[]> {
  if (!(await stat(dir)).isDirectory()) return dir.endsWith(".node") ? [dir] : [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries.filter((e) => e.isFile() && e.name.endsWith(".node")).map((e) => join(e.parentPath, e.name));
}

/** Copy the entry and `files` into `stage`, keeping their paths; throws on a missing path or an addon. */
export async function stageApp(app: AppConfig, stage: string): Promise<void> {
  for (const rel of [app.entry, ...app.files]) {
    const from = join(app.dir, rel);
    if (!existsSync(from)) {
      const hint = rel === app.entry ? " (build the app first?)" : "";
      throw new Error(`${rel} not found in ${app.dir}${hint}`);
    }
    const addons = await nativeAddons(from);
    if (addons.length) {
      throw new Error(
        `native addons can't run on Android: ${addons.map((a) => a.slice(app.dir.length + 1)).join(", ")}`,
      );
    }
    await mkdir(dirname(join(stage, rel)), { recursive: true });
    await cp(from, join(stage, rel), { recursive: true });
  }
}

/** Build `app` into a signed APK; returns its path. */
export async function build(app: AppConfig, opts: BuildOptions = {}): Promise<string> {
  const sdk = await ensureSdk();
  const node = await ensureNode("arm64", opts.runtime);
  await mkdir(cacheDir(), { recursive: true });
  const stage = await mkdtemp(join(cacheDir(), "app-"));
  try {
    await stageApp(app, stage);
    return await buildApk({
      sdk,
      shellDir: join(home, "shell"),
      packageName: app.id,
      label: app.name,
      versionName: app.version,
      versionCode: app.versionCode,
      node: { "arm64-v8a": node },
      appDir: stage,
      runtime: {
        entry: app.entry,
        multicastLock: app.permissions.includes("multicast"),
        allFiles: app.permissions.includes("all-files"),
        camera: app.permissions.includes("camera"),
      },
      permissions: app.permissions.flatMap((p) => PERMISSIONS[p]),
      icon: app.icon,
      signing: opts.signing,
      output: opts.output ?? join(app.dir, "dist", `${app.id}.apk`),
    });
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
