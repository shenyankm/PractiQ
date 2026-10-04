package com.practiq.android

import android.os.Bundle
import android.webkit.WebView
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
  override val handleBackNavigation: Boolean = false
  private var appWebView: WebView? = null

  override fun onWebViewCreate(webView: WebView) {
    super.onWebViewCreate(webView)
    appWebView = webView
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
    // WebView CSS env() does not consistently include Android bars or keyboard.
    val content = findViewById<android.view.View>(android.R.id.content)
    ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
      val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())
      val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
      view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
      insets
    }
    ViewCompat.requestApplyInsets(content)
    onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
      override fun handleOnBackPressed() {
        val webView = appWebView
        if (webView == null) { defaultBack(); return }
        // The app cancels synchronously before invoking its existing dirty guard.
        webView.evaluateJavascript("document.dispatchEvent(new Event('practiq-android-back', {cancelable:true}))") { result ->
          if (result != "false") defaultBack()
        }
      }

      private fun defaultBack() {
        // The app already handled dialogs and page navigation. At its root,
        // preserve the native runtime while returning to the launcher.
        moveTaskToBack(true)
      }
    })
  }
}
