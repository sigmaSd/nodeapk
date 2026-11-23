// Starts the app's Node server as a child process and reports what it does.
//
// Node ships in the APK as lib/<abi>/libnode.so: Android 10+ refuses to execute files from an app's data
// folder (W^X, SELinux), but the native library folder is executable, and the package manager only
// extracts files named lib*.so there (with android:extractNativeLibs="true"). It is a normal PIE executable
// despite the name.
//
// The app contract: the server listens on 127.0.0.1 and prints one ready line on stdout,
// `nodeapk: http://127.0.0.1:PORT/`. Everything else on stdout/stderr goes to logcat (tag "nodeapk") and
// into a small ring buffer, shown if Node exits. MainActivity owns the lifecycle.
//
// Calls from Node to the shell (globalThis.nodeapk, defined by the preload in Platform.kt) travel the same
// pipes: a `nodeapk:call {"id":1,"method":"pickFolder","args":[]}` line on stdout, answered with
// `{"id":1,"result":…}` (or "error") on Node's stdin.
package dev.nodeapk.shell

import android.util.Log
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader
import java.util.ArrayDeque
import java.util.concurrent.TimeUnit

/** A call from Node: its id (to answer), the method and its arguments. */
class Call(val id: Long, val method: String, val args: org.json.JSONArray)

/** The ready line a nodeapk app prints once its server listens. */
object ReadyLine {
  private val pattern = Regex("""^nodeapk: (http://127\.0\.0\.1:\d{1,5}/\S*)\s*$""")

  /** The URL announced by [line], or null when it is any other output. */
  fun parse(line: String): String? = pattern.matchEntire(line)?.groupValues?.get(1)

  private const val CALL = "nodeapk:call "

  /** The call on [line], or null when it is any other output. */
  fun call(line: String): Call? {
    if (!line.startsWith(CALL)) return null
    return try {
      val json = org.json.JSONObject(line.substring(CALL.length))
      Call(json.getLong("id"), json.getString("method"), json.optJSONArray("args") ?: org.json.JSONArray())
    } catch (_: org.json.JSONException) {
      null
    }
  }
}

class NodeProcess(
  private val node: File,
  private val nodeArgs: List<String>,
  private val entry: File,
  private val cwd: File,
  private val env: Map<String, String>,
  private val onReady: (url: String) -> Unit,
  private val onCall: (call: Call) -> Unit,
  private val onExit: (code: Int, output: String) -> Unit,
) {
  private val tail = ArrayDeque<String>()
  private var process: Process? = null
  @Volatile private var stopping = false

  fun start() {
    val builder = ProcessBuilder(listOf(node.path) + nodeArgs + entry.path).directory(cwd)
    builder.environment().putAll(env)
    val p = builder.start()
    process = p
    Log.i(TAG, "started ${node.path} ${entry.path}")
    reader("stdout", BufferedReader(InputStreamReader(p.inputStream))) { line ->
      val url = ReadyLine.parse(line)
      if (url != null) onReady(url)
      ReadyLine.call(line)?.let(onCall)
    }
    reader("stderr", BufferedReader(InputStreamReader(p.errorStream))) {}
    Thread({
      val code = p.waitFor()
      Log.i(TAG, "node exited with $code")
      // Give the readers a moment to drain the last lines (the error, usually)
      Thread.sleep(200)
      if (!stopping) onExit(code, synchronized(tail) { tail.joinToString("\n") })
    }, "node-wait").start()
  }

  /** Answer a call: `result` is any JSON value (null included); `error` makes the call reject. */
  fun reply(id: Long, result: Any?, error: String? = null) {
    val json = org.json.JSONObject().put("id", id)
    if (error != null) json.put("error", error) else json.put("result", result ?: org.json.JSONObject.NULL)
    val out = process?.outputStream ?: return
    try {
      synchronized(out) {
        out.write((json.toString() + "\n").toByteArray())
        out.flush()
      }
    } catch (e: java.io.IOException) {
      Log.w(TAG, "could not answer call $id: $e") // Node is gone
    }
  }

  /** SIGTERM, then SIGKILL if Node has not exited within a second. */
  fun stop() {
    stopping = true
    val p = process ?: return
    Log.i(TAG, "stopping node")
    p.destroy()
    Thread({
      if (!p.waitFor(1, TimeUnit.SECONDS)) p.destroyForcibly()
      Log.i(TAG, "node stopped")
    }, "node-stop").start()
  }

  private fun reader(name: String, input: BufferedReader, onLine: (String) -> Unit) {
    Thread({
      try {
        while (true) {
          val line = input.readLine() ?: break
          if (name == "stderr") Log.w(TAG, line) else Log.i(TAG, line)
          synchronized(tail) {
            tail.addLast(line)
            while (tail.size > TAIL_LINES) tail.removeFirst()
          }
          onLine(line)
        }
      } catch (_: java.io.IOException) {
        // The stream closes when Node is killed: nothing left to read
      }
    }, "node-$name").start()
  }

  companion object {
    const val TAG = "nodeapk"
    private const val TAIL_LINES = 60
  }
}
