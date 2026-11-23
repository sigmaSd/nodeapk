# nodeapk

Package a Node app that serves its own UI as an Android APK: Node runs on the phone as a separate process,
and a WebView shows its local server ("Electron for Android", minus Electron).

```bash
npx @sigmasd/nodeapk build ~/my-app --install
```

Or install it once (`npm install -g @sigmasd/nodeapk`) and run `nodeapk build`. (npm refused the plain name
`nodeapk` as too close to an existing `node-apk`.)

Node for Android itself comes from [node-android](https://github.com/sigmaSd/node-android), which builds every
Node 24 release. Milestone 1 (proving the model on a real phone) is done: the results are below. Tandem is
the first real app.

## Use

In the app's package.json:

```jsonc
"nodeapk": {
  "id": "dev.example.app",             // Android package name (required)
  "name": "Example",                   // launcher name (default: productName, then name)
  "icon": "app/icon.png",              // a PNG (default: nodeapk's)
  "entry": "dist/android.mjs",         // the file Node runs
  "files": ["app/ui/dist"],            // shipped too, at the same paths relative to the project
  "permissions": ["multicast", "all-files"]   // optional
}
```

```bash
npx @sigmasd/nodeapk build [dir] [--install] [--serial <device>] [--out <file.apk>] [--runtime <node-android archive>]
```

The APK goes to `<dir>/dist/<id>.apk`. Needs Node 24.11+, a JDK (17+), `zip`, `unzip` and `tar`, and `adb`
for `--install`. The first build downloads the Android SDK's build tools and Node for Android (~250 MB, a few
minutes) into `~/.cache/nodeapk`; later builds take seconds. An `$ANDROID_HOME` with build-tools 35.0.0 and
platform android-35 is used instead when there is one.

APKs are signed with a debug key made in that cache: fine for installing yourself, not for a store. A new
cache (another machine) means a new key, and Android then refuses to update the app over the old one:
uninstall it first.

**The app contract**: listen on 127.0.0.1 (any port), print one line `nodeapk: http://127.0.0.1:PORT/…` on
stdout once ready (a path and query may follow: Tandem passes its secret), keep data in `NODEAPK_DATA` and
caches in `NODEAPK_CACHE`, no native `.node` addons (the build refuses them). Everything shipped keeps its
project-relative path, so an entry that finds its files with `import.meta.dirname` finds them on the phone.

The shell also sets `HOME`, `TMPDIR`, `NODEAPK_VERSION` (the app's version), `NODEAPK_PACKAGE`, `LANG` (the
phone's language, which `Intl` follows) and `NODEAPK_DNS` (the network's DNS servers, applied with
`dns.setServers()` by a preload so that `dns.resolve*()` works). Permissions:

- `multicast`: the shell holds a Wi-Fi multicast lock while the app is open (broadcast and multicast
  discovery).
- `all-files`: the shell opens Android's "All files access" page on first start, so the app can use
  `/storage/emulated/0/…`.
- `camera`: the page may use the camera (`getUserMedia`); Android asks the user the first time. The WebView
  also has `BarcodeDetector` with `qr_code` (seen on Android 16), so reading QR codes needs no library:
  Tandem pairs this way.

