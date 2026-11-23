// What the shell gives Node from the Android side: the app's options (assets/nodeapk.json, written by
// `nodeapk build`), the environment (language, DNS servers, version), the preload that applies the DNS
// servers, and the optional multicast lock and "All files access".
package dev.nodeapk.shell

import android.Manifest
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.ConnectivityManager
import android.net.Uri
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Environment
import android.provider.Settings
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.util.Locale

/** assets/nodeapk.json. */
class AppOptions(val entry: String, val multicastLock: Boolean, val allFiles: Boolean, val camera: Boolean) {
  companion object {
    fun read(context: Context): AppOptions {
      val json = JSONObject(context.assets.open("nodeapk.json").bufferedReader().readText())
      return AppOptions(
        json.getString("entry"), json.optBoolean("multicastLock"), json.optBoolean("allFiles"), json.optBoolean("camera"),
      )
    }
  }
}

object Platform {
  /**
   * Loaded with --import before the app:
   * - Node's c-ares resolver (dns.resolve*) reads /etc/resolv.conf, which Android doesn't have, so it has no
   *   servers; the shell passes the network's in NODEAPK_DNS.
   * - globalThis.nodeapk: what the app can ask of the shell (NodeProcess.kt describes the wire format).
   * No template literals in it: this is a Kotlin string, where a dollar sign starts a template.
   */
  private const val PRELOAD = """// Written by the nodeapk shell (Platform.kt).
import dns from "node:dns";
import { createInterface } from "node:readline";

const servers = (process.env.NODEAPK_DNS ?? "").split(",").filter(Boolean);
if (servers.length) {
  try { dns.setServers(servers); } catch { /* a server Node can't parse: resolve keeps its defaults */ }
}

let next = 0;
let lines;
const waiting = new Map();
function call(method, ...args) {
  if (!lines) {
    // answers come on stdin; unref: waiting for one must not keep Node alive on its own
    lines = createInterface({ input: process.stdin });
    process.stdin.unref?.();
    lines.on("line", (line) => {
      let answer;
      try { answer = JSON.parse(line); } catch { return; }
      const w = waiting.get(answer.id);
      if (!w) return;
      waiting.delete(answer.id);
      if (answer.error) w.reject(new Error(answer.error));
      else w.resolve(answer.result);
    });
  }
  const id = ++next;
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    process.stdout.write("nodeapk:call " + JSON.stringify({ id, method, args }) + "\n");
  });
}

globalThis.nodeapk = {
  /** Android's folder picker: the chosen folder's path, or null (cancelled, or not a local folder). */
  pickFolder: () => call("pickFolder"),
};
"""

  /** The preload file, written where Node can read it. */
  fun preload(context: Context): File {
    val file = File(context.filesDir, "nodeapk/preload.mjs")
    if (!file.isFile || file.readText() != PRELOAD) {
      file.parentFile?.mkdirs()
      file.writeText(PRELOAD)
    }
    return file
  }

  /**
   * A folder chosen in Android's picker (a document tree URI) as a filesystem path, when it is on local
   * storage: "primary:Documents/X" is /storage/emulated/0/Documents/X, "1A2B-3C4D:Music" an SD card's
   * /storage/1A2B-3C4D/Music. Reading it needs "All files access" (the all-files permission). Null for
   * anything else (a cloud provider, Downloads' virtual tree).
   */
  fun treePath(uri: Uri): String? {
    if (uri.authority != "com.android.externalstorage.documents") return null
    val id = try { android.provider.DocumentsContract.getTreeDocumentId(uri) } catch (_: Exception) { return null }
    val volume = id.substringBefore(':')
    val rel = id.substringAfter(':', "")
    val root = if (volume == "primary") Environment.getExternalStorageDirectory().path else "/storage/$volume"
    return if (rel.isEmpty()) root else "$root/$rel"
  }

  /** The active network's DNS servers ("1.1.1.1,2606:…"), without link-local ones (they need a scope). */
  fun dnsServers(context: Context): String {
    val cm = context.getSystemService(ConnectivityManager::class.java) ?: return ""
    val props = cm.getLinkProperties(cm.activeNetwork) ?: return ""
    return props.dnsServers.filter { !it.isLinkLocalAddress }.mapNotNull { it.hostAddress }.joinToString(",")
  }

  /** The phone's language as POSIX LANG (fr_FR.UTF-8): ICU, and so Intl, takes its default from it. */
  fun lang(): String {
    val l = Locale.getDefault()
    return (if (l.country.isEmpty()) l.language else "${l.language}_${l.country}") + ".UTF-8"
  }

  /** Wi-Fi drops broadcasts and multicast for apps that don't hold this lock (when the screen is off, at least). */
  fun multicastLock(context: Context): WifiManager.MulticastLock? = try {
    val wifi = context.applicationContext.getSystemService(WifiManager::class.java)
    wifi?.createMulticastLock("nodeapk")?.apply {
      setReferenceCounted(false)
      acquire()
    }
  } catch (e: Exception) {
    Log.w(NodeProcess.TAG, "no multicast lock: $e")
    null
  }

  /**
   * Ask for access to the shared storage if the app wants it and doesn't have it: Android 11+ has a settings
   * page for it ("All files access"); before, it's the storage permission. Asked once per install: a refusal
   * stands until the user changes it in the settings.
   */
  fun askAllFiles(activity: Activity) {
    val asked = File(activity.filesDir, "nodeapk/asked-all-files")
    if (asked.exists()) return
    if (Build.VERSION.SDK_INT >= 30) {
      if (Environment.isExternalStorageManager()) return
      asked.parentFile?.mkdirs()
      asked.writeText("")
      try {
        val uri = Uri.parse("package:${activity.packageName}")
        activity.startActivity(Intent(Settings.ACTION_MANAGE_APP_ALL_FILES_ACCESS_PERMISSION, uri))
      } catch (_: Exception) {
        activity.startActivity(Intent(Settings.ACTION_MANAGE_ALL_FILES_ACCESS_PERMISSION))
      }
    } else {
      asked.parentFile?.mkdirs()
      asked.writeText("")
      activity.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), 1)
    }
  }
}
