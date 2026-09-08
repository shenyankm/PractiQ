package com.practiq.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The existing Java client/worker must consume the migrated facade without API changes. */
class InternalAiMigrationTest {
  private final ObjectMapper json = new ObjectMapper();
  private static final String USAGE = """
      {"callKey":"00000000-0000-0000-0000-000000000001","modelId":"fake-model",
       "inputTokens":10,"outputTokens":5,"callKind":"document_parse"}
      """;

  @TempDir Path mount;

  @Test void partialImportRetainsMetadataImagesAndUsageBeforeSourceCleanup() throws Exception {
    Files.writeString(mount.resolve("source.txt"), "Synthetic quiz");
    var payload = json.readTree("""
        {"questions":[{"stem":"False statement?","answerMode":"true_false",
          "questionTypeId":"imported-boolean","options":[],"answerPayload":{"answer":false},
          "contentBlocks":[{"partType":"text","textValue":"False statement?"}],
          "confidence":0.8,"needsReview":true}],"groups":[],
          "visualElements":[{"kind":"image","description":"Synthetic figure","imageBase64":"aW1hZ2U="}],
          "qualityScore":80,"status":"PARTIAL","warnings":["Fragment skipped"],
          "processing":{"chunks":{"total":2,"succeeded":1,"skipped":0},
          "visuals":{"total":1,"succeeded":1,"skipped":0},"truncated":false,
          "failures":[{"stage":"document_parse","index":1,"code":"OUTPUT_INVALID","retryable":true}]}}
        """);
    var request = new AtomicReference<JsonNode>();
    var authorization = new AtomicReference<String>();
    var server = server(200, "{\"data\":" + payload + ",\"meta\":{\"usage\":[" + USAGE + "]}}", request, authorization);
    try {
      var tasks = mock(AiTaskService.class);
      when(tasks.claim(any())).thenReturn(new AiTaskService.Claim(1, 2, "import", json.createObjectNode(), OffsetDateTime.now().plusMinutes(2)));
      Map<String, Object> source = Map.of("source_type", "text", "source_file_name", "source.txt", "source_storage_path", "source.txt");
      when(tasks.importSource(1)).thenReturn(source);
      when(tasks.importSourceForCleanup(1)).thenReturn(source);
      var client = client(server);
      new AiTaskWorker(tasks, client, json, mount.toString()).work();
      assertEquals("Bearer test-token", authorization.get());
      assertEquals("Synthetic quiz", request.get().path("text").asText());
      assertFalse(request.get().has("userId"));
      var order = inOrder(tasks);
      order.verify(tasks).recordUsage(eq(1L), argThat(calls -> calls.size() == 1 && calls.getFirst().inputTokens() == 10));
      order.verify(tasks).completeImport(1, payload, false);
      order.verify(tasks).markImportSourceDeleted(1);
      assertFalse(Files.exists(mount.resolve("source.txt")));
      verify(tasks, never()).fail(anyLong(), any(), anyBoolean());
    } finally { server.stop(0); }
  }

  @Test void timeoutEnvelopeRetainsUsageAndLocalSourceForExistingFailureRules() throws Exception {
    Files.writeString(mount.resolve("source.txt"), "Synthetic quiz");
    var request = new AtomicReference<JsonNode>();
    var server = server(504, "{\"error\":{\"code\":\"AI_TIMEOUT\",\"message\":\"Deadline exceeded\"},\"meta\":{\"usage\":[" + USAGE + "]}}", request, new AtomicReference<>());
    try {
      var tasks = mock(AiTaskService.class);
      when(tasks.claim(any())).thenReturn(new AiTaskService.Claim(1, 2, "import", json.createObjectNode(), OffsetDateTime.now().plusMinutes(2)));
      when(tasks.importSource(1)).thenReturn(Map.of("source_type", "text", "source_file_name", "source.txt", "source_storage_path", "source.txt"));
      new AiTaskWorker(tasks, client(server), json, mount.toString()).work();
      var order = inOrder(tasks);
      order.verify(tasks).recordUsage(eq(1L), argThat(calls -> calls.size() == 1 && calls.getFirst().outputTokens() == 5));
      order.verify(tasks).fail(eq(1L), argThat(error -> error.path("code").asText().equals("AI_TIMEOUT")), eq(true));
      verify(tasks, never()).completeImport(anyLong(), any(), anyBoolean());
      assertTrue(Files.exists(mount.resolve("source.txt")));
    } finally { server.stop(0); }
  }

