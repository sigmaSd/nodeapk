import "./_env.ts";
import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { fillManifest, releaseKeyArgs } from "../src/android/apk.ts";

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
