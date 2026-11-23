// The nodeapk shell: one activity that starts the app's Node server and shows it in a WebView.
//
// Flow: copy the app's files from the APK's assets/app/ to files/app/ (Node can't read inside the APK;
// copied again only when the APK changes), start Node on the entry named in assets/nodeapk.json
// (NodeProcess; environment and options from Platform), wait for its
// ready line, load the announced http://127.0.0.1:PORT/ URL. If Node exits, the WebView is replaced by
// the error and the last lines Node printed. Node is stopped with the activity.
//
// A slow start only gets a note, never a final error: when the app is in the background, Android (and
// vendor freezers such as Xiaomi's GreezeManager) freeze the app's whole cgroup, Node included, and the
// timer can run out while nothing was allowed to run. The ready line still loads the page when it comes.
//
// Built without Gradle against android.jar alone (no AndroidX): see tools/ and shell/AndroidManifest.xml.
// Cleartext HTTP is allowed to 127.0.0.1 only (res/xml/network_security_config.xml).
package dev.nodeapk.shell

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowInsets
import android.webkit.ConsoleMessage
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import android.widget.ScrollView
import android.widget.TextView
import java.io.File

class MainActivity : Activity() {
  private lateinit var webView: WebView
  private lateinit var status: TextView
  private lateinit var statusScroll: ScrollView
  private var node: NodeProcess? = null
  private var multicast: android.net.wifi.WifiManager.MulticastLock? = null
  private val main = Handler(Looper.getMainLooper())
  private var loaded = false // the page is shown
  private var exited = false // Node is gone: its error stays on screen
  private var startedAt = 0L

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    buildViews()
    startedAt = System.nanoTime()
    val options = AppOptions.read(this)
    if (options.multicastLock) multicast = Platform.multicastLock(this)
    if (options.allFiles) Platform.askAllFiles(this)
    Thread({ startNode(options) }, "node-start").start()
    main.postDelayed({
      if (!loaded && !exited && !isFinishing) {
        status.text = "Still waiting for Node's ready line after $READY_TIMEOUT_S s…"
      }
    }, READY_TIMEOUT_S * 1000L)
  }

  override fun onDestroy() {
    node?.stop()
    multicast?.release()
    webView.destroy()
    super.onDestroy()
  }

  @Deprecated("Still the simplest back handling without AndroidX")
  override fun onBackPressed() {
    if (webView.visibility == View.VISIBLE && webView.canGoBack()) webView.goBack()
    else @Suppress("DEPRECATION") super.onBackPressed()
  }

  private fun startNode(options: AppOptions) {
    try {
      val app = extractApp()
      val entry = File(app, options.entry)
      val data = File(filesDir, "data").apply { mkdirs() }
      val cache = File(cacheDir, "node").apply { mkdirs() }
      val tmp = File(cacheDir, "tmp").apply { mkdirs() }
      val env = mapOf(
        "HOME" to filesDir.path,
        "TMPDIR" to tmp.path,
        "NODEAPK_DATA" to data.path,
        "NODEAPK_CACHE" to cache.path,
        "NODEAPK_PACKAGE" to packageName,
        "NODEAPK_VERSION" to (packageManager.getPackageInfo(packageName, 0).versionName ?: ""),
        "NODEAPK_DNS" to Platform.dnsServers(this),
        "LANG" to Platform.lang(),
      )
      val preload = Platform.preload(this)
      val nodeBin = File(applicationInfo.nativeLibraryDir, "libnode.so")
      node = NodeProcess(
        nodeBin, listOf("--import", preload.toURI().toString()), entry, app, env,
        onReady = { url -> main.post { onReady(url) } },
        onExit = { code, output -> main.post { exited = true; showError("Node exited with code $code.", output) } },
      ).also { it.start() }
    } catch (e: Exception) {
      Log.e(NodeProcess.TAG, "could not start node", e)
      main.post { exited = true; showError("Could not start Node: $e", "") }
    }
  }

  /** Copy assets/app/ to files/app/ unless this APK's copy is already there. */
  private fun extractApp(): File {
    val dir = File(filesDir, "app")
    val stamp = File(dir, ".nodeapk-installed")
    val version = packageManager.getPackageInfo(packageName, 0).lastUpdateTime.toString()
    if (stamp.isFile && stamp.readText() == version) return dir
    dir.deleteRecursively()
    copyAssets("app", dir)
    stamp.writeText(version)
    return dir
  }

  private fun copyAssets(path: String, to: File) {
    val children = assets.list(path) ?: emptyArray()
    if (children.isEmpty()) {
      to.parentFile?.mkdirs()
      assets.open(path).use { input -> to.outputStream().use { input.copyTo(it) } }
      return
    }
    to.mkdirs()
    for (child in children) copyAssets("$path/$child", File(to, child))
  }

  private fun onReady(url: String) {
    if (isFinishing || loaded || exited) return
    loaded = true
    Log.i(NodeProcess.TAG, "ready after ${(System.nanoTime() - startedAt) / 1_000_000} ms: $url")
    statusScroll.visibility = View.GONE
    webView.visibility = View.VISIBLE
    webView.loadUrl(url)
  }

  private fun showError(message: String, output: String) {
    if (isFinishing) return
    webView.visibility = View.GONE
    statusScroll.visibility = View.VISIBLE
    status.setTextColor(Color.rgb(0xb0, 0x20, 0x20))
    status.text = if (output.isEmpty()) message else "$message\n\n$output"
    // The cause (an exception's stack trace) is printed last
    statusScroll.post { statusScroll.fullScroll(View.FOCUS_DOWN) }
  }

  private fun buildViews() {
    webView = WebView(this).apply {
      visibility = View.GONE
      settings.javaScriptEnabled = true
      settings.domStorageEnabled = true
      settings.allowFileAccess = false
      settings.allowContentAccess = false
      webViewClient = object : WebViewClient() {
        // The app's own pages stay here; any other link opens in the browser
        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
          if (request.url.isLocal()) return false
          try {
            startActivity(Intent(Intent.ACTION_VIEW, request.url))
          } catch (_: Exception) {
            // No app handles that link: nothing to open
          }
          return true
        }
      }
      // WebView doesn't forward the page's console anywhere by default
      webChromeClient = object : WebChromeClient() {
        override fun onConsoleMessage(m: ConsoleMessage): Boolean {
          Log.i(NodeProcess.TAG, "[console] ${m.sourceId()}:${m.lineNumber()} ${m.message()}")
          return true
        }
      }
    }
    status = TextView(this).apply {
      text = "Starting…"
      typeface = Typeface.MONOSPACE
      textSize = 13f
      setTextIsSelectable(true)
      setPadding(32, 32, 32, 32)
    }
    statusScroll = ScrollView(this).apply { addView(status) }

    // Edge-to-edge is forced from targetSdk 35: pad a container by the system bars (WebView ignores its
    // own padding)
    val root = FrameLayout(this)
    val match = FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT)
    root.addView(webView, match)
    root.addView(statusScroll, FrameLayout.LayoutParams(match))
    root.setOnApplyWindowInsetsListener { v, insets ->
      @Suppress("DEPRECATION")
      v.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop, insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
      @Suppress("DEPRECATION")
      insets.consumeSystemWindowInsets()
    }
    setContentView(root)
  }

  companion object {
    private const val READY_TIMEOUT_S = 30
  }
}

private fun Uri.isLocal() = scheme == "http" && host == "127.0.0.1"
