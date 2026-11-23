import "./_env.ts";
import { readFileSync } from "node:fs";
import { expect, test } from "vite-plus/test";
import { fillManifest } from "../src/android/apk.ts";

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
