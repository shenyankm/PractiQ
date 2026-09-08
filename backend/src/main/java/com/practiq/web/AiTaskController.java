package com.practiq.web;

import com.practiq.auth.AuthService;
import com.practiq.common.ApiResponse;
import com.practiq.service.AiTaskService;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class AiTaskController {
  private final AuthService auth; private final AiTaskService tasks;
  AiTaskController(AuthService auth, AiTaskService tasks) { this.auth = auth; this.tasks = tasks; }
  private long user(String header) { return auth.require(header); }
  @PostMapping("/questions/{questionId}/ai-answer-tasks") ResponseEntity<ApiResponse<?>> answer(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long questionId) { return ResponseEntity.status(201).body(ApiResponse.ok(tasks.createAnswer(user(header), questionId))); }
  @PostMapping("/analytics/report-tasks") ResponseEntity<ApiResponse<?>> report(@RequestHeader(value = "Authorization", required = false) String header, @RequestBody(required = false) Map<String, Object> ignored) { return ResponseEntity.status(201).body(ApiResponse.ok(tasks.createReport(user(header)))); }
  @GetMapping("/ai-tasks/{id}") ApiResponse<?> get(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long id) { return ApiResponse.ok(tasks.get(user(header), id)); }
  @PostMapping("/ai-tasks/{id}/cancel") ApiResponse<?> cancel(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long id) { return ApiResponse.ok(tasks.cancel(user(header), id)); }
}
