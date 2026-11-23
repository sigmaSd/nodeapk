// An app's nodeapk settings: the `nodeapk` block of its package.json, checked and completed with defaults.
//
//   "nodeapk": {
//     "id": "dev.example.app",           Android package name (required)
//     "name": "Example",                 launcher name (default: productName, then name)
//     "icon": "app/icon.png",            launcher icon, a PNG (default: nodeapk's)
//     "entry": "dist/android.mjs",       the file Node runs, ideally one bundled file
//     "files": ["app/ui/dist"],          shipped too, at the same paths relative to the project
//     "permissions": ["multicast"]       optional: "multicast", "all-files"
//   }
//
// Everything is shipped at its path relative to the project, so an entry that finds its files with
// import.meta.dirname finds them on the phone too.

import { readFile } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";

/** What an app may ask for beyond the network: the manifest lines each adds (the shell does the rest). */
export const PERMISSIONS = {
  // receive broadcasts and multicast reliably: the shell holds a Wi-Fi multicast lock while the app is open
  multicast: ['<uses-permission android:name="android.permission.CHANGE_WIFI_MULTICAST_STATE" />'],
  // read and write the shared storage (/storage/emulated/0/…): the shell asks once for "All files access"
  // (Android 11+), or for the storage permission before that
  "all-files": [
    '<uses-permission android:name="android.permission.MANAGE_EXTERNAL_STORAGE" />',
    '<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" android:maxSdkVersion="29" />',
  ],
} as const;
export type Permission = keyof typeof PERMISSIONS;

export interface AppConfig {
  dir: string;
  id: string;
  name: string;
  version: string;
  versionCode: number;
  icon?: string; // absolute
  entry: string; // relative to dir
  files: string[]; // relative to dir
  permissions: Permission[];
}

const ID = /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/;

/** A project-relative path that stays inside the project. */
function inside(field: string, value: unknown): string {
  if (typeof value !== "string" || !value) throw new Error(`nodeapk.${field} must be a path`);
  const path = normalize(value).replace(/\/+$/, "");
  if (isAbsolute(path) || path === ".." || path.startsWith("../")) {
    throw new Error(`nodeapk.${field}: ${value} is outside the project`);
  }
  return path;
}

/** Android's versionCode from a semver version: 1.2.3 → 10203 (each part below 100). */
export function versionCode(version: string): number {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  if (!m) throw new Error(`version ${version} is not x.y.z`);
  const [major, minor, patch] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (minor > 99 || patch > 99) throw new Error(`version ${version}: minor and patch must be below 100`);
  return Math.max(1, major * 10000 + minor * 100 + patch);
}

/** The settings from a parsed package.json in `dir`; throws with what to fix. */
export function parseConfig(dir: string, pkg: Record<string, unknown>): AppConfig {
  const block = pkg.nodeapk as Record<string, unknown> | undefined;
  if (!block || typeof block !== "object") throw new Error(`${dir}/package.json has no "nodeapk" block`);
  const id = block.id;
  if (typeof id !== "string" || !ID.test(id)) {
    throw new Error(
      `nodeapk.id must be an Android package name like "dev.example.app" (got ${JSON.stringify(id)})`,
    );
  }
  const name = block.name ?? pkg.productName ?? pkg.name;
  if (typeof name !== "string" || !name) throw new Error("nodeapk.name (or package.json name) is missing");
  const version = typeof pkg.version === "string" ? pkg.version : "0.0.0";
  const files = block.files ?? [];
  if (!Array.isArray(files)) throw new Error("nodeapk.files must be a list of paths");
  const permissions = block.permissions ?? [];
  if (!Array.isArray(permissions)) throw new Error("nodeapk.permissions must be a list");
  for (const p of permissions) {
    if (!(p in PERMISSIONS)) {
      throw new Error(`nodeapk.permissions: unknown "${p}" (known: ${Object.keys(PERMISSIONS).join(", ")})`);
    }
  }
  return {
    dir,
    id,
    name,
    version,
    versionCode: versionCode(version),
    icon: block.icon === undefined ? undefined : join(dir, inside("icon", block.icon)),
    entry: inside("entry", block.entry),
    files: files.map((f, i) => inside(`files[${i}]`, f)),
    permissions: permissions as Permission[],
  };
}

/** Read `dir`/package.json's settings. */
export async function readConfig(dir: string): Promise<AppConfig> {
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8")) as Record<string, unknown>;
  return parseConfig(dir, pkg);
}
