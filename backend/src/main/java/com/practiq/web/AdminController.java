package com.practiq.web;

import com.practiq.auth.AuthService;
import com.practiq.common.ApiException;
import com.practiq.common.ApiResponse;
import com.practiq.common.PageSupport;
import com.practiq.service.MembershipService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import java.io.ByteArrayInputStream;
import java.io.InputStreamReader;
import java.math.BigDecimal;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.sql.ResultSet;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RequestPart;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;

@RestController
@RequestMapping("/api/v1/admin")
public class AdminController {
  private final JdbcTemplate db; private final AuthService auth; private final MembershipService membership;
  AdminController(JdbcTemplate db, AuthService auth, MembershipService membership) { this.db = db; this.auth = auth; this.membership = membership; }

  record UserPatch(String status, String role) {}
  record KnowledgeIn(@NotBlank String subjectId, @NotBlank @Size(max = 128) String code, @NotBlank @Size(max = 256) String displayName, Long parentId) {}
  record KnowledgePatch(@Size(max = 128) String code, @Size(max = 256) String displayName, Long parentId) {}

  private long admin(String header) { long user = auth.require(header); Map<String, Object> me = auth.user(user); if (!"admin".equals(me.get("role")) || !"active".equals(me.get("status"))) throw ApiException.of(403, "ADMIN_REQUIRED", "Administrator access required"); return user; }
  private static ApiException invalid(String message) { return ApiException.of(422, "VALIDATION_ERROR", message); }
  private Map<String, Object> row(ResultSet result, int ignored) throws java.sql.SQLException { var value = new LinkedHashMap<String, Object>(); for (int index = 1; index <= result.getMetaData().getColumnCount(); index++) { Object item = result.getObject(index); value.put(result.getMetaData().getColumnLabel(index), item instanceof OffsetDateTime time ? time.toString() : item); } return value; }

  @GetMapping("/users") ApiResponse<?> users(@RequestHeader(value = "Authorization", required = false) String header, @RequestParam(defaultValue = "") String q, @RequestParam(defaultValue = "") String status, @RequestParam(defaultValue = "") String role, @RequestParam(defaultValue = "") String cursor, @RequestParam(required = false) Integer limit) {
    admin(header); if (!status.isBlank() && !Set.of("active", "inactive").contains(status)) throw invalid("Invalid user status"); if (!role.isBlank() && !Set.of("user", "admin").contains(role)) throw invalid("Invalid user role");
    int size = Math.min(100, Math.max(1, limit == null ? 30 : limit)), offset = PageSupport.cursor(cursor);
    var rows = db.query("select u.id,u.display_name,u.avatar_url,u.status,u.role,u.trial_ends_at,u.paid_pro_at,coalesce(c.balance,0) credit_balance,u.created_at from users u left join credit_accounts c on c.user_id=u.id where (?='' or coalesce(u.display_name,'') ilike '%'||?||'%' or u.id::text=?) and (?='' or u.status=?) and (?='' or u.role=?) order by u.created_at desc,u.id desc limit ? offset ?", (result, ignored) -> userRow(result), q.trim(), q.trim(), q.trim(), status, status, role, role, size + 1, offset);
    boolean more = rows.size() > size; if (more) rows = rows.subList(0, size);
    return ApiResponse.ok(rows, Map.of("pagination", Map.of("cursor", more ? PageSupport.next(offset, size) : "", "limit", size, "hasMore", more)));
  }

  private Map<String, Object> userRow(ResultSet result) throws java.sql.SQLException {
    OffsetDateTime trial = result.getObject("trial_ends_at", OffsetDateTime.class), paid = result.getObject("paid_pro_at", OffsetDateTime.class); BigDecimal credits = result.getBigDecimal("credit_balance");
    var value = new LinkedHashMap<String, Object>(); value.put("id", result.getLong("id")); value.put("displayName", result.getString("display_name")); value.put("avatarUrl", result.getString("avatar_url")); value.put("status", result.getString("status")); value.put("role", result.getString("role")); value.put("effectiveMembership", membership.effective(paid, trial)); value.put("paidPro", membership.paidPro(paid)); value.put("trialEndsAt", trial == null ? null : trial.toString()); value.put("paidProAt", paid == null ? null : paid.toString()); value.put("creditBalance", credits); value.put("createdAt", result.getObject("created_at", OffsetDateTime.class).toString()); return value;
  }

