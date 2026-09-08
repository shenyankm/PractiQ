package com.practiq.service;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.Map;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

@Component
public class AiTaskWorker {
  private final AiTaskService tasks; private final InternalAiClient client; private final ObjectMapper json; private final String mount; private final UUID worker = UUID.randomUUID();
  AiTaskWorker(AiTaskService tasks, InternalAiClient client, ObjectMapper json, @Value("${practiq.object-storage-mount-dir}") String mount) { this.tasks = tasks; this.client = client; this.json = json; this.mount = mount; }

  @Scheduled(fixedDelayString = "${practiq.ai.worker-delay-ms:1000}")
  public void work() {
    tasks.expireOverdue(); if (!client.available()) return; AiTaskService.Claim claim = tasks.claim(worker); if (claim == null) return;
    try {
      JsonNode request; String operation;
      if ("import".equals(claim.kind())) { request = importRequest(tasks.importSource(claim.id())); operation = "parse-document"; }
      else { request = claim.requestPayload().deepCopy(); operation = "answer_generation".equals(claim.kind()) ? "generate-answer" : "learning-report"; }
      InternalAiClient.Result result = client.call(operation, request); tasks.recordUsage(claim.id(), result.usage());
      if (OffsetDateTime.now(ZoneOffset.UTC).isAfter(claim.deadlineAt())) { tasks.fail(claim.id(), json.createObjectNode().put("code", "AI_TIMEOUT").put("message", "AI task deadline exceeded"), true); return; }
      if ("import".equals(claim.kind())) { tasks.completeImport(claim.id(), result.data(), false); deleteImportSource(claim.id()); }
      else tasks.succeed(claim.id(), result.data());
    } catch (InternalAiClient.CallFailed error) {
      tasks.recordUsage(claim.id(), error.usage()); boolean timeout = "AI_TIMEOUT".equals(error.error().path("code").asText()); tasks.fail(claim.id(), error.error(), timeout);
    } catch (Exception error) {
      tasks.fail(claim.id(), json.createObjectNode().put("code", "AI_WORKER_ERROR").put("message", "AI task processing failed"), false);
    }
  }

  private ObjectNode importRequest(Map<String, Object> source) throws Exception {
    String type = String.valueOf(source.get("source_type")); String relative = String.valueOf(source.get("source_storage_path")); Path path = UploadSupport.path(mount, relative); byte[] bytes = Files.readAllBytes(path); ObjectNode request = json.createObjectNode().put("sourceType", type).put("fileName", String.valueOf(source.get("source_file_name")));
    if ("text".equals(type)) request.put("text", new String(bytes, StandardCharsets.UTF_8)); else request.put("fileBase64", Base64.getEncoder().encodeToString(bytes)).put("mimeType", mime(type)); return request;
  }
  private void deleteImportSource(long task) { try { Map<String, Object> source = tasks.importSourceForCleanup(task); Files.deleteIfExists(UploadSupport.path(mount, String.valueOf(source.get("source_storage_path")))); tasks.markImportSourceDeleted(task); } catch (Exception ignored) { /* retained for scheduled storage cleanup */ } }
  private static String mime(String type) { return switch (type) { case "pdf" -> "application/pdf"; case "docx" -> "application/vnd.openxmlformats-officedocument.wordprocessingml.document"; case "xlsx" -> "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"; default -> "application/octet-stream"; }; }
}
