# nodeapk: the first milestone

A new npm package that packages a Node app serving its own UI as an Android APK: Node runs on the phone as
a separate process, a WebView shows its local server ("Electron for Android", minus Electron).

Decided so far (in the Tandem session, November 2026):
- Published on **npm** (not JSR): `npx nodeapk build .`.
- The Android shell in **Kotlin**, built without Gradle or Android Studio (`kotlinc`, `d8`, `aapt2`,
  apksigner), the way `~/dev/deno/denoapk` builds its Java shell. Read denoapk for the plumbing (SDK bootstrap
  into a cache, dex caching, `aapt2` from a generated manifest, debug keystore); copy ideas, not a dependency.
- nodejs-mobile is ruled out (unmaintained). denoapk can't carry a backend (no runtime on the device).
- Toolchain and style: the `node-ts-stack` skill (Node 24, TypeScript, Vite+ `vp`, pnpm). Heavy commands
  capped (`systemd-run --user --scope --quiet -p MemoryMax=3G -p MemorySwapMax=0 …`); temporary files in
  `~/dev/tmp`, never `/tmp`.

## Milestone 1: de-risk before building the CLI

1. **Node 24 for Android arm64** (x86_64 for the emulator if cheap): Node's own Android build path
   (`android-configure`, experimental, no official binaries), Termux's Node package and patches as a guide,
   any maintained android-arm64 builds. Self-contained (Node's bundled OpenSSL, ICU, zlib), built by a GitHub
   Actions workflow with the NDK, published as release files.
2. **A hand-made APK proving the model**: Kotlin shell shipping Node as `lib/arm64-v8a/libnode.so` with
   `android:extractNativeLibs="true"` (Android 10+ executes only from the native library folder); starts it
   on a ~10-line `node:http` server with `HOME`, `TMPDIR`, `NODEAPK_DATA`, `NODEAPK_CACHE` set; waits for a
   ready line on stdout (`nodeapk: http://127.0.0.1:PORT/`); loads it in a WebView (cleartext to 127.0.0.1
   allowed); stops Node with the activity; shows the error if Node dies.
3. **On the phone** (`adb`; `~/dev/adb-wifi` for wireless): the page shows. Probe `node:sqlite`,
   `node:crypto` (X25519, scrypt), `node:dgram` broadcast, `fs.watch`, `os.networkInterfaces()` (maybe
   restricted on newer Android), `dns.lookup`.

Done: a README saying what works and what doesn't (with the probe results), the Node build reproducible from
the repo, the demo APK built by a script. Nothing published to npm or GitHub without asking.

## Later (the design)

- `package.json` `nodeapk` block: name, id, icon, one bundled entry file.
- App contract: listen on 127.0.0.1, print one ready line, use the `NODEAPK_*` env, no native `.node`
  addons (the build refuses them).
- Runtime `libnode.so` downloaded from release files and cached.
- Optional per app: foreground service, multicast lock, "All files access".
- First real app: Tandem (`~/dev/tandem`), whose core uses only `node:*` and web standards.