  @PatchMapping("/users/{id}") @Transactional ApiResponse<?> updateUser(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long id, @RequestBody UserPatch body) {
    long actor = admin(header); if (body.status() == null && body.role() == null) throw invalid("body must include status or role"); if (body.status() != null && !Set.of("active", "inactive").contains(body.status())) throw invalid("Invalid user status"); if (body.role() != null && !Set.of("user", "admin").contains(body.role())) throw invalid("Invalid user role");
    var old = db.query("select status,role from users where id=? for update", this::row, id); if (old.isEmpty()) throw ApiException.of(404, "NOT_FOUND", "User not found"); String oldStatus = String.valueOf(old.getFirst().get("status")), oldRole = String.valueOf(old.getFirst().get("role"));
    String nextStatus = body.status() == null ? oldStatus : body.status(), nextRole = body.role() == null ? oldRole : body.role();
    if ("admin".equals(oldRole) && "active".equals(oldStatus) && (!"admin".equals(nextRole) || !"active".equals(nextStatus))) { db.query("select pg_advisory_xact_lock(hashtextextended('active-admin',0))", statement -> {}, ignored -> null); Integer others = db.queryForObject("select count(*) from users where id<>? and role='admin' and status='active'", Integer.class, id); if (others == null || others == 0) throw ApiException.of(409, "LAST_ACTIVE_ADMIN", "The last active administrator cannot be disabled or downgraded"); }
    db.update("update users set status=?,role=? where id=?", nextStatus, nextRole, id);
    if (!oldRole.equals(nextRole)) audit(actor, id, "admin".equals(nextRole) ? "grant_admin" : "revoke_admin", Map.of("previousRole", oldRole, "role", nextRole));
    if (!oldStatus.equals(nextStatus)) audit(actor, id, "active".equals(nextStatus) ? "activate_user" : "deactivate_user", Map.of("previousStatus", oldStatus, "status", nextStatus));
    return ApiResponse.ok(auth.user(id));
  }

  @PostMapping("/banks/{id}/{action:ban|unban}") @Transactional ApiResponse<?> bankStatus(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long id, @PathVariable String action) {
    long actor = admin(header); String expected = "ban".equals(action) ? "public" : "banned", next = "ban".equals(action) ? "banned" : "public";
    var rows = db.query("update question_banks set status=? where id=? and deleted_at is null and status=? returning *", this::row, next, id, expected); if (rows.isEmpty()) throw ApiException.of(409, "BANK_STATUS_CONFLICT", "Only public banks can be banned and only banned banks can be restored"); audit(actor, null, "ban".equals(action) ? "ban_bank" : "unban_bank", Map.of("bankId", id)); return ApiResponse.ok(rows.getFirst());
  }

  @PostMapping("/knowledge-points") @Transactional ResponseEntity<ApiResponse<?>> createKnowledge(@RequestHeader(value = "Authorization", required = false) String header, @Valid @RequestBody KnowledgeIn body) {
    long actor = admin(header); validateParent(body.subjectId(), body.parentId()); var value = db.query("insert into knowledge_points(subject_id,code,display_name,parent_id) values(?,?,?,?) returning *", this::row, body.subjectId().trim(), body.code().trim(), body.displayName().trim(), body.parentId()).getFirst(); audit(actor, null, "knowledge_point", Map.of("operation", "create", "knowledgePointId", value.get("id"))); return ResponseEntity.status(201).body(ApiResponse.ok(value));
  }

  @PatchMapping("/knowledge-points/{id}") @Transactional ApiResponse<?> updateKnowledge(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long id, @RequestBody KnowledgePatch body) {
    long actor = admin(header); if (body.code() == null && body.displayName() == null && body.parentId() == null) throw invalid("body must include a field to update"); String subject = db.query("select subject_id from knowledge_points where id=?", (result, ignored) -> result.getString(1), id).stream().findFirst().orElseThrow(() -> ApiException.of(404, "NOT_FOUND", "Knowledge point not found")); validateParent(subject, body.parentId()); var rows = db.query("update knowledge_points set code=coalesce(?,code),display_name=coalesce(?,display_name),parent_id=coalesce(?,parent_id) where id=? returning *", this::row, body.code() == null ? null : body.code().trim(), body.displayName() == null ? null : body.displayName().trim(), body.parentId(), id); audit(actor, null, "knowledge_point", Map.of("operation", "update", "knowledgePointId", id)); return ApiResponse.ok(rows.getFirst());
  }

