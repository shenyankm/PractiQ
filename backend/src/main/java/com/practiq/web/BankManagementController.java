package com.practiq.web;

import com.practiq.auth.AuthService;
import com.practiq.common.ApiException;
import com.practiq.common.ApiResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.Positive;
import jakarta.validation.constraints.Size;
import java.sql.ResultSet;
import java.time.OffsetDateTime;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
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
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/banks/{bankId}")
public class BankManagementController {
  private final JdbcTemplate db;
  private final AuthService auth;

  BankManagementController(JdbcTemplate db, AuthService auth) { this.db = db; this.auth = auth; }

  record Tags(@Size(max = 30) List<@NotBlank @Size(max = 64) String> tags) {}
  record SubsetIn(Long parentId, @NotBlank @Size(max = 100) String name, @Positive Integer sortOrder) {}
  record ReorderItem(@Positive Long id, @Positive Integer sortOrder) {}
  record Reorder(@NotEmpty List<@Valid ReorderItem> items) {}

  private long user(String header) { return auth.require(header); }
  private static ApiException invalid(String message) { return ApiException.of(422, "VALIDATION_ERROR", message); }
  private Map<String, Object> row(ResultSet result, int ignored) throws java.sql.SQLException {
    var value = new LinkedHashMap<String, Object>();
    for (int index = 1; index <= result.getMetaData().getColumnCount(); index++) {
      Object item = result.getObject(index);
      value.put(result.getMetaData().getColumnLabel(index), item instanceof OffsetDateTime time ? time.toString() : item);
    }
    return value;
  }
  private void visible(long user, long bank) {
    Integer count = db.queryForObject("select count(*) from question_banks b where b.id=? and b.deleted_at is null and b.status<>'banned' and (b.owner_user_id=? or b.status='public' or exists(select 1 from study_group_banks gb join study_group_members gm on gm.group_id=gb.group_id where gb.bank_id=b.id and gm.user_id=? and gm.status='accepted'))", Integer.class, bank, user, user);
    if (count == null || count == 0) throw ApiException.of(404, "NOT_FOUND", "Question bank not found");
  }
  private void owner(long user, long bank) {
    Integer count = db.queryForObject("select count(*) from question_banks where id=? and owner_user_id=? and deleted_at is null", Integer.class, bank, user);
    if (count == null || count == 0) throw ApiException.of(403, "FORBIDDEN", "Question bank owner access required");
  }

  @GetMapping("/tags") ApiResponse<?> tags(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long bankId) {
    visible(user(header), bankId);
    return ApiResponse.ok(db.queryForList("select tag from bank_tags where bank_id=? order by tag", String.class, bankId));
  }

  @PatchMapping("/tags") @Transactional ApiResponse<?> replaceTags(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long bankId, @Valid @RequestBody Tags body) {
    owner(user(header), bankId);
    var normalized = new ArrayList<String>(); var seen = new HashSet<String>();
    for (String raw : body.tags() == null ? List.<String>of() : body.tags()) { String tag = raw.trim(); String key = tag.toLowerCase(java.util.Locale.ROOT); if (!seen.add(key)) continue; normalized.add(tag); }
    db.update("delete from bank_tags where bank_id=?", bankId);
    normalized.forEach(tag -> db.update("insert into bank_tags(bank_id,tag) values(?,?)", bankId, tag));
    return ApiResponse.ok(normalized);
  }

  @GetMapping("/subsets") ApiResponse<?> subsets(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long bankId) {
    visible(user(header), bankId);
    return ApiResponse.ok(db.query("with recursive tree as (select s.*,1 depth,lpad(s.sort_order::text,10,'0') path from bank_subsets s where s.bank_id=? and s.parent_id is null union all select s.*,t.depth+1,t.path||'.'||lpad(s.sort_order::text,10,'0') from bank_subsets s join tree t on t.id=s.parent_id where s.bank_id=?) select id,bank_id,parent_id,name,sort_order,depth,created_at,updated_at from tree order by path,id", this::row, bankId, bankId));
  }

