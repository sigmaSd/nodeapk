// Running the build tools (aapt2, kotlinc, d8, zip, apksigner…) and failing loudly with what they printed.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface RunOptions {
  cwd?: string;
  env?: Record<string, string>; // added to this process's own
  stdin?: string; // written, then closed
}

/** Run `cmd` to its end and return its stdout; throws with its output when it exits non-zero. */
export function run(cmd: string, args: string[], opts: RunOptions = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout!.on("data", (b: Buffer) => out.push(b));
    child.stderr!.on("data", (b: Buffer) => err.push(b));
    child.on("error", reject);
    child.on("close", (code) => {
      const stdout = Buffer.concat(out).toString();
      if (code === 0) return resolve(stdout);
      const name = cmd.split("/").at(-1);
      reject(
        new Error(
          `${name} ${args.slice(0, 3).join(" ")}… exited with ${code ?? "a signal"}\n${stdout}${Buffer.concat(err).toString()}`,
        ),
      );
    });
    if (opts.stdin !== undefined) child.stdin!.end(opts.stdin);
  });
}

/** nodeapk's cache: the Android SDK, kotlinc, compiled shells, the debug key ($XDG_CACHE_HOME/nodeapk). */
export function cacheDir(): string {
  return join(process.env.XDG_CACHE_HOME ?? join(homedir(), ".cache"), "nodeapk");
}

/** Download `url` to `dest`, checking its SHA-256 when one is given. */
export async function download(url: string, dest: string, sha256?: string): Promise<void> {
  console.error(`  downloading ${url.split("/").at(-1)}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: ${res.status} ${url}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (sha256 && actual !== sha256) throw new Error(`${url}: SHA-256 ${actual}, expected ${sha256}`);
  await writeFile(`${dest}.part`, bytes);
  await rename(`${dest}.part`, dest);
}