  @DeleteMapping("/knowledge-points/{id}") @Transactional ResponseEntity<Void> deleteKnowledge(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long id) {
    long actor = admin(header); Integer used = db.queryForObject("select (select count(*) from knowledge_points where parent_id=?)+(select count(*) from question_knowledge_points where knowledge_point_id=?)", Integer.class, id, id); if (used != null && used > 0) throw ApiException.of(409, "KNOWLEDGE_POINT_IN_USE", "Knowledge point has children or linked questions"); if (db.update("delete from knowledge_points where id=?", id) == 0) throw ApiException.of(404, "NOT_FOUND", "Knowledge point not found"); audit(actor, null, "knowledge_point", Map.of("operation", "delete", "knowledgePointId", id)); return ResponseEntity.noContent().build();
  }

  @PostMapping(value = "/knowledge-points/import", consumes = MediaType.MULTIPART_FORM_DATA_VALUE) @Transactional ApiResponse<?> importKnowledge(@RequestHeader(value = "Authorization", required = false) String header, @RequestPart("file") MultipartFile file) {
    long actor = admin(header); List<List<String>> rows = csv(file); if (rows.isEmpty() || !rows.getFirst().equals(List.of("subjectId", "code", "displayName", "parentCode"))) throw invalid("CSV header must be subjectId,code,displayName,parentCode"); int imported = 0;
    for (int index = 1; index < rows.size(); index++) { int rowNumber = index + 1; List<String> row = rows.get(index); if (row.size() != 4 || row.get(0).isBlank() || row.get(1).isBlank() || row.get(2).isBlank()) throw invalid("Invalid CSV row " + rowNumber); Long parent = row.get(3).isBlank() ? null : db.query("select id from knowledge_points where subject_id=? and code=?", (result, ignored) -> result.getLong(1), row.get(0).trim(), row.get(3).trim()).stream().findFirst().orElseThrow(() -> invalid("Unknown parentCode on CSV row " + rowNumber)); db.update("insert into knowledge_points(subject_id,code,display_name,parent_id) values(?,?,?,?) on conflict(subject_id,code) do update set display_name=excluded.display_name,parent_id=excluded.parent_id", row.get(0).trim(), row.get(1).trim(), row.get(2).trim(), parent); imported++; }
    audit(actor, null, "knowledge_point", Map.of("operation", "import", "count", imported)); return ApiResponse.ok(Map.of("imported", imported));
  }

  private void validateParent(String subject, Long parent) { if (parent != null && db.queryForObject("select count(*) from knowledge_points where id=? and subject_id=?", Integer.class, parent, subject) == 0) throw invalid("parentId must belong to the same subject"); }
  private void audit(long actor, Long target, String action, Map<String, Object> details) { db.update("insert into admin_audits(actor_user_id,target_user_id,action,details) values(?,?,?,?::jsonb)", actor, target, action, json(details)); }
  private String json(Map<String, Object> value) { try { return new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(value); } catch (Exception error) { throw new IllegalStateException(error); } }
  private List<List<String>> csv(MultipartFile file) { try { if (file == null || file.isEmpty() || file.getSize() > 5_000_000) throw invalid("CSV file is required and must be at most 5 MB"); var decoder = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT).onUnmappableCharacter(CodingErrorAction.REPORT); String text = decoder.decode(ByteBuffer.wrap(file.getBytes())).toString(); var rows = new ArrayList<List<String>>(); try (var reader = new java.io.BufferedReader(new InputStreamReader(new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8)), StandardCharsets.UTF_8))) { String line; while ((line = reader.readLine()) != null) { if (!line.isBlank()) rows.add(csvLine(line)); } } return rows; } catch (ApiException error) { throw error; } catch (Exception error) { throw invalid("CSV must be valid UTF-8"); } }
  private List<String> csvLine(String line) { var values = new ArrayList<String>(); var value = new StringBuilder(); boolean quoted = false; for (int index = 0; index < line.length(); index++) { char current = line.charAt(index); if (current == '"') { if (quoted && index + 1 < line.length() && line.charAt(index + 1) == '"') { value.append('"'); index++; } else quoted = !quoted; } else if (current == ',' && !quoted) { values.add(value.toString()); value.setLength(0); } else value.append(current); } if (quoted) throw invalid("Invalid quoted CSV value"); values.add(value.toString()); return values; }
}
