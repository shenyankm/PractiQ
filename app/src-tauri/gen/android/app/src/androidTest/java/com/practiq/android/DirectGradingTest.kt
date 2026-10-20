package com.practiq.android

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.net.InetAddress
import java.net.ServerSocket
import java.net.SocketException
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import java.util.UUID

/** Real native grading and Keystore transport, using only an emulator-loopback model substitute. */
@RunWith(AndroidJUnit4::class)
class DirectGradingTest {
    private lateinit var activity: MainActivity

    private fun webView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) for (index in 0 until view.childCount) {
            webView(view.getChildAt(index))?.let { return it }
        }
        return null
    }

    private fun evaluate(script: String): String {
        val latch = CountDownLatch(1)
        val value = AtomicReference<String>()
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val view = webView(activity.findViewById(android.R.id.content))
            if (view == null) { value.set("null"); latch.countDown() }
            else view.evaluateJavascript(script) { value.set(it); latch.countDown() }
        }
        assertTrue("WebView callback should settle", latch.await(5, TimeUnit.SECONDS))
        return value.get()
    }

    private fun awaitReady() {
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (evaluate("Boolean(window.__TAURI_INTERNALS__ && document.documentElement.dataset.nativeInsets === 'true')") != "true") {
            assertTrue("Native WebView should initialize", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(100)
        }
    }

    private fun invoke(command: String, request: JSONObject, ok: Boolean = true): JSONObject {
        val args = JSONObject().put("request", request).put("locale", "en")
        evaluate("window.__directGradeReply=null;window.__TAURI_INTERNALS__.invoke(${JSONObject.quote(command)},$args).then(value=>{window.__directGradeReply={ok:true,value}},error=>{window.__directGradeReply={ok:false,error}});true")
        val deadline = SystemClock.elapsedRealtime() + 15000
        while (true) {
            val raw = evaluate("window.__directGradeReply")
            if (raw != "null") {
                val result = JSONObject(raw)
                assertEquals("Native $command/${request.optString("type")} should return the expected outcome (code=${result.optJSONObject("error")?.optString("code")})", ok, result.getBoolean("ok"))
                return result
            }
            assertTrue("Native $command should settle", SystemClock.elapsedRealtime() < deadline)
            SystemClock.sleep(50)
        }
    }

    private fun request(value: JSONObject) = invoke("request", value).get("value")
    private fun command(type: String) = JSONObject().put("type", type)
    private fun attempt(session: JSONObject) = session.getJSONArray("attempts").getJSONObject(0)
    private fun grade(id: String, retry: Boolean, ok: Boolean = true) =
        invoke("ai_request", command("grade").put("id", id).put("ordinal", 0).put("retry", retry), ok)

    private fun submitted(questionId: String, bankId: String): String {
        val selection = JSONObject().put("bank_ids", JSONArray().put(bankId)).put("search", "").put("mode", "")
            .put("filter", "").put("selection", "manual").put("count", 1).put("quotas", JSONObject())
            .put("question_ids", JSONArray().put(questionId)).put("random", false).put("total_cents", 1000)
        val preview = request(command("preview_paper").put("request", selection)) as JSONObject
        val paper = JSONObject().put("question_ids", preview.getJSONArray("questionIds"))
            .put("digest", preview.getString("digest")).put("kind", "self_test")
            .put("minutes", JSONObject.NULL).put("scores", preview.getJSONArray("scores")).put("total_cents", 1000)
        val id = (request(command("start_paper").put("paper", paper)) as JSONObject).getString("id")
        request(command("save_draft").put("id", id).put("ordinal", 0)
            .put("answer", JSONObject().put("text", "A preserved subjective answer."))
            .put("elapsed_ms", 1000))
        request(command("submit_paper").put("id", id).put("submit_drafts", true))
        return id
    }

    @Test fun directGradingKeepsReceiptsScoresAndSecretsAcrossActivityRecreation() {
        val server = ServerSocket(0, 10, InetAddress.getByName("127.0.0.1"))
        val modelCalls = AtomicInteger()
        val modelLists = AtomicInteger()
        val responseMode = AtomicReference("success")
        val serverFailure = AtomicReference<Throwable?>()
        val worker = Thread {
            try {
                while (!server.isClosed) server.accept().use { socket ->
                    socket.soTimeout = 10000
                    val input = socket.getInputStream().buffered()
                    val header = StringBuilder()
                    while (!header.endsWith("\r\n\r\n")) {
                        val byte = input.read()
                        check(byte >= 0 && header.length < 65536) { "Incomplete headers" }
                        header.append(byte.toChar())
                    }
                    val lines = header.toString().split("\r\n")
                    val first = lines.first()
                    val headers = mutableMapOf<String, String>()
                    for (line in lines.drop(1).filter { it.isNotEmpty() }) {
                        headers[line.substringBefore(':').lowercase()] = line.substringAfter(':').trim()
                    }
                    check(headers["authorization"] == "Bearer fixture-direct-model-key") { "Missing fixture authorization" }
                    val length = headers["content-length"]?.toInt() ?: 0
                    check(length in 0..(1024 * 1024))
                    val bytes = ByteArray(length)
                    var read = 0
                    while (read < length) {
                        val count = input.read(bytes, read, length - read)
                        check(count > 0)
                        read += count
                    }
                    val response = if (first == "GET /v1/models HTTP/1.1") {
                        modelLists.incrementAndGet()
                        JSONObject().put("data", JSONArray().put(JSONObject().put("id", "fixture-model")))
                    } else {
                        check(first == "POST /v1/chat/completions HTTP/1.1")
                        modelCalls.incrementAndGet()
                        val body = JSONObject(bytes.toString(Charsets.UTF_8))
                        check(body.getString("model") == "fixture-model")
                        check(body.getJSONObject("response_format").getString("type") == "json_object")
                        check(!body.has("tools") && !body.getBoolean("stream"))
                        val data = JSONObject(body.getJSONArray("messages").getJSONObject(1)
                            .getJSONArray("content").getJSONObject(0).getString("text"))
                        check(data.getString("answer") == "A preserved subjective answer.")
                        if (responseMode.get() == "disconnect") return@use
                        val max = data.getInt("assessmentMaxCents")
                        val result = JSONObject().put("scoreCents", max * 6 / 10).put("maxCents", max)
                            .put("reason", "Emulator model substitute: partial credit.")
                            .put("evidence", JSONArray().put("Supplied reference"))
                            .put("reviewReasons", JSONArray())
                        val content = if (responseMode.get() == "invalid") "{\"scoreCents\":999999999}" else result.toString()
                        JSONObject().put("id", "fixture-android-receipt").put("choices", JSONArray().put(
                            JSONObject().put("finish_reason", "stop").put("message", JSONObject().put("content", content))))
                            .put("usage", JSONObject().put("prompt_tokens", 50).put("completion_tokens", 20))
                    }
                    val responseBytes = response.toString().toByteArray(Charsets.UTF_8)
                    socket.getOutputStream().apply {
                        write("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${responseBytes.size}\r\nConnection: close\r\n\r\n".toByteArray())
                        write(responseBytes); flush()
                    }
                }
            } catch (error: Throwable) {
                if (!(server.isClosed && error is SocketException)) serverFailure.set(error)
            }
        }.apply { isDaemon = true; start() }
        try {
            val scenario = SecureStoragePluginTest.sharedScenario()
            scenario.onActivity { activity = it }
            awaitReady()
            request(command("add_example_bank"))
            val rows = request(command("questions_page").put("bank_ids", JSONArray()).put("search", "")
                .put("mode", "short_answer").put("filter", "").put("limit", 100).put("offset", 0)) as JSONObject
            val items = rows.getJSONArray("items")
            val row = (0 until items.length()).map { items.getJSONObject(it) }.first { candidate ->
                val question = (request(command("question_detail").put("id", candidate.getString("id"))) as JSONObject).getJSONObject("question")
                !question.optJSONObject("answerPayload")?.optString("text").isNullOrBlank() ||
                    (question.opt("scoringRubric") as? String)?.isNotBlank() == true
            }
            val questionId = row.getString("id")
            val id = submitted(questionId, row.getString("bankId"))
            val config = JSONObject().put("service_url", JSONObject.NULL).put("model", JSONObject()
                .put("base_url", "http://127.0.0.1:${server.localPort}/v1").put("model_id", "fixture-model"))
            request(command("save_settings").put("config", config).put("api_key", "fixture-direct-model-key"))
            val settings = request(command("settings")) as JSONObject
            assertTrue("Passive reads never expose keys", settings.isNull("hasApiKey"))
            assertFalse(settings.toString().contains("fixture-direct-model-key"))
            assertEquals(0, modelCalls.get())
            request(command("test_settings").put("config", config))
            assertEquals(1, modelLists.get())
            assertEquals(0, modelCalls.get())
            val graded = grade(id, false).getJSONObject("value")
            assertEquals(600, attempt(graded).getInt("earnedCents"))
            assertEquals("known", attempt(graded).getJSONObject("grading").getJSONObject("ai").getString("usageStatus"))
            assertEquals(600, attempt(grade(id, false).getJSONObject("value")).getInt("earnedCents"))
            assertEquals(1, modelCalls.get())
            responseMode.set("invalid")
            val invalid = attempt(grade(id, true).getJSONObject("value"))
            assertEquals(600, invalid.getInt("earnedCents"))
            assertEquals("ungraded", invalid.getJSONObject("grading").getJSONObject("lastRequest").getString("status"))
            responseMode.set("disconnect")
            val unknown = attempt(grade(id, true).getJSONObject("value"))
            assertEquals("unknown", unknown.getJSONObject("grading").getJSONObject("lastRequest").getString("status"))
            assertEquals(600, unknown.getInt("earnedCents"))
            assertEquals(3, modelCalls.get())
            request(command("save_settings").put("config", config).put("api_key", ""))
            assertEquals("unknown", attempt(grade(id, false).getJSONObject("value"))
                .getJSONObject("grading").getJSONObject("lastRequest").getString("status"))
            request(command("save_settings").put("config", config).put("api_key", "fixture-direct-model-key"))
            scenario.recreate()
            scenario.onActivity { activity = it }
            awaitReady()
            val reopened = attempt(grade(id, false).getJSONObject("value"))
            assertEquals("unknown", reopened.getJSONObject("grading").getJSONObject("lastRequest").getString("status"))
            assertEquals(3, modelCalls.get())
            request(command("manual_score").put("id", id).put("ordinal", 0).put("cents", 750).put("reason", "Native manual review"))
            assertEquals("LOCAL_GRADING_INELIGIBLE", grade(id, true, false).getJSONObject("error").getString("code"))
            val detail = request(command("question_detail").put("id", questionId)) as JSONObject
            val missingId = UUID.randomUUID().toString()
            val question = detail.getJSONObject("question").put("id", missingId).put("answerPayload", JSONObject.NULL).put("scoringRubric", JSONObject.NULL)
            request(command("save_question_tree").put("bank_id", row.getString("bankId")).put("root_id", JSONObject.NULL).put("questions", JSONArray().put(question)))
            val missing = submitted(missingId, row.getString("bankId"))
            assertEquals("LOCAL_GRADING_INELIGIBLE", grade(missing, false, false).getJSONObject("error").getString("code"))
            request(command("save_settings").put("config", config).put("api_key", ""))
            assertEquals("LOCAL_MODEL_KEY_REQUIRED", grade(missing, false, false).getJSONObject("error").getString("code"))
            assertEquals(3, modelCalls.get())
            assertNull("Loopback model substitute should complete without protocol errors", serverFailure.get())
            val report = JSONObject().put("passed", true).put("sessionId", id).put("missingEvidenceSessionId", missing)
                .put("modelCalls", modelCalls.get()).put("modelListReads", modelLists.get())
                .put("scoreAfterManualReview", 750).put("realModelCalls", 0)
            File(InstrumentationRegistry.getInstrumentation().targetContext.filesDir, "direct-grading-acceptance.json").writeText(report.toString(2))
        } finally {
            server.close()
            worker.join(2000)
        }
    }
}
