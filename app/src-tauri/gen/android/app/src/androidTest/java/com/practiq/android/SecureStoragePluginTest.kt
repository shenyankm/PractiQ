package com.practiq.android

import android.app.Activity
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.view.InputDevice
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.core.app.ActivityScenario
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import app.tauri.plugin.Invoke
import app.tauri.plugin.PluginManager
import com.fasterxml.jackson.databind.ObjectMapper
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.BeforeClass
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference

@RunWith(AndroidJUnit4::class)
class SecureStoragePluginTest {
    companion object {
        private lateinit var scenario: ActivityScenario<MainActivity>
        private lateinit var activity: Activity
        @JvmStatic @BeforeClass fun launch() {
            scenario = ActivityScenario.launch(MainActivity::class.java)
            scenario.onActivity { activity = it }
        }
    }

    private fun call(command: String, args: JSONObject, registered: SecureStoragePlugin? = null): Pair<Long, JSONObject> {
        val latch = CountDownLatch(1)
        val response = AtomicReference<Pair<Long, JSONObject>>()
        val invoke = Invoke(1, command, 1, 2, { callback, json -> response.set(callback to JSONObject(json)); latch.countDown() }, args.toString(), ObjectMapper())
        val plugin = registered ?: SecureStoragePlugin(activity)
        when (command) {
            "readToken" -> plugin.readToken(invoke)
            "writeToken" -> plugin.writeToken(invoke)
            "openDocument" -> plugin.openDocument(invoke)
            else -> error("invalid-test-command")
        }
        assertTrue("Native command should settle", latch.await(10, TimeUnit.SECONDS))
        if (registered == null) plugin.onDestroy(activity as MainActivity)
        return response.get()
    }

    private fun registeredPlugin(): SecureStoragePlugin {
        // Test-only access to the actual singleton instance loaded by Rust setup.
        val field = PluginManager::class.java.getDeclaredField("plugins").apply { isAccessible = true }
        val plugins = field.get(PluginManager) as Map<*, *>
        val handle = checkNotNull(plugins["secure-storage"])
        return handle.javaClass.getMethod("getInstance").invoke(handle) as SecureStoragePlugin
    }

