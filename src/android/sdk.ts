// The Android SDK pieces nodeapk needs: aapt2 (resources, manifest), d8 (dex), zipalign and apksigner, and
// android.jar to compile against. No Gradle, no Android Studio, no AGP (whose supported-JDK window is narrow;
// this machine runs JDK 25). Same approach as denoapk (~/dev/deno/denoapk/src/sdk.ts).
//
// An SDK at $ANDROID_HOME with these versions is used as is; otherwise the command-line tools are downloaded
// into the cache and sdkmanager fetches the rest. The NDK is only needed to build Node itself
// (runtime/build.sh), never to package an app.

import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { cacheDir, download, run } from "../run.ts";

export const BUILD_TOOLS = "35.0.0";
export const PLATFORM = "android-35";
const CMDLINE_TOOLS_URL =
  "https://dl.google.com/android/repository/commandlinetools-linux-15859902_latest.zip";
const CMDLINE_TOOLS_SHA256 = "4e4c464f145a7512b57d088ac6c278c03c9eea610886b35a5e0804e74eedf583";

export interface Sdk {
  root: string;
  aapt2: string;
  d8: string;
  zipalign: string;
  apksigner: string;
  androidJar: string;
}

function layout(root: string): Sdk {
  const bt = join(root, "build-tools", BUILD_TOOLS);
  return {
    root,
    aapt2: join(bt, "aapt2"),
    d8: join(bt, "d8"),
    zipalign: join(bt, "zipalign"),
    apksigner: join(bt, "apksigner"),
    androidJar: join(root, "platforms", PLATFORM, "android.jar"),
  };
}

const complete = (sdk: Sdk) =>
  [sdk.aapt2, sdk.d8, sdk.zipalign, sdk.apksigner, sdk.androidJar].every((p) => existsSync(p));

/** A usable SDK: $ANDROID_HOME if it has our versions, else the cache's, bootstrapped on first use. */
export async function ensureSdk(): Promise<Sdk> {
  const env = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
  if (env && complete(layout(env))) return layout(env);

  const root = join(cacheDir(), "android-sdk");
  const sdk = layout(root);
  if (complete(sdk)) return sdk;

  console.error(`setting up the Android SDK in ${root}`);
  const sdkmanager = join(root, "cmdline-tools", "latest", "bin", "sdkmanager");
  if (!existsSync(sdkmanager)) {
    await mkdir(root, { recursive: true });
    const zip = join(root, "cmdline-tools.zip");
    await download(CMDLINE_TOOLS_URL, zip, CMDLINE_TOOLS_SHA256);
    const staging = join(root, ".staging");
    await rm(staging, { recursive: true, force: true });
    await run("unzip", ["-q", zip, "-d", staging]);
    // sdkmanager insists on living at cmdline-tools/<channel>/bin/sdkmanager
    await mkdir(join(root, "cmdline-tools"), { recursive: true });
    await rename(join(staging, "cmdline-tools"), join(root, "cmdline-tools", "latest"));
    await rm(staging, { recursive: true });
    await rm(zip);
  }
  await run(sdkmanager, [`--sdk_root=${root}`, "--licenses"], { stdin: "y\n".repeat(20) });
  await run(sdkmanager, [`--sdk_root=${root}`, `build-tools;${BUILD_TOOLS}`, `platforms;${PLATFORM}`]);
  if (!complete(sdk)) throw new Error(`the SDK in ${root} is still incomplete after sdkmanager`);
  return sdk;
}