  @PostMapping("/subsets") @Transactional ResponseEntity<ApiResponse<?>> createSubset(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long bankId, @Valid @RequestBody SubsetIn body) {
    owner(user(header), bankId); checkParent(bankId, body.parentId());
    int order = body.sortOrder() == null ? db.queryForObject("select coalesce(max(sort_order),0)+1 from bank_subsets where bank_id=? and parent_id is not distinct from ?", Integer.class, bankId, body.parentId()) : body.sortOrder();
    var result = db.query("insert into bank_subsets(bank_id,parent_id,name,sort_order) values(?,?,?,?) returning *", this::row, bankId, body.parentId(), body.name().trim(), order).getFirst();
    return ResponseEntity.status(201).body(ApiResponse.ok(result));
  }

  @PatchMapping("/subsets/{subsetId}") @Transactional ApiResponse<?> updateSubset(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long bankId, @PathVariable long subsetId, @RequestBody SubsetIn body) {
    owner(user(header), bankId); if (body.name() == null && body.parentId() == null && body.sortOrder() == null) throw invalid("body must include a field to update"); checkParent(bankId, body.parentId());
    var rows = db.query("update bank_subsets set parent_id=coalesce(?,parent_id),name=coalesce(?,name),sort_order=coalesce(?,sort_order) where id=? and bank_id=? returning *", this::row, body.parentId(), body.name() == null ? null : body.name().trim(), body.sortOrder(), subsetId, bankId);
    if (rows.isEmpty()) throw ApiException.of(404, "NOT_FOUND", "Subset not found"); return ApiResponse.ok(rows.getFirst());
  }

  @DeleteMapping("/subsets/{subsetId}") @Transactional ResponseEntity<Void> deleteSubset(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long bankId, @PathVariable long subsetId) {
    owner(user(header), bankId);
    if (db.queryForObject("select count(*) from bank_subsets where bank_id=? and parent_id=?", Integer.class, bankId, subsetId) > 0) throw ApiException.of(409, "SUBSET_NOT_EMPTY", "Remove child subsets first");
    if (db.queryForObject("select (select count(*) from bank_question_links where bank_id=? and subset_id=?)+(select count(*) from bank_group_links where bank_id=? and subset_id=?)", Integer.class, bankId, subsetId, bankId, subsetId) > 0) throw ApiException.of(409, "SUBSET_IN_USE", "Move bank items out of the subset first");
    if (db.update("delete from bank_subsets where id=? and bank_id=?", subsetId, bankId) == 0) throw ApiException.of(404, "NOT_FOUND", "Subset not found");
    return ResponseEntity.noContent().build();
  }

  @PatchMapping("/subsets/reorder") @Transactional ResponseEntity<Void> reorderSubsets(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long bankId, @Valid @RequestBody Reorder body) {
    owner(user(header), bankId); Set<Long> ids = new HashSet<>(); Set<Integer> orders = new HashSet<>();
    for (var item : body.items()) if (!ids.add(item.id()) || !orders.add(item.sortOrder())) throw invalid("subset IDs and sortOrder values must be unique");
    db.update("update bank_subsets set sort_order=sort_order+1000000 where bank_id=?", bankId);
    for (var item : body.items()) if (db.update("update bank_subsets set sort_order=? where bank_id=? and id=?", item.sortOrder(), bankId, item.id()) != 1) throw invalid("items contains an unknown subset");
    return ResponseEntity.noContent().build();
  }

  @DeleteMapping("/practice-data") @Transactional ResponseEntity<Void> resetPractice(@RequestHeader(value = "Authorization", required = false) String header, @PathVariable long bankId) {
    long user = user(header); visible(user, bankId);
    db.update("delete from user_question_stats where user_id=? and bank_id=?", user, bankId);
    db.update("delete from practice_sessions where user_id=? and bank_id=?", user, bankId);
    return ResponseEntity.noContent().build();
  }

  private void checkParent(long bank, Long parent) {
    if (parent == null) return;
    if (db.queryForObject("select count(*) from bank_subsets where id=? and bank_id=?", Integer.class, parent, bank) == 0) throw invalid("parentId must belong to the same bank");
  }
}
