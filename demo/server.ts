// The demo app: a node:http server following the nodeapk contract (listen on 127.0.0.1, print one ready
// line), serving a page that runs demo/probes.ts and shows what works on the phone.
// Run on the desktop with `node demo/server.ts`; tools/build-demo.ts packs it into an APK.

import http from "node:http";
import { runProbes } from "./probes.ts";

const page = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>nodeapk demo</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { margin: 0; padding: 16px; }
  h1 { font-size: 1.3rem; margin: 0 0 4px; }
  p { margin: 0 0 12px; opacity: .75; }
  li { margin: 0 0 10px; list-style: none; }
  ul { padding: 0; }
  b.ok { color: #2e8b3d; } b.fail { color: #c62828; }
  code { font-size: .8rem; word-break: break-word; }
  button { font-size: 1rem; padding: 8px 16px; }
</style>
<h1>Hello from Node ${process.version} on ${process.platform}/${process.arch}</h1>
<p id="summary">Running probes…</p>
<ul id="list"></ul>
<button id="again">Run again</button>
<script type="module">
  const list = document.getElementById("list"), summary = document.getElementById("summary");
  async function run() {
    summary.textContent = "Running probes…"; list.textContent = "";
    const results = await (await fetch("/api/probes")).json();
    for (const r of results) {
      const li = document.createElement("li");
      li.innerHTML = '<b class="' + (r.ok ? "ok" : "fail") + '">' + (r.ok ? "✓" : "✗") + "</b> ";
      li.append(r.name + " (" + r.ms + " ms)", document.createElement("br"));
      const code = document.createElement("code"); code.textContent = r.detail; li.append(code);
      list.append(li);
    }
    const failed = results.filter((r) => !r.ok).length;
    summary.textContent = (results.length - failed) + " of " + results.length + " probes passed";
    console.log("probes: " + JSON.stringify(results));
    // what the WebView offers the page (logged to logcat by the shell)
    const formats = "BarcodeDetector" in window ? await BarcodeDetector.getSupportedFormats() : "none";
    console.log("webview: BarcodeDetector " + JSON.stringify(formats) + ", mediaDevices " + !!navigator.mediaDevices + ", secure " + isSecureContext);
  }
  document.getElementById("again").onclick = run;
  run();
</script>
`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/api/probes") {
    const results = await runProbes();
    for (const r of results) console.log(`probe ${r.ok ? "ok" : "FAIL"} ${r.name}: ${r.detail}`);
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(results));
    return;
  }
  // Checks the shell's error screen: an uncaught exception kills Node, the shell shows its last output
  if (req.url === "/api/crash") {
    res.end("crashing\n");
    setTimeout(() => {
      throw new Error("crash requested through /api/crash");
    }, 100);
    return;
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(page);
});

server.listen(0, "127.0.0.1", () => {
  const { port } = server.address() as { port: number };
  console.log(`nodeapk: http://127.0.0.1:${port}/`);
});