    private fun webView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) {
            webView(view.getChildAt(index))?.let { return it }
        }
        return null
    }

    private fun evaluate(script: String): String {
        val result = AtomicReference<String>()
        val latch = CountDownLatch(1)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val webView = webView(activity.findViewById(android.R.id.content)) ?: error("WebView should exist")
            webView.evaluateJavascript(script) { result.set(it); latch.countDown() }
        }
        assertTrue(latch.await(5, TimeUnit.SECONDS))
        return result.get()
    }

    private fun lifecycleStage(): Stage {
        val stage = AtomicReference<Stage>()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            stage.set(ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(activity))
        }
        return stage.get()
    }

    private fun requireResumedActivity(message: String) {
        val state = AtomicReference<Triple<Boolean, Boolean, Stage>>()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            state.set(Triple(activity.isFinishing, activity.isDestroyed,
                ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(activity)))
        }
        // Assertion failures belong to the instrumentation test thread, not the
        // Android main loop that runOnMainSync uses to collect this snapshot.
        val snapshot = state.get()
        assertFalse("$message: Activity is finishing", snapshot.first)
        assertFalse("$message: Activity is destroyed", snapshot.second)
        assertEquals("$message: Activity must be foreground", Stage.RESUMED, snapshot.third)
    }

    private fun awaitResumedActivity(deadline: Long, message: String) {
        while (lifecycleStage() != Stage.RESUMED) {
            assertTrue("$message: stage=${lifecycleStage()}", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(100)
        }
        requireResumedActivity(message)
        assertTrue("$message: Activity resumed after deadline", SystemClock.elapsedRealtime() < deadline)
    }

    private fun awaitScript(script: String, expected: String, message: String,
        deadline: Long = SystemClock.elapsedRealtime() + 15000,
        failureDiagnostics: (() -> String)? = null) {
        while (true) {
            val actual = evaluate(script)
            if (actual == expected) {
                val withinDeadline = SystemClock.elapsedRealtime() < deadline
                val diagnostic = if (withinDeadline) "" else failureDiagnostics?.invoke().orEmpty()
                assertTrue("$message: completed after deadline$diagnostic", withinDeadline)
                return
            }
            val stage = lifecycleStage()
            val withinDeadline = SystemClock.elapsedRealtime() < deadline
            val diagnostic = if (withinDeadline) "" else failureDiagnostics?.invoke().orEmpty()
            assertTrue("$message: expected=$expected actual=$actual stage=$stage$diagnostic",
                withinDeadline)
            SystemClock.sleep(100)
        }
    }

    @Test fun configurationRecreationKeepsTheNativeBridgeAvailable() {
        awaitScript("Boolean(window.__TAURI_INTERNALS__)", "true", "Tauri should initialize")
        val account = "ai-service-token-" + "d".repeat(64)
        assertEquals(1L, call("readToken", JSONObject().put("account", account), registeredPlugin()).first)
        val previous = activity
        scenario.recreate()
        scenario.onActivity { activity = it }
        assertNotSame(previous, activity)
        assertTrue(previous.isDestroyed)
        awaitScript("document.documentElement.dataset.nativeInsets === 'true'", "true", "Recreated WebView should initialize")
        evaluate("window.__practiqNativeProbe=null;window.__TAURI_INTERNALS__.invoke('request',{request:{type:'banks'},locale:'en'}).then(()=>{window.__practiqNativeProbe=true},()=>{window.__practiqNativeProbe=false});true")
        awaitScript("window.__practiqNativeProbe", "true", "Read-only native command should survive Activity recreation")
        assertEquals("Registered secure bridge should survive Activity recreation", 1L,
            call("readToken", JSONObject().put("account", account), registeredPlugin()).first)
        val document = call("openDocument", JSONObject().put("uri", "content://com.practiq.android.test.documents/source").put("write", false), registeredPlugin())
        assertEquals(1L, document.first)
        ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.adoptFd(document.second.getInt("fd"))).use {
            assertEquals("original-fixture-content", it.readBytes().toString(Charsets.UTF_8))
        }
        evaluate("delete window.__practiqNativeProbe;true")
    }

    @Test fun uncanceledRootBackPreservesActivityAndCanReopen() {
        awaitScript("document.documentElement.dataset.nativeInsets === 'true'", "true", "WebView should initialize")
        // A failed preceding picker must not dispatch Back on a stopped Activity:
        // lifecycle-owned callbacks are inactive there and the fallback finishes it.
        requireResumedActivity("Root Back precondition")
        val dispatched = AtomicReference(false)
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val current = activity as MainActivity
            if (!current.isFinishing && !current.isDestroyed &&
                ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(current) == Stage.RESUMED &&
                current.onBackPressedDispatcher.hasEnabledCallbacks()) {
                current.onBackPressedDispatcher.onBackPressed()
                dispatched.set(true)
            }
        }
        assertTrue("Root Back requires a live foreground Activity with an active app callback", dispatched.get())
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (true) {
            val stopped = AtomicReference<Boolean>()
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                stopped.set(ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(activity) == Stage.STOPPED)
            }
            if (stopped.get()) break
            assertTrue("Root Back should background the task", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(100)
        }
        assertFalse(activity.isFinishing)
        assertFalse(activity.isDestroyed)
        val context = InstrumentationRegistry.getInstrumentation().targetContext
        context.startActivity(Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        scenario.onActivity { activity = it }
        awaitScript("document.documentElement.dataset.nativeInsets === 'true'", "true", "Reopened WebView should initialize")
        assertFalse(activity.isDestroyed)
    }

    @Test fun nativeFilePickerCanOpenAndCancelAfterActivityRecreation() {
        scenario.recreate()
        scenario.onActivity { activity = it }
        assertSame(activity, PluginManager.activity)
        awaitScript("Boolean(window.__TAURI_INTERNALS__) && document.readyState === 'complete' && document.documentElement.dataset.nativeInsets === 'true'",
            "true", "Recreated final page should initialize")
        requireResumedActivity("Picker precondition")
        repeat(2) { cycle ->
        evaluate("window.__practiqPickerProbe='pending';window.__TAURI_INTERNALS__.invoke('request',{request:{type:'pick_import'},locale:'en'}).then(value=>{window.__practiqPickerProbe=value===null?'canceled':'unexpected'},()=>{window.__practiqPickerProbe='error'});true")
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (true) {
            val stopped = AtomicReference<Boolean>()
            InstrumentationRegistry.getInstrumentation().runOnMainSync {
                stopped.set(ActivityLifecycleMonitorRegistry.getInstance().getLifecycleStageOf(activity) == Stage.STOPPED)
            }
            if (stopped.get()) break
            assertEquals("Picker should open its system UI before settling", "\"pending\"", evaluate("window.__practiqPickerProbe"))
            assertTrue("Native picker should open", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(100)
        }
        val automation = InstrumentationRegistry.getInstrumentation().uiAutomation
        while (automation.rootInActiveWindow?.packageName?.toString()?.endsWith(".documentsui") != true) {
            assertEquals("Picker must remain pending before the system window is active", "\"pending\"", evaluate("window.__practiqPickerProbe"))
            assertTrue("The actual DocumentsUI picker must become active", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(100)
        }
        // Observe the existing result callback without replacing its behavior.
        val callbackField = PluginManager::class.java.getDeclaredField("startActivityForResultCallback").apply { isAccessible = true }
        val originalCallback = AtomicReference<PluginManager.ActivityResultCallback>()
        val activityIdentity = AtomicInteger()
        val resultCount = AtomicInteger()
        val resultCode = AtomicReference<Int>()
        val delegateReturned = AtomicInteger()
        val delegateThrowable = AtomicReference<String>()
        val observer = PluginManager.ActivityResultCallback { result ->
            resultCount.incrementAndGet()
            resultCode.set(result.resultCode)
            try {
                originalCallback.get().onResult(result)
                delegateReturned.incrementAndGet()
            } catch (failure: Throwable) {
                delegateThrowable.set(failure.javaClass.name)
                throw failure
            }
        }
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        instrumentation.runOnMainSync {
            activityIdentity.set(System.identityHashCode(activity))
            originalCallback.set(callbackField.get(PluginManager) as? PluginManager.ActivityResultCallback)
            if (originalCallback.get() != null) callbackField.set(PluginManager, observer)
        }
        try {
            assertNotNull("Native picker must retain its existing result callback", originalCallback.get())
            val cancellationDeadline = SystemClock.elapsedRealtime() + 15000
            val pressedAt = SystemClock.uptimeMillis()
            assertTrue("System Back down must be injected", automation.injectInputEvent(
                KeyEvent(pressedAt, pressedAt, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_BACK, 0).apply { source = InputDevice.SOURCE_KEYBOARD }, true))
            assertTrue("System Back up must be injected", automation.injectInputEvent(
                KeyEvent(pressedAt, SystemClock.uptimeMillis(), KeyEvent.ACTION_UP, KeyEvent.KEYCODE_BACK, 0).apply { source = InputDevice.SOURCE_KEYBOARD }, true))
            awaitScript("window.__practiqPickerProbe", "\"canceled\"", "Native picker cancellation should settle", cancellationDeadline) {
                " cycle=${cycle + 1} activityIdentity=${activityIdentity.get()}" +
                    " nativeResultCount=${resultCount.get()} nativeResultCode=${resultCode.get()}" +
                    " delegateReturned=${delegateReturned.get()} delegateThrowable=${delegateThrowable.get()}"
            }
            awaitResumedActivity(cancellationDeadline, "Picker cancellation must return to the app")
            assertEquals("Exactly one native result should reach the existing callback", 1, resultCount.get())
            assertEquals("The system picker must report cancellation", Activity.RESULT_CANCELED, resultCode.get())
            assertEquals("The existing native callback should return", 1, delegateReturned.get())
            evaluate("window.__practiqAfterPickerProbe=null;window.__TAURI_INTERNALS__.invoke('request',{request:{type:'banks'},locale:'en'}).then(()=>{window.__practiqAfterPickerProbe=true},()=>{window.__practiqAfterPickerProbe=false});true")
            awaitScript("window.__practiqAfterPickerProbe", "true",
                "Native command after cancellation should settle", cancellationDeadline)
            evaluate("delete window.__practiqPickerProbe;delete window.__practiqAfterPickerProbe;true")
        } finally {
            instrumentation.runOnMainSync {
                if (callbackField.get(PluginManager) === observer) {
                    callbackField.set(PluginManager, originalCallback.get())
                }
            }
        }
        }
    }

    @Test fun actualWebViewCannotInvokePrivateCredentialBridge() {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (evaluate("Boolean(window.__TAURI_INTERNALS__) ") != "true") {
            assertTrue("Tauri should initialize", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(100)
        }
        evaluate("window.__practiqBridgeProbe = null; window.__TAURI_INTERNALS__.invoke('plugin:secure-storage|read_token', {account:'ai-service-token-' + 'd'.repeat(64)}).then(() => {window.__practiqBridgeProbe = false}, () => {window.__practiqBridgeProbe = true}); true")
        while (true) {
            val response = evaluate("window.__practiqBridgeProbe")
            if (response != "null") { assertEquals("true", response); break }
            assertTrue("Private invocation should settle", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(100)
        }
        evaluate("delete window.__practiqBridgeProbe; true")
    }

    @Test fun canceledAppBackEventPreservesActivityAndNativeInsetFlag() {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (evaluate("document.documentElement.dataset.nativeInsets === 'true'") != "true") {
            assertTrue("Native inset flag should initialize", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(100)
        }
        evaluate("window.__practiqBackCount=0; window.__practiqBackProbe=e=>{e.preventDefault();window.__practiqBackCount++};document.addEventListener('practiq-android-back',window.__practiqBackProbe);true")
        InstrumentationRegistry.getInstrumentation().runOnMainSync { (activity as MainActivity).onBackPressedDispatcher.onBackPressed() }
        while (evaluate("window.__practiqBackCount") != "1") {
            assertTrue("Back should reach the app", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(100)
        }
        assertFalse(activity.isFinishing)
        evaluate("document.removeEventListener('practiq-android-back',window.__practiqBackProbe);delete window.__practiqBackProbe;delete window.__practiqBackCount;true")
    }

    @Test fun unavailableProviderAndUnselectedSchemesRejectSafely() {
        for (uri in listOf("file:///private/secret", "https://example.com", "content://com.practiq.android.test.documents/missing", "content://com.practiq.android.test.documents/denied")) {
            val result = call("openDocument", JSONObject().put("uri", uri).put("write", false))
            assertEquals(2L, result.first)
            assertEquals("DOCUMENT_ACCESS_DENIED", result.second.getString("code"))
            assertFalse(result.second.toString().contains("sensitive-provider-detail"))
        }
    }

    @Test fun nativeDocumentDescriptorReadsFullFileAndPipe() {
        for ((path, expected) in listOf("source" to "original-fixture-content", "pipe" to "pipe-fixture")) {
            val result = call("openDocument", JSONObject().put("uri", "content://com.practiq.android.test.documents/$path").put("write", false))
            assertEquals(1L, result.first)
            val descriptor = ParcelFileDescriptor.adoptFd(result.second.getInt("fd"))
            assertEquals(expected, ParcelFileDescriptor.AutoCloseInputStream(descriptor).use { it.readBytes().toString(Charsets.UTF_8) })
        }
    }

    @Test fun outputDescriptorTruncatesInsteadOfLeavingOldBytes() {
        val uri = "content://com.practiq.android.test.documents/fixture"
        val output = call("openDocument", JSONObject().put("uri", uri).put("write", true))
        assertEquals(1L, output.first)
        ParcelFileDescriptor.AutoCloseOutputStream(ParcelFileDescriptor.adoptFd(output.second.getInt("fd"))).use { it.write("short".toByteArray()) }
        val input = call("openDocument", JSONObject().put("uri", uri).put("write", false))
        assertEquals("short", ParcelFileDescriptor.AutoCloseInputStream(ParcelFileDescriptor.adoptFd(input.second.getInt("fd"))).use { it.readBytes().toString(Charsets.UTF_8) })
    }

    @Test fun malformedCredentialErrorsNeverEchoInput() {
        val response = call("writeToken", JSONObject().put("account", "invalid-sensitive-account").put("token", "sensitive-test-token\n"))
        assertEquals(2L, response.first)
        assertEquals("SECURE_STORAGE_UNAVAILABLE", response.second.getString("code"))
        assertFalse(response.second.toString().contains("sensitive-test-token"))
        assertFalse(response.second.toString().contains("invalid-sensitive-account"))
    }

    @Test fun credentialBridgeReturnsExplicitNullAndEmptyWriteObject() {
        val account = "ai-service-token-" + "c".repeat(64)
        val clear = call("writeToken", JSONObject().put("account", account).put("token", JSONObject.NULL))
        assertEquals(1L, clear.first)
        assertEquals(0, clear.second.length())
        val missing = call("readToken", JSONObject().put("account", account))
        assertEquals(1L, missing.first)
        assertEquals(1, missing.second.length())
        assertTrue(missing.second.has("token"))
        assertTrue(missing.second.isNull("token"))
        val missingToken = call("writeToken", JSONObject().put("account", account))
        assertEquals(2L, missingToken.first)
    }
}