  @Test
  @org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable(named = "POSTGRES_URL", matches = ".+")
  void persistedPartialImagesAnswersAndUsageRemainOwnerAccessible() throws Exception {
    var source = new org.postgresql.ds.PGSimpleDataSource();
    source.setUrl(System.getenv("POSTGRES_URL"));
    source.setUser(System.getenv().getOrDefault("POSTGRES_USER", "postgres"));
    source.setPassword(System.getenv().getOrDefault("POSTGRES_PASSWORD", "postgres"));
    var db = new org.springframework.jdbc.core.JdbcTemplate(source);
    var transaction = new org.springframework.transaction.support.TransactionTemplate(
        new org.springframework.jdbc.datasource.DataSourceTransactionManager(source));
    String image = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    var result = json.createObjectNode().put("status", "PARTIAL").put("qualityScore", 80);
    result.putArray("groups"); result.putArray("warnings").add("Fragment skipped");
    result.putArray("visualElements").addObject().put("kind", "image").put("description", "Synthetic PNG").put("imageBase64", image);
    result.putObject("processing").putArray("failures").addObject().put("stage", "document_parse").put("index", 1).put("code", "OUTPUT_INVALID").put("retryable", true);
    var questions = result.putArray("questions");
    for (String mode : java.util.List.of("choice", "true_false", "fill_blank", "short_answer")) {
      var question = questions.addObject().put("stem", "Synthetic " + mode).put("answerMode", mode)
          .put("questionTypeId", "migration-" + mode).put("confidence", 0.8).put("needsReview", true);
      var options = question.putArray("options");
      var answer = question.putObject("answerPayload");
      switch (mode) {
        case "choice" -> { options.addObject().put("label", "A").put("content", "No"); options.addObject().put("label", "B").put("content", "Yes"); answer.put("correctOption", "B"); }
        case "true_false" -> answer.put("answer", false);
        case "fill_blank" -> answer.putArray("answers").add("four");
        default -> answer.put("answer", "Explanation");
      }
      question.putArray("contentBlocks").addObject().put("partType", "text").put("textValue", "Synthetic question");
    }
    var server = server(200, "{\"data\":" + result + ",\"meta\":{\"usage\":[" + USAGE + "]}}", new AtomicReference<>(), new AtomicReference<>());
    try {
      transaction.executeWithoutResult(status -> {
        status.setRollbackOnly();
        long owner = db.queryForObject("insert into users(display_name,paid_pro_at) values('Migration owner',now()) returning id", Long.class);
        db.update("insert into credit_accounts(user_id,balance) values(?,2)", owner);
        long bank = db.queryForObject("insert into question_banks(owner_user_id,subject_id,name) values(?,'general','Migration') returning id", Long.class, owner);
        for (JsonNode question : questions) db.update("insert into question_types(id,subject_id,display_name,answer_mode) values(?,'general',?,?)", question.path("questionTypeId").asText(), question.path("stem").asText(), question.path("answerMode").asText());
        var imports = new ImportService(db, mount.toString(), java.math.BigDecimal.ONE, "", "");
        var job = imports.create(owner, Map.of("paidPro", true), bank, "source.txt", "text", Map.of());
        long jobId = ((Number) job.get("id")).longValue(), task = ((Number) job.get("ai_task_id")).longValue();
        imports.upload(owner, Map.of("paidPro", true), jobId, new org.springframework.mock.web.MockMultipartFile("file", "source.txt", "text/plain", "Synthetic quiz".getBytes(StandardCharsets.UTF_8)));
        imports.action(owner, Map.of("paidPro", true), jobId, "parse", null);
        var tasks = new AiTaskService(db, json, new java.math.BigDecimal("0.01"), new java.math.BigDecimal("0.03"), java.math.BigDecimal.ONE, java.math.BigDecimal.ONE);
        new AiTaskWorker(tasks, client(server), json, mount.toString()).work();
        // AiTaskController GET /api/v1/ai-tasks/{id} returns this owner-filtered result.
        var visible = tasks.get(owner, task);
        assertEquals("succeeded", visible.get("status"));
        JsonNode persisted = (JsonNode) visible.get("result");
        assertNotNull(persisted, () -> String.valueOf(visible.get("error")));
        assertEquals("PARTIAL", persisted.path("status").asText());
        assertEquals(result.path("processing"), persisted.path("processing"));
        assertArrayEquals(java.util.Base64.getDecoder().decode(image), java.util.Base64.getDecoder().decode(persisted.path("visualElements").get(0).path("imageBase64").asText()));
        assertEquals(404, assertThrows(com.practiq.common.ApiException.class, () -> tasks.get(owner + 1, task)).status);
        assertEquals(4, db.queryForObject("select count(*) from bank_question_links where bank_id=? and status='draft'", Integer.class, bank));
        assertEquals(4, db.queryForObject("select count(*) from question_import_job_outputs where job_id=? and review_required", Integer.class, jobId));
        for (String mode : java.util.List.of("choice", "true_false", "fill_blank", "short_answer")) {
          String answer = db.queryForObject("select k.answer_payload::text from question_answer_keys k join questions q on q.id=k.question_id where q.source_job_id=? and q.answer_mode=?", String.class, jobId, mode);
          assertNotNull(answer);
          assertTrue(answer.contains(switch (mode) { case "choice" -> "\"correct\": [\"B\"]"; case "true_false" -> "\"answer\": false"; case "fill_blank" -> "\"answers\": [\"four\"]"; default -> "\"answer\": \"Explanation\""; }));
        }
        tasks.recordUsage(task, java.util.List.of(new InternalAiClient.Usage(java.util.UUID.fromString("00000000-0000-0000-0000-000000000001"), "fake-model", 10, 5, "document_parse")));
        assertEquals(1, db.queryForObject("select count(*) from ai_task_calls where task_id=?", Integer.class, task));
      });
    } finally { server.stop(0); }
  }

  private InternalAiClient client(HttpServer server) {
    return new InternalAiClient(json, "http://127.0.0.1:" + server.getAddress().getPort(), "test-token", true);
  }

  private HttpServer server(int status, String response, AtomicReference<JsonNode> request, AtomicReference<String> authorization) throws Exception {
    var server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
    server.createContext("/api/v1/ai/parse-document", exchange -> {
      request.set(json.readTree(exchange.getRequestBody()));
      authorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
      byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
      exchange.getResponseHeaders().set("Content-Type", "application/json");
      exchange.sendResponseHeaders(status, bytes.length);
      exchange.getResponseBody().write(bytes);
      exchange.close();
    });
    server.start();
    return server;
  }
}
