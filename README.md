# nodeapk

Package a Node app that serves its own UI as an Android APK: Node runs on the phone as a separate process,
and a WebView shows its local server ("Electron for Android", minus Electron).

This is **milestone 1**: de-risking before the `npx nodeapk build .` CLI. It has Node 24 built for Android,
a Kotlin shell, a script building a demo APK, and probe results from a real device. Nothing is published to
npm; Node for Android is published by [node-android](https://github.com/sigmaSd/node-android).

## Results (2026-11-23)

**The model works.** On a Xiaomi 2409BRN2CA (Android 16, arm64), the demo APK starts Node 24.22.3 from the
native library folder, Node prints its ready line, the WebView shows the page, and 16 of 17 probes pass.

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
| `dns.resolve4` (c-ares) | ✗ `ECONNREFUSED`: c-ares finds no DNS servers on Android (no `/etc/resolv.conf`) and tries 127.0.0.1 |
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
- **`dns.resolve*()` needs servers.** Apps should use `dns.lookup` (what `http`, `fetch` and `net` use). A
  later shell could pass the network's DNS servers (`LinkProperties.getDnsServers()`) for `dns.setServers()`.
- **Startup**: a bundled `.js` entry avoids the type-stripping cost; a startup snapshot (generated on a
  device or under emulation) would cut the rest, a node-android improvement.
- Not tested yet: x64 (the emulator segfaults on this machine), `node:dgram` multicast, "All files access".

## How it works

```
APK
├── classes.dex               the Kotlin shell (shell/kotlin/), ~30 KB after R8
├── lib/arm64-v8a/libnode.so  Node 24, a normal PIE executable named like a library
├── assets/app/               the app's files + .entry (the file Node runs)
└── res/, AndroidManifest.xml
```

1. Android 10+ won't execute files from an app's data folder, but the native library folder is executable.
   The package manager only extracts `lib*.so` files there, and only with `android:extractNativeLibs="true"`.
   So Node ships as `lib/<abi>/libnode.so` and runs from `applicationInfo.nativeLibraryDir`.
2. On start, the shell copies `assets/app/` to `files/app/` (once per APK install or update) and starts
   `libnode.so files/app/<entry>` with `HOME`, `TMPDIR`, `NODEAPK_DATA` (`files/data`), `NODEAPK_CACHE`
   (`cache/node`) and `NODEAPK_PACKAGE` set.
3. The app listens on 127.0.0.1 and prints `nodeapk: http://127.0.0.1:PORT/`. The shell loads that URL in a
   WebView. Cleartext HTTP is allowed to 127.0.0.1 only (`res/xml/network_security_config.xml`).
4. If Node exits, the WebView is replaced by the exit code and the last 60 lines Node printed (a slow start
   only gets a note: see Results). All of Node's output also goes to logcat (`adb logcat -s nodeapk`).
5. Closing the activity stops Node (SIGTERM, then SIGKILL after 1 s).

## Layout

```
shell/                      the Kotlin shell: AndroidManifest.xml (template), kotlin/, res/, r8.pro
src/android/                SDK bootstrap, kotlinc + R8 → dex (cached), Node from node-android (cached),
                            aapt2 + zip + zipalign + apksigner
tools/build-demo.ts         builds the demo APK
demo/                       the demo app: server.ts (the contract) and probes.ts
```

## Node for Android

Node itself is built in its own repository, [sigmaSd/node-android](https://github.com/sigmaSd/node-android):
a GitHub workflow builds every new Node 24 release for arm64 and x64 and publishes it there. nodeapk
downloads the pinned release (`src/android/runtime.ts`) and checks its SHA-256.

## Building

The demo APK (downloads the SDK build tools, kotlinc and Node into `~/.cache/nodeapk` on first use):

```bash
node tools/build-demo.ts            # → dist/nodeapk-demo.apk
node tools/build-demo.ts --install  # and adb install + start it
node tools/build-demo.ts --runtime ../node-android/out/node-v24.22.3-android-arm64.tar.xz   # a local build
```

Needs Node 24, a JDK (17+; tested with 25), `zip` and `unzip`.
