import "./_env.ts";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, test } from "vite-plus/test";
import { stageApp } from "../src/build.ts";
import { parseConfig } from "../src/config.ts";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
async function tmp(): Promise<string> {
  const base = process.env.NODEAPK_DATA!;
  await mkdir(base, { recursive: true });
  const d = await mkdtemp(join(base, "stage-"));
  dirs.push(d);
  return d;
}
async function project(files: Record<string, string>): Promise<string> {
  const dir = await tmp();
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  return dir;
}
const config = (dir: string, files: string[]) =>
  parseConfig(dir, {
    name: "x",
    version: "1.0.0",
    nodeapk: { id: "dev.x.y", entry: "dist/main.mjs", files },
  });

test("build: the entry and files keep their paths, nothing else is shipped", async () => {
  const dir = await project({ "dist/main.mjs": "", "app/ui/dist/index.html": "", "src/secret.ts": "" });
  const stage = await tmp();
  await stageApp(config(dir, ["app/ui/dist"]), stage);
  expect(existsSync(join(stage, "dist/main.mjs"))).toBe(true);
  expect(existsSync(join(stage, "app/ui/dist/index.html"))).toBe(true);
  expect(existsSync(join(stage, "src"))).toBe(false);
});

test("build: a missing entry says to build the app first", async () => {
  const dir = await project({});
  await expect(stageApp(config(dir, []), await tmp())).rejects.toThrow(/build the app first/);
});

test("build: native addons are refused", async () => {
  const dir = await project({ "dist/main.mjs": "", "dist/lib/sqlite.node": "" });
  await expect(stageApp(config(dir, ["dist/lib"]), await tmp())).rejects.toThrow(
    /native addons.*sqlite\.node/,
  );
});
