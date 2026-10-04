package com.practiq.android

import android.app.Activity
import android.net.Uri
import android.os.ParcelFileDescriptor
import androidx.appcompat.app.AppCompatActivity
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.RejectedExecutionException

@InvokeArg
class TokenReadArgs { var account: String = "" }

@InvokeArg
class TokenWriteArgs { var account: String = ""; var token: String? = null }

@InvokeArg
class DocumentOpenArgs { var uri: String = ""; var write: Boolean = false }

/** Called through the private Rust plugin; all WebView invocations are denied in Rust. */
@TauriPlugin
class SecureStoragePlugin(activity: Activity) : Plugin(activity) {
    private val context = activity.applicationContext
    private val executor = Executors.newSingleThreadExecutor()
    private val store by lazy { SecureTokenStore(context) }

    private fun enqueue(invoke: Invoke, operation: () -> Unit) {
        try { executor.execute(operation) }
        catch (_: RejectedExecutionException) {
            invoke.reject("Native secure storage is unavailable", "SECURE_STORAGE_UNAVAILABLE")
        }
    }

    private fun execute(invoke: Invoke, operation: () -> JSObject) {
        enqueue(invoke) {
            try { invoke.resolve(operation()) }
            catch (_: Exception) { invoke.reject("Native secure storage is unavailable", "SECURE_STORAGE_UNAVAILABLE") }
        }
    }

    @Command
    fun readToken(invoke: Invoke) = execute(invoke) {
        val args = invoke.parseArgs(TokenReadArgs::class.java)
        JSObject().apply { put("token", store.read(args.account) ?: JSONObject.NULL) }
    }

    @Command
    fun writeToken(invoke: Invoke) = execute(invoke) {
        check(invoke.getArgs().has("token")) { "SECURE_STORAGE_INVALID_INPUT" }
        val args = invoke.parseArgs(TokenWriteArgs::class.java)
        store.write(args.account, args.token)
        JSObject()
    }

    @Command
    fun openDocument(invoke: Invoke) {
        enqueue(invoke) {
            var detached: Int? = null
            try {
                val args = invoke.parseArgs(DocumentOpenArgs::class.java)
                val uri = Uri.parse(args.uri)
                check(uri.scheme == "content" && !uri.authority.isNullOrBlank()) { "DOCUMENT_ACCESS_DENIED" }
                val descriptor = context.contentResolver.openFileDescriptor(uri, if (args.write) "rwt" else "r")
                    ?: error("DOCUMENT_ACCESS_DENIED")
                descriptor.use {
                    val fd = it.detachFd()
                    detached = fd
                    check(fd >= 0) { "DOCUMENT_ACCESS_DENIED" }
                    invoke.resolve(JSObject().apply { put("fd", fd) })
                    detached = null // Rust owns the descriptor after delivery.
                }
            } catch (_: Exception) {
                detached?.takeIf { it >= 0 }?.let { runCatching { ParcelFileDescriptor.adoptFd(it).close() } }
                invoke.reject("The selected document is unavailable", "DOCUMENT_ACCESS_DENIED")
            }
        }
    }

    override fun onDestroy(activity: AppCompatActivity) {
        // Tauri retains this plugin instance when configuration changes recreate
        // the Activity. Its application context and worker remain valid.
        if (!activity.isChangingConfigurations) executor.shutdown()
    }
}
