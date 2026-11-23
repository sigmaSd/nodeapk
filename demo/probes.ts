// What works in Node on Android: each probe exercises one capability an app like Tandem needs and
// reports ok/fail with a detail. Served as JSON by demo/server.ts (/api/probes) and shown by its page;
// also runnable on its own with `node demo/probes.ts` (on the desktop, or on the phone over adb).

import { execFile } from "node:child_process";
import crypto from "node:crypto";
import dgram from "node:dgram";
import dns from "node:dns/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import zlib from "node:zlib";

export interface ProbeResult {
  name: string;
  ok: boolean;
  detail: string;
  ms: number;
}

type Probe = [name: string, run: () => Promise<string> | string];

const dataDir =
  process.env.NODEAPK_DATA ??
  path.join(import.meta.dirname, "..", "node_modules", ".cache", "nodeapk-probes");

const probes: Probe[] = [
  [
    "environment",
    () => {
      const keys = [
        "HOME",
        "TMPDIR",
        "NODEAPK_DATA",
        "NODEAPK_CACHE",
        "NODEAPK_VERSION",
        "NODEAPK_DNS",
        "LANG",
      ];
      return (
        `${process.version} ${process.platform}/${process.arch}, Intl locale ` +
        `${Intl.DateTimeFormat().resolvedOptions().locale}, ` +
        keys.map((k) => `${k}=${process.env[k] ?? "(unset)"}`).join(" ")
      );
    },
  ],
  [
    "node:sqlite",
    () => {
      fs.mkdirSync(dataDir, { recursive: true });
      const db = new DatabaseSync(path.join(dataDir, "probe.db"));
      db.exec("CREATE TABLE IF NOT EXISTS runs (at TEXT)");
      db.prepare("INSERT INTO runs VALUES (?)").run(new Date().toISOString());
      const { n } = db.prepare("SELECT count(*) AS n FROM runs").get() as { n: number };
      const { v } = db.prepare("SELECT sqlite_version() AS v").get() as { v: string };
      db.close();
      return `SQLite ${v}, ${n} run(s) recorded in ${dataDir}/probe.db`;
    },
  ],
  [
    "crypto X25519",
    () => {
      const a = crypto.generateKeyPairSync("x25519");
      const b = crypto.generateKeyPairSync("x25519");
      const s1 = crypto.diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey });
      const s2 = crypto.diffieHellman({ privateKey: b.privateKey, publicKey: a.publicKey });
      if (!s1.equals(s2)) throw new Error("shared secrets differ");
      return `shared secret agreed (${s1.length} bytes), ${process.versions.openssl}`;
    },
  ],
  [
    "webcrypto X25519 + Ed25519",
    async () => {
      const { subtle } = crypto.webcrypto;
      const a = (await subtle.generateKey({ name: "X25519" }, false, [
        "deriveBits",
      ])) as unknown as CryptoKeyPair;
      const b = (await subtle.generateKey({ name: "X25519" }, false, [
        "deriveBits",
      ])) as unknown as CryptoKeyPair;
      const bits = await subtle.deriveBits({ name: "X25519", public: b.publicKey }, a.privateKey, 256);
      const sig = (await subtle.generateKey({ name: "Ed25519" }, false, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair;
      const data = new TextEncoder().encode("hello");
      const signature = await subtle.sign("Ed25519", sig.privateKey, data);
      if (!(await subtle.verify("Ed25519", sig.publicKey, signature, data))) throw new Error("verify failed");
      return `deriveBits ${bits.byteLength} bytes, Ed25519 sign/verify ok`;
    },
  ],
  [
    "crypto scrypt",
    async () => {
      const t = performance.now();
      const key = await new Promise<Buffer>((resolve, reject) =>
        crypto.scrypt("password", "salt", 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) =>
          e ? reject(e) : resolve(k),
        ),
      );
      return `N=2^15 r=8 in ${Math.round(performance.now() - t)} ms → ${key.toString("hex").slice(0, 16)}…`;
    },
  ],
  [
    "os.networkInterfaces()",
    () => {
      const list = Object.entries(os.networkInterfaces()).map(
        ([name, addrs]) =>
          `${name}: ${(addrs ?? []).map((a) => `${a.address}${a.internal ? "" : ` (mac ${a.mac})`}`).join(", ")}`,
      );
      if (list.length === 0) throw new Error("no interfaces returned");
      return list.join("; ");
    },
  ],
  ["dgram broadcast", () => broadcastProbe()],
  ["fs.watch", () => watchProbe()],
  [
    "dns.lookup",
    async () => {
      const r = await dns.lookup("example.com", { all: true });
      return r.map((a) => a.address).join(", ");
    },
  ],
  [
    "dns.resolve4 (c-ares)",
    async () => (await dns.resolve4("example.com")).join(", ") + ` via ${dns.getServers().join(", ")}`,
  ],
  [
    "fetch https",
    async () => {
      const res = await fetch("https://example.com/", { signal: AbortSignal.timeout(8000) });
      return `${res.status} ${res.headers.get("content-type")}, ${(await res.text()).length} bytes`;
    },
  ],
  [
    "child_process",
    () =>
      new Promise((resolve, reject) =>
        execFile("/system/bin/sh", ["-c", "echo $0 from $(id -u)"], (e, out) =>
          e ? reject(e) : resolve(out.trim()),
        ),
      ),
  ],
  [
    "worker_threads",
    () =>
      new Promise((resolve, reject) => {
        const w = new Worker("require('node:worker_threads').parentPort.postMessage(6 * 7)", { eval: true });
        w.once("message", (m) => {
          resolve(`worker answered ${m}`);
          void w.terminate();
        });
        w.once("error", reject);
      }),
  ],
  [
    "Intl (full ICU)",
    () => {
      const d = new Date(Date.UTC(2026, 10, 23));
      const fr = new Intl.DateTimeFormat("fr-FR", { dateStyle: "full", timeZone: "UTC" }).format(d);
      const ar = new Intl.NumberFormat("ar-EG").format(1234.5);
      return `${fr} · ${ar} · ICU ${process.versions.icu}, tz ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
    },
  ],
  [
    "zlib",
    () => {
      const input = Buffer.from("nodeapk ".repeat(1000));
      const z = zlib.gzipSync(input);
      const b = zlib.brotliCompressSync(input);
      if (!zlib.gunzipSync(z).equals(input)) throw new Error("round trip failed");
      return `gzip ${input.length}→${z.length}, brotli →${b.length}`;
    },
  ],
  [
    "os",
    () => {
      let cpus: string;
      try {
        cpus = `${os.cpus().length} cpus`;
      } catch (e) {
        cpus = `os.cpus() threw ${(e as Error).message}`;
      }
      return (
        `${cpus}, ${Math.round(os.totalmem() / 2 ** 20)} MiB total, ${Math.round(os.freemem() / 2 ** 20)} free, ` +
        `homedir ${os.homedir()}, tmpdir ${os.tmpdir()}, uid ${process.getuid?.() ?? "n/a"}, ` +
        `release ${os.release()}, loadavg ${os
          .loadavg()
          .map((n) => n.toFixed(2))
          .join(" ")}`
      );
    },
  ],
  [
    "process memory",
    () => {
      const m = process.memoryUsage();
      return (
        `rss ${Math.round(m.rss / 2 ** 20)} MiB, heap ${Math.round(m.heapUsed / 2 ** 20)}/${Math.round(m.heapTotal / 2 ** 20)} MiB, ` +
        `up ${Math.round(process.uptime() * 1000)} ms`
      );
    },
  ],
];

/** Send a broadcast datagram and listen for it on the same socket. */
function broadcastProbe(): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const token = crypto.randomUUID();
    const sent: string[] = [];
    const finish = (fn: () => void) => {
      clearTimeout(timer);
      socket.close();
      fn();
    };
    const timer = setTimeout(
      () =>
        finish(() => {
          if (sent.length) resolve(`sent to ${sent.join(", ")}; own packet not received back within 2 s`);
          else reject(new Error("nothing could be sent"));
        }),
      2000,
    );
    socket.on("error", (e) => finish(() => reject(e)));
    socket.on("message", (msg, rinfo) => {
      if (msg.toString() === token) {
        finish(() => resolve(`sent to ${sent.join(", ")}; received back from ${rinfo.address}`));
      }
    });
    socket.bind(0, () => {
      socket.setBroadcast(true);
      const port = socket.address().port;
      const targets = ["255.255.255.255", ...subnetBroadcasts()];
      for (const target of targets) {
        socket.send(token, port, target, (e) => {
          if (!e) sent.push(target);
        });
      }
    });
  });
}

function subnetBroadcasts(): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const ip = a.address.split(".").map(Number);
      const mask = a.netmask.split(".").map(Number);
      out.push(ip.map((n, i) => n | (~mask[i]! & 255)).join("."));
    }
  }
  return out;
}

/** Watch a folder, write a file in it, expect an event. */
function watchProbe(): Promise<string> {
  const dir = path.join(dataDir, "watch");
  fs.mkdirSync(dir, { recursive: true });
  return new Promise((resolve, reject) => {
    const events: string[] = [];
    const watcher = fs.watch(dir, (type, file) => events.push(`${type} ${file}`));
    watcher.on("error", reject);
    setTimeout(() => fs.writeFileSync(path.join(dir, "touched.txt"), String(Date.now())), 100);
    setTimeout(() => {
      watcher.close();
      if (events.length) resolve(events.slice(0, 3).join(", "));
      else reject(new Error("no event within 1 s"));
    }, 1100);
  });
}

/** Run every probe (each bounded to 10 s) and return the results in order. */
export async function runProbes(): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  for (const [name, run] of probes) {
    const t = performance.now();
    try {
      const detail = await Promise.race([
        Promise.resolve().then(run),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("timed out after 10 s")), 10_000),
        ),
      ]);
      results.push({ name, ok: true, detail, ms: Math.round(performance.now() - t) });
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      results.push({
        name,
        ok: false,
        detail: `${err.code ? `${err.code}: ` : ""}${err.message}`,
        ms: Math.round(performance.now() - t),
      });
    }
  }
  return results;
}

if (import.meta.main) {
  for (const r of await runProbes())
    console.log(`${r.ok ? "ok  " : "FAIL"} ${r.name} (${r.ms} ms): ${r.detail}`);
}
