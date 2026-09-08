package com.practiq.web;

import com.practiq.common.*;
import java.util.*;
import org.springframework.http.*;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.web.bind.annotation.*;

@RestController @RequestMapping("/api/v1")
public class ReferenceController {
  final JdbcTemplate db;
  public ReferenceController(JdbcTemplate db) { this.db = db; }
  @GetMapping("/subjects") public ResponseEntity<ApiResponse<?>> subjects() { return cached(ApiResponse.ok(db.query("select id as subject_id,display_name from subjects order by display_name", (result, number) -> Map.of("subject_id", result.getString(1), "display_name", result.getString(2))))); }
  @GetMapping("/question-types") public ResponseEntity<ApiResponse<?>> types(@RequestParam(defaultValue = "") String subject, @RequestParam(defaultValue = "") String scope) { if (!scope.isBlank() && !"question".equals(scope)) return cached(ApiResponse.ok(List.of())); return cached(ApiResponse.ok(db.query("select id as type_id,subject_id,display_name,'question' as scope,answer_mode as default_answer_mode from question_types where (?='' or subject_id=?) order by subject_id,display_name", (result, number) -> { var value = new LinkedHashMap<String, Object>(); value.put("type_id", result.getString(1)); value.put("subject_id", result.getString(2)); value.put("display_name", result.getString(3)); value.put("scope", result.getString(4)); value.put("default_answer_mode", result.getString(5)); return value; }, subject.trim(), subject.trim()))); }
  @GetMapping("/knowledge-points") public ResponseEntity<ApiResponse<?>> knowledge(@RequestParam(defaultValue = "") String subject, @RequestParam(required = false) Long parentId, @RequestParam(defaultValue = "") String q, @RequestParam(defaultValue = "") String cursor, @RequestParam(required = false) Integer limit) { int size = limit == null ? 50 : limit; if (size < 1 || size > 200) throw ApiException.of(422, "VALIDATION_ERROR", "Invalid request", List.of(Map.of("field", "limit", "message", "must be between 1 and 200"))); int offset = PageSupport.cursor(cursor); var rows = db.query("select id,subject_id,code,display_name,parent_id,'{}'::jsonb metadata_json,created_at,updated_at from knowledge_points where (?='' or subject_id=?) and ((cast(? as bigint) is null and parent_id is null) or parent_id=cast(? as bigint)) and (?='' or code ilike ? or display_name ilike ?) order by display_name,id limit ? offset ?", (result, number) -> { var value = new LinkedHashMap<String, Object>(); for (int i = 1; i <= 8; i++) value.put(result.getMetaData().getColumnLabel(i), result.getObject(i)); return value; }, subject.trim(), subject.trim(), parentId, parentId, q.trim(), "%" + q.trim() + "%", "%" + q.trim() + "%", size + 1, offset); boolean more = rows.size() > size; if (more) rows = rows.subList(0, size); return cached(ApiResponse.ok(rows, Map.of("pagination", Map.of("cursor", more ? PageSupport.next(offset, size) : "", "limit", size, "hasMore", more)))); }
  private ResponseEntity<ApiResponse<?>> cached(ApiResponse<?> body) { return ResponseEntity.ok().header(HttpHeaders.CACHE_CONTROL, "public, max-age=0, s-maxage=300, stale-while-revalidate=60").body(body); }
}
