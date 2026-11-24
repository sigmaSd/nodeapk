import "./_env.ts";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { expect, test } from "vite-plus/test";
import { addToZip, fillManifest, releaseKeyArgs } from "../src/android/apk.ts";

const template = readFileSync(new URL("../shell/AndroidManifest.xml", import.meta.url), "utf8");
const fields = { package: "dev.example.app", label: "A & B", versionName: "1.0", versionCode: "3" };
const raw = { permissions: '<uses-permission android:name="x" />' };

test("manifest: every field of the shell's template is filled, escaped", () => {
  const manifest = fillManifest(template, fields, raw);
  expect(manifest).not.toMatch(/\{\{/);
  expect(manifest).toContain('package="dev.example.app"');
  expect(manifest).toContain('android:label="A &amp; B"');
  expect(manifest).toContain('<uses-permission android:name="x" />');
});

test("manifest: Node can be executed from the native library folder", () => {
  expect(fillManifest(template, fields, raw)).toContain('android:extractNativeLibs="true"');
});

test("manifest: an unknown field is an error, not left in", () => {
  expect(() => fillManifest("{{nope}}", fields)).toThrow(/nope/);
});

test("signing: a release key's passwords are read from the environment, never put on the command line", () => {
  const ks = new URL("../package.json", import.meta.url).pathname; // any existing file stands in
  expect(() => releaseKeyArgs({ keystore: ks }, {})).toThrow(/NODEAPK_KEYSTORE_PASSWORD/);
  const args = releaseKeyArgs({ keystore: ks, alias: "app" }, { NODEAPK_KEYSTORE_PASSWORD: "secret" });
  expect(args).toEqual([
    "--ks",
    ks,
    "--ks-key-alias",
    "app",
    "--ks-pass",
    "env:NODEAPK_KEYSTORE_PASSWORD",
    "--key-pass",
    "env:NODEAPK_KEYSTORE_PASSWORD",
  ]);
  expect(args.join(" ")).not.toContain("secret");
  expect(() => releaseKeyArgs({ keystore: "/nope.keystore" }, { NODEAPK_KEYSTORE_PASSWORD: "x" })).toThrow(
    /not found/,
  );
});

test("zip: the same files give the same bytes, whatever their order on disk, their times or modes", async () => {
  const cache = join(import.meta.dirname, "..", "node_modules", ".cache");
  mkdirSync(cache, { recursive: true });
  const root = mkdtempSync(join(cache, "zip-"));
  const make = (name: string, order: string[], mode: number) => {
    const dir = join(root, name);
    for (const f of order) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), `content of ${f}`, { mode });
    }
    return dir;
  };
  const files = [
    "classes.dex",
    "lib/arm64-v8a/libnode.so",
    "assets/app/b.js",
    "assets/app/a.js",
    "assets/x.json",
  ];
  const one = make("one", files, 0o755);
  await new Promise((r) => setTimeout(r, 1100)); // another second: zip keeps two-second times
  const two = make("two", files.toReversed(), 0o600);
  await addToZip(join(root, "one.zip"), one);
  await addToZip(join(root, "two.zip"), two);
  expect(readFileSync(join(root, "one.zip")).equals(readFileSync(join(root, "two.zip")))).toBe(true);
  const listing = execFileSync("unzip", ["-Z1", join(root, "one.zip")], { encoding: "utf8" })
    .trim()
    .split("\n");
  expect(listing).toEqual([...files].sort()); // sorted, and no directory entries
});
