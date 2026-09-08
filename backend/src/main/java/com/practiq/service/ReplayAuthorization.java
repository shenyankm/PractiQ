package com.practiq.service;

import com.practiq.common.ApiException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Rechecks current authorization, not business preconditions already consumed by the original write. */
@Service
public class ReplayAuthorization {
  private final JdbcTemplate db;
  private final ObjectMapper json;
  private final MediaService media;
  public ReplayAuthorization(JdbcTemplate db, ObjectMapper json, MediaService media) { this.db = db; this.json = json; this.media = media; }

  public void request(long user, String method, String path, byte[] body) {
    JsonNode input;
    try { input = body.length == 0 ? json.createObjectNode() : json.readTree(body); }
    catch (RuntimeException invalidJson) { input = json.createObjectNode(); }
    if (input == null) input = json.createObjectNode();
    String[] parts = path.substring("/api/v1/".length()).split("/");
    long id = parts.length > 1 && parts[1].matches("[0-9]+") ? Long.parseLong(parts[1]) : 0;
    var access = new ContentAccess(db);
    switch (parts[0]) {
      case "admin" -> require("select exists(select 1 from users where id=? and status='active' and role='admin')", user);
      case "users" -> { if (!path.equals("/api/v1/users/me")) denied(); }
      case "banks" -> {
        if (id == 0) return;
        access.bank(user, id);
        if (!path.endsWith("/favorite") && !path.endsWith("/clone") && !path.endsWith("/practice-data")) bankOwner(user, id);
      }
      case "questions" -> access.editQuestion(user, id);
      case "groups" -> {
        access.editGroup(user, id);
        if (input.path("questionId").asLong() > 0) access.editQuestion(user, input.path("questionId").asLong());
      }
      case "options" -> {
        var questions = db.queryForList("select question_id from question_options where id=?", Long.class, id);
        if (questions.isEmpty()) denied();
        access.editQuestion(user, questions.getFirst());
      }
      case "practice-sessions" -> {
        if (id > 0) access.session(user, id);
        else if (input.path("bankId").asLong() > 0) access.bank(user, input.path("bankId").asLong());
      }
      case "media" -> { if (id > 0) require("select exists(select 1 from users where id=? and status='active' and role='admin')", user); }
      case "study-groups" -> {
        if (id == 0) return;
        if (path.endsWith("/leave")) require("select exists(select 1 from study_group_members where group_id=? and user_id=? and status='accepted')", id, user);
        else require("select exists(select 1 from study_groups where id=? and owner_user_id=?)", id, user);
        if (method.equals("POST") && parts.length > 3 && parts[2].equals("banks")) { long bank = Long.parseLong(parts[3]); access.bank(user, bank); bankOwner(user, bank); }
      }
      case "study-group-invitations" -> {
        if (parts.length < 2) denied();
        require("select exists(select 1 from study_group_invitations where token_hash=? and expires_at>now())", tokenHash(parts[1]));
      }
      case "import-jobs" -> {
        long bank = input.path("bankId").asLong();
        if (id > 0) {
          var banks = db.queryForList("select bank_id from question_import_jobs where id=? and created_by=?", Long.class, id, user);
          if (banks.isEmpty()) denied();
          bank = banks.getFirst();
        }
        if (bank > 0) { access.bank(user, bank); bankOwner(user, bank); }
      }
      case "ai-tasks" -> access.task(user, id);
      case "analytics" -> { if (!path.equals("/api/v1/analytics/report-tasks")) denied(); }
      default -> denied();
    }
    if (path.endsWith("/media-links") && input.path("mediaId").asLong() > 0) {
      long asset = input.path("mediaId").asLong();
      require("select exists(select 1 from media_assets where id=? and created_by=? and deleted_at is null)", asset, user);
      media.asset(user, "user", asset);
    }
  }
  private static byte[] tokenHash(String token) {
    try { return java.security.MessageDigest.getInstance("SHA-256").digest(token.getBytes(java.nio.charset.StandardCharsets.UTF_8)); }
    catch (java.security.NoSuchAlgorithmException error) { throw new IllegalStateException(error); }
  }
  private void bankOwner(long user, long bank) { require("select exists(select 1 from question_banks where id=? and owner_user_id=?)", bank, user); }

  public void check(long user, String method, String path, IdempotentWrites.Result result) {
    // Successful deletes/leave have no content to disclose and must retain their original 204 semantics.
    if (result.status() == 204 && result.body().length == 0 && (method.equals("DELETE") || path.endsWith("/leave"))) return;
    String[] parts = path.substring("/api/v1/".length()).split("/");
    var access = new ContentAccess(db);
    JsonNode data = result.body().length == 0 ? json.createObjectNode() : json.readTree(result.body()).path("data");
    long id = parts.length > 1 && parts[1].matches("[0-9]+") ? Long.parseLong(parts[1]) : 0;
    switch (parts[0]) {
      case "admin" -> require("select exists(select 1 from users where id=? and status='active' and role='admin')", user);
      case "users" -> { if (!path.equals("/api/v1/users/me")) denied(); }
      case "banks" -> {
        if (id == 0) id = data.path("id").asLong();
        access.bank(user, id);
        if (!path.endsWith("/favorite") && !path.endsWith("/clone") && !path.endsWith("/practice-data")) require("select exists(select 1 from question_banks where id=? and owner_user_id=?)", id, user);
        if (path.endsWith("/questions")) access.editQuestion(user, data.path("id").asLong());
        if (path.endsWith("/groups")) access.editGroup(user, data.path("id").asLong());
        if (path.endsWith("/clone")) access.bank(user, data.path("id").asLong());
      }
      case "questions" -> access.editQuestion(user, id);
      case "groups" -> access.editGroup(user, id);
      case "options" -> {
        var questions = db.queryForList("select question_id from question_options where id=?", Long.class, id);
        if (questions.isEmpty()) denied();
        access.editQuestion(user, questions.getFirst());
      }
      case "practice-sessions" -> access.session(user, id == 0 ? data.path("id").asLong() : id);
      case "media" -> media.asset(user, "user", id == 0 ? data.path("id").asLong() : id);
      case "study-groups" -> {
        if (id == 0) id = data.path("id").asLong();
        require("select exists(select 1 from study_groups where id=? and owner_user_id=?)", id, user);
        if (parts.length > 3 && parts[2].equals("banks")) access.bank(user, Long.parseLong(parts[3]));
      }
      case "study-group-invitations" -> {
        if (path.endsWith("/accept")) require("select exists(select 1 from study_group_members where group_id=? and user_id=? and status='accepted')", data.path("id").asLong(), user);
        else if (!path.endsWith("/reject")) denied();
      }
      case "import-jobs" -> {
        if (id == 0) id = data.path("id").asLong();
        var banks = db.queryForList("select bank_id from question_import_jobs where id=? and created_by=?", Long.class, id, user);
        if (banks.isEmpty()) denied();
        access.bank(user, banks.getFirst());
      }
      case "ai-tasks", "analytics" -> {
        if (id == 0) id = data.path("id").asLong();
        access.task(user, id);
      }
      default -> denied(); // New writes must explicitly define their replay authorization.
    }
  }
  private void require(String sql, Object... args) { if (!Boolean.TRUE.equals(db.queryForObject(sql, Boolean.class, args))) denied(); }
  private void denied() { throw ApiException.of(404, "NOT_FOUND", "Original response is no longer accessible"); }
}
