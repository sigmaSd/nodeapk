import "./_env.ts";
import { expect, test } from "vite-plus/test";
import { parseConfig, versionCode } from "../src/config.ts";

const pkg = (nodeapk: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  name: "example",
  version: "1.2.3",
  nodeapk: { id: "dev.example.app", entry: "dist/main.mjs", ...nodeapk },
  ...extra,
});

test("config: defaults come from package.json", () => {
  const app = parseConfig("/p", pkg({}, { productName: "Example" }));
  expect(app).toMatchObject({ id: "dev.example.app", name: "Example", version: "1.2.3", versionCode: 10203 });
  expect(app).toMatchObject({ entry: "dist/main.mjs", files: [], permissions: [], icon: undefined });
});

test("config: paths are kept relative and inside the project", () => {
  const app = parseConfig("/p", pkg({ files: ["app/ui/dist/", "./locales"], icon: "app/icon.png" }));
  expect(app.files).toEqual(["app/ui/dist", "locales"]);
  expect(app.icon).toBe("/p/app/icon.png");
  expect(() => parseConfig("/p", pkg({ files: ["../secrets"] }))).toThrow(/outside the project/);
  expect(() => parseConfig("/p", pkg({ entry: "/etc/passwd" }))).toThrow(/outside the project/);
});

test("config: a missing block, a bad id or an unknown permission is explained", () => {
  expect(() => parseConfig("/p", { name: "x" })).toThrow(/no "nodeapk" block/);
  expect(() => parseConfig("/p", pkg({ id: "example" }))).toThrow(/Android package name/);
  expect(() => parseConfig("/p", pkg({ permissions: ["contacts"] }))).toThrow(/unknown "contacts"/);
});

test("config: versionCode grows with the version", () => {
  expect(versionCode("0.3.2")).toBe(302);
  expect(versionCode("1.0.0")).toBeGreaterThan(versionCode("0.99.99"));
  expect(versionCode("0.0.0")).toBe(1);
  expect(() => versionCode("1.100.0")).toThrow(/below 100/);
});

test("config: a versionCode written out is used as is, and must be a whole number", () => {
  expect(parseConfig("/p", pkg({ versionCode: 10203 })).versionCode).toBe(10203);
  expect(parseConfig("/p", pkg({ versionCode: 7 })).versionCode).toBe(7);
  expect(() => parseConfig("/p", pkg({ versionCode: "10203" }))).toThrow(/whole number/);
  expect(() => parseConfig("/p", pkg({ versionCode: 0 }))).toThrow(/whole number/);
});