**Asking the shell**: the preload also defines `globalThis.nodeapk` (a request line on stdout, the answer on
Node's stdin):

- `await nodeapk.pickFolder()`: Android's folder picker; the chosen folder as a path
  (`/storage/emulated/0/Documents/X`, an SD card's `/storage/1A2B-3C4D/…`), or `null` if cancelled or not a
  local folder. Reading it needs `all-files`.

## Results (2026-11-23)

**The model works.** On a Xiaomi 2409BRN2CA (Android 16, arm64), the demo APK starts Node 24.22.3 from the
native library folder, Node prints its ready line, the WebView shows the page, and all 17 probes pass
(`dns.resolve4` since the shell passes the DNS servers).

**Tandem runs too**: `nodeapk build ~/dev/tandem` (an Android entry in its `shell/android/main.ts`), window
up in 1.6 s, All files access granted from the page the shell opens. "Browse…" opens Android's folder picker
(`nodeapk.pickFolder()`), and the phone paired with the desktop by scanning the QR code it shows. Not yet
tried: an actual sync.

| Probe | Result |
| --- | --- |
| `node:sqlite` | ✓ SQLite 3.54.1, database in `NODEAPK_DATA`, persists across launches |
| `crypto` X25519 (`diffieHellman`) | ✓ (OpenSSL 3.5.9) |
| WebCrypto X25519 `deriveBits`, Ed25519 sign/verify | ✓ |
| `crypto.scrypt` N=2^15 r=8 | ✓ ~200 ms (desktop: 73 ms; OpenSSL is built without assembly) |
| `os.networkInterfaces()` | ✓ `wlan0` IPv4/IPv6, `lo`; MAC addresses are all zeros (Android hides them) |
| `node:dgram` broadcast | ✓ sent to 255.255.255.255 and the subnet broadcast, received back (no multicast lock needed for this) |
| `fs.watch` | ✓ events within the app's folders |
| `dns.lookup` | ✓ (the system resolver) |
| `dns.resolve4` (c-ares) | ✓ once the shell passes the network's DNS servers; without them `ECONNREFUSED` (no `/etc/resolv.conf`, so c-ares tries 127.0.0.1) |
| `fetch` over HTTPS | ✓ (Node's bundled CA certificates) |
| `child_process` | ✓ `/system/bin/sh` runs, as the app's uid |
| `worker_threads` | ✓ |
| `Intl` (full ICU) | ✓ ICU 78.3, all locales, the phone's time zone |
| `zlib` gzip/brotli | ✓ |
| `os` | ✓ memory, `homedir`, `tmpdir`, `loadavg`, uid; `os.cpus()` returns `[]` (`/proc/stat` is closed to apps) |
| TypeScript entry | ✓ the demo runs `server.ts` as is (type stripping) |

Lifecycle, checked on the phone:

- **Start**: 0.77 s from launch to page when the app's files are already copied, 1.0–1.4 s on the first
  launch after an install. Bare `node -e 0` takes 0.25 s; type-stripping a `.ts` file adds ~0.2 s; the rest
  is loading built-in modules, compiled at startup (a cross-build has no startup snapshot or code cache).
- **Back**: the activity sends SIGTERM; Node exits (143) within ~60 ms and is gone from `ps`.
- **Force-stop**: the app process and Node both disappear.
- **Node crashes**: the app shows "Node exited with code 1." and Node's last output, scrolled to the
  stack trace (`/api/crash` in the demo, called through `adb forward`).
- **Memory**: Node's RSS is ~90 MiB with the demo loaded.
- **APK**: 34 MB (Node is 93 MB uncompressed; the Kotlin shell's dex is 32 KB after R8).

What this means for the design:

- **In the background, Node is frozen with the app.** Node lives in the app's cgroup, so Android's
  cached-app freezer, and on this phone Xiaomi's GreezeManager (seen freezing the app's uid 1.4 s after it
  went to the background), suspend it too. An app that must keep serving or syncing in the background needs
  the optional foreground service. A server that only serves its own window is fine: it resumes with it.
- **Timeouts can't count wall time.** The shell first treated "no ready line within 30 s" as fatal; the timer
  ran out during a freeze and the page never loaded. It now only shows a note, and a late ready line still
  loads the page.
- **`dns.resolve*()` needs servers**: c-ares has none on Android. The shell now passes the network's
  (`LinkProperties.getDnsServers()`) and a preload applies them; they're read once, at start.
- **Startup**: a bundled `.js` entry avoids the type-stripping cost; a startup snapshot (generated on a
  device or under emulation) would cut the rest, a node-android improvement.
- Not tested yet: x64 (the emulator segfaults on this machine), `node:dgram` multicast, a non-English
  phone (`LANG` → `Intl`).

## How it works

```
APK
├── classes.dex               the Kotlin shell (shell/kotlin/), ~30 KB after R8
├── lib/arm64-v8a/libnode.so  Node 24, a normal PIE executable named like a library
├── assets/app/               the app's entry and files, at their project paths
├── assets/nodeapk.json       the entry and the shell's options (multicast lock, all files)
└── res/, AndroidManifest.xml
```

1. Android 10+ won't execute files from an app's data folder, but the native library folder is executable.
   The package manager only extracts `lib*.so` files there, and only with `android:extractNativeLibs="true"`.
   So Node ships as `lib/<abi>/libnode.so` and runs from `applicationInfo.nativeLibraryDir`.
2. On start, the shell copies `assets/app/` to `files/app/` (once per APK install or update) and starts
   `libnode.so --import <preload> files/app/<entry>` in `files/app/`, with the environment described in
   Use (`NODEAPK_DATA` is `files/data`, `NODEAPK_CACHE` is `cache/node`).
3. The app listens on 127.0.0.1 and prints `nodeapk: http://127.0.0.1:PORT/`. The shell loads that URL in a
   WebView; until the page has loaded it shows the app's icon, centred, as Android apps do. Cleartext HTTP is allowed to 127.0.0.1 only (`res/xml/network_security_config.xml`).
4. If Node exits, the WebView is replaced by the exit code and the last 60 lines Node printed (a slow start
   only gets a note: see Results). All of Node's output also goes to logcat (`adb logcat -s nodeapk`).
5. Closing the activity stops Node (SIGTERM, then SIGKILL after 1 s).

## Layout

```
shell/                      the Kotlin shell: AndroidManifest.xml (template), kotlin/, res/, r8.pro
src/cli.ts, build.ts         `nodeapk build`; config.ts reads the package.json block
src/android/                SDK bootstrap, kotlinc + R8 → dex (cached), Node from node-android (cached),
                            aapt2 + zip + zipalign + apksigner
demo/                       the demo app (its own package.json): server.ts and probes.ts
```

## Node for Android

Node itself is built in its own repository, [sigmaSd/node-android](https://github.com/sigmaSd/node-android):
a GitHub workflow builds every new Node 24 release for arm64 and x64 and publishes it there. nodeapk
downloads the pinned release (`src/android/runtime.ts`) and checks its SHA-256.

## Working on nodeapk

The demo APK (downloads the SDK build tools, kotlinc and Node into `~/.cache/nodeapk` on first use):

```bash
node src/cli.ts build demo            # → demo/dist/dev.nodeapk.demo.apk
node src/cli.ts build demo --install  # and adb install + start it
node src/cli.ts build demo --runtime ../node-android/out/node-v24.22.3-android-arm64.tar.xz   # a local Node build
```

`npm pack` (and publishing) runs `prepack`: `vp pack` bundles the CLI into `dist/cli.mjs` (Node won't strip
types inside `node_modules`), and `tools/prebuild-dex.ts` compiles the shell into `shell/classes.dex`, shipped
with the key of its sources, so users never need the Kotlin compiler. From the checkout, `node src/cli.ts`
compiles the shell itself when its sources change (kotlinc is downloaded once).

## Releasing

GitHub publishes to npm (`.github/workflows/publish.yml`, npm's trusted publishing: no token, no 2FA prompt,
with provenance): bump `version` in package.json, commit, then

```bash
git tag v0.1.1 && git push origin master v0.1.1
```

The workflow checks the tag matches package.json, runs `vp check` and `vp test`, and publishes.
