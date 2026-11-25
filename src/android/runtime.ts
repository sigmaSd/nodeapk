// The Node that ships in the APK: a release of node-android (https://github.com/sigmaSd/node-android), which
// builds Node for Android on its own for each Node release, downloaded once into the cache and checked
// against its .sha256. A local file can stand in for it (a node-android archive or the executable itself).

import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { cacheDir, download, run } from "../run.ts";

/** The Node version apps get, until the CLI lets them choose. */
export const NODE_VERSION = "24.22.3";
/** The node-android release of it: a "-1" is that version built again (24.22.3-1 rebuilds the same on any disk). */
export const NODE_RELEASE = "v24.22.3-1";
const RELEASES = "https://github.com/sigmaSd/node-android/releases/download";

/** The node executable for `arch`, from `local` if given, else from the node-android release. */
export async function ensureNode(arch: "arm64" | "x64", local?: string): Promise<string> {
  if (local) return local.endsWith(".tar.xz") ? unpack(local, await localDir(local)) : local;
  const name = `node-v${NODE_VERSION}-android-${arch}`;
  const dir = join(cacheDir(), "runtime");
  // per release: an earlier build of the same Node version in the cache isn't taken for this one
  const unpacked = `node-${NODE_RELEASE}-android-${arch}`;
  const exe = join(dir, unpacked, "node");
  if (existsSync(exe)) return exe;
  await mkdir(dir, { recursive: true });
  const archive = join(dir, `${unpacked}.tar.xz`);
  const url = `${RELEASES}/${NODE_RELEASE}/${name}.tar.xz`;
  await download(`${url}.sha256`, `${archive}.sha256`);
  const expected = (await readFile(`${archive}.sha256`, "utf8")).split(/\s/)[0];
  await download(url, archive, expected);
  const found = await unpack(archive, join(dir, unpacked));
  await rm(archive);
  await rm(`${archive}.sha256`);
  return found;
}

/** Where a local archive is unpacked: per file content, so a rebuilt archive is unpacked again. */
async function localDir(archive: string): Promise<string> {
  const hash = createHash("sha256")
    .update(await readFile(archive))
    .digest("hex")
    .slice(0, 12);
  return join(cacheDir(), "runtime", `${basename(archive, ".tar.xz")}-${hash}`);
}

/** Unpack a node-android archive into `dir` (unless already there) and return its executable. */
async function unpack(archive: string, dir: string): Promise<string> {
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
    await run("tar", ["-xJf", archive, "-C", dir, "--strip-components=1"]);
  }
  // node-android's archives hold `node`; the first local builds named it libnode.so
  for (const name of ["node", "libnode.so"]) if (existsSync(join(dir, name))) return join(dir, name);
  throw new Error(`no node executable in ${archive}`);
}
