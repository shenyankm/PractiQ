package com.practiq.service;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import com.practiq.common.ApiException;
import com.practiq.common.PageSupport;
import java.sql.ResultSet;
import java.time.OffsetDateTime;
import java.util.*;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class PracticeService {
  private static final int MAX = 500;
  private final JdbcTemplate db;
  private final StringRedisTemplate redis;
  private final ObjectMapper json;
  private final GradingService grader;

  public PracticeService(JdbcTemplate db, StringRedisTemplate redis, ObjectMapper json, GradingService grader) {
    this.db = db; this.redis = redis; this.json = json; this.grader = grader;
  }
  private static ApiException bad(String message) { return ApiException.of(422, "VALIDATION_ERROR", message); }
  private static ApiException state(String message) { return ApiException.of(409, "INVALID_STATE", message); }
  private Map<String, Object> row(ResultSet result, int number) throws java.sql.SQLException {
    var value = new LinkedHashMap<String, Object>();
    for (int i = 1; i <= result.getMetaData().getColumnCount(); i++) {
      Object item = result.getObject(i);
      value.put(result.getMetaData().getColumnLabel(i), item instanceof OffsetDateTime time ? time.toString() : item);
    }
    return value;
  }
  private static int limit(Integer value, int fallback) { return Math.min(MAX, Math.max(1, value == null ? fallback : value)); }
  private void visibleBank(long user, long bank) {
    new ContentAccess(db).bank(user, bank);
  }
  private static String sessions() {
    return "select s.id,s.user_id,s.bank_id,s.mode session_type,s.status," +
        "(select count(*) from practice_session_questions q where q.session_id=s.id) question_count," +
        "(select count(*) from practice_answers a where a.session_id=s.id) answered_count," +
        "(select count(*) from practice_answers a where a.session_id=s.id and a.is_correct) correct_count," +
        "(select count(*) from practice_answers a where a.session_id=s.id and a.is_correct=false) wrong_count," +
        "(select coalesce(sum(score),0) from practice_answers a where a.session_id=s.id) score,s.started_at,s.completed_at,s.updated_at from practice_sessions s";
  }
  private Map<String, Object> session(long user, long id) {
    new ContentAccess(db).session(user, id);
    var rows = db.query(sessions() + " where s.id=? and s.user_id=?", this::row, id, user);
    if (rows.isEmpty()) throw ApiException.of(404, "NOT_FOUND", "Practice session not found");
    return hideSummary(rows.getFirst());
  }
  public Map<String, Object> get(long user, long sessionId) { return session(user, sessionId); }

  @Transactional
  public Map<String, Object> start(long user, long bank, String sessionType, Integer requested, String mode, String type, boolean all) {
    visibleBank(user, bank);
    String selected = mode == null ? "" : mode.trim();
    String legacy = sessionType == null ? "" : sessionType.trim();
    if (!Set.of("", "practice", "review", "exam").contains(legacy) || !Set.of("", "all", "wrong", "by_type", "exam").contains(selected)) throw bad("Invalid practice mode");
    if (selected.isEmpty()) selected = "review".equals(legacy) ? "wrong" : "exam".equals(legacy) ? "exam" : "all";
    if ("by_type".equals(selected) && (type == null || type.isBlank())) throw bad("Question type is required for type-based practice");
    int count = all || ("all".equals(selected) && (requested == null || requested < 1)) ? MAX : limit(requested, 1);
    String stored = "by_type".equals(selected) ? "type" : selected;
    var ids = db.queryForList("with items as (select l.question_id,l.sort_order from bank_question_links l join questions q on q.id=l.question_id where l.bank_id=? and l.status='active' and q.status='active' union select gql.question_id,gl.sort_order from bank_group_links gl join question_groups g on g.id=gl.group_id join group_question_links gql on gql.group_id=g.id join questions q on q.id=gql.question_id where gl.bank_id=? and gl.status='active' and g.status='active' and q.status='active'), ranked as (select distinct on (i.question_id) i.question_id,i.sort_order,q.question_type_id,coalesce(s.wrong_count,0) wrong_count from items i join questions q on q.id=i.question_id left join user_question_stats s on s.question_id=i.question_id and s.bank_id=? and s.user_id=? order by i.question_id,i.sort_order) select question_id from ranked where (?<>'type' or question_type_id=?) and (?<>'wrong' or wrong_count>0) order by case when ?='wrong' then wrong_count else 0 end desc,case when ?='exam' then md5(question_id::text||?::text||current_date::text) else '' end,sort_order,question_id limit ?", Long.class, bank, bank, bank, user, stored, type == null ? "" : type.trim(), stored, stored, stored, user, count);
    if (ids.isEmpty()) throw state("wrong".equals(stored) ? "No wrong questions are available for review" : "No active questions are available for practice");
    long id = db.queryForObject("insert into practice_sessions(user_id,bank_id,mode) values(?,?,?) returning id", Long.class, user, bank, stored);
    for (int i = 0; i < ids.size(); i++) db.update("insert into practice_session_questions(session_id,question_id,position) values(?,?,?)", id, ids.get(i), i + 1);
    return session(user, id);
  }
  private List<Long> queue(long session) { return db.queryForList("select question_id from practice_session_questions where session_id=? order by position", Long.class, session); }
  public Map<String, Object> list(long user, String status, String cursor, Integer requested, String updated) {
    if (status == null) status = "";
    if (!Set.of("", "active", "completed", "abandoned").contains(status)) throw bad("status must be one of active, completed, abandoned");
    int size = Math.min(100, Math.max(1, requested == null ? 20 : requested)), offset = PageSupport.cursor(cursor);
    var rows = db.query(sessions() + " where s.user_id=? and exists(select 1 from question_banks b where b.id=s.bank_id and " + ContentAccess.bankVisible("b", user) + ") and not exists(select 1 from practice_session_questions sq where sq.session_id=s.id and not (" + ContentAccess.questionInBank("s.bank_id", "sq.question_id", user, true) + ")) and (?='' or s.status=?) and (?='' or s.updated_at>=?::timestamptz) order by s.started_at desc,s.id desc limit ? offset ?", this::row, user, status, status, updated == null ? "" : updated, updated == null ? "" : updated, size + 1, offset);
    rows.forEach(PracticeService::hideSummary);
    return page(rows, offset, size);
  }
  private Map<String, Object> page(List<Map<String, Object>> rows, int offset, int size) {
    boolean more = rows.size() > size; if (more) rows = rows.subList(0, size);
    return Map.of("items", rows, "meta", Map.of("pagination", Map.of("cursor", more ? PageSupport.next(offset, size) : "", "limit", size, "hasMore", more)));
  }
  public List<Map<String, Object>> questions(long user, long session) { var value = session(user, session); return questionRows(value, queue(session), 0, Integer.MAX_VALUE); }
  public Map<String, Object> questionPage(long user, long id, Integer requested) {
    var value = session(user, id); var ids = queue(id);
    var answers = db.query("select question_id,is_correct from practice_answers where user_id=? and session_id=?", (r, n) -> { var answer = new LinkedHashMap<String, Object>(); answer.put("id", r.getLong(1)); answer.put("correct", r.getObject(2)); return answer; }, user, id);
    var answered = new HashSet<Long>(); for (var answer : answers) answered.add((Long) answer.get("id"));
    int index = requested == null ? 0 : Math.max(0, Math.min(requested, Math.max(0, ids.size() - 1)));
    if (requested == null) for (int i = 0; i < ids.size(); i++) if (!answered.contains(ids.get(i))) { index = i; break; }
    var rows = questionRows(value, ids, index, 1); Map<String, Object> answer = rows.isEmpty() ? null : answer(user, id, ids.get(index));
    if (answer != null && (!"exam".equals(value.get("session_type")) || "completed".equals(value.get("status")))) rows.getFirst().put("analysis", answer.get("analysis"));
    answer = feedback(value, answer);
    var progress = new ArrayList<Map<String, Object>>();
    for (int i = 0; i < ids.size(); i++) { Long question = ids.get(i); Object correct = null; for (var submitted : answers) if (submitted.get("id").equals(question)) { correct = submitted.get("correct"); break; } if (hiddenExam(value)) correct = null; var item = new LinkedHashMap<String, Object>(); item.put("index", i); item.put("questionId", question); item.put("isAnswered", answered.contains(question)); item.put("isCorrect", correct); progress.add(item); }
    var out = new LinkedHashMap<String, Object>(); out.put("session", value); out.put("question", rows.isEmpty() ? null : rows.getFirst()); out.put("questionIndex", rows.isEmpty() ? 0 : index); out.put("total", ids.size()); out.put("answeredCount", answers.size()); out.put("progress", progress); out.put("result", answer); out.put("previousIndex", index > 0 ? index - 1 : null); out.put("nextIndex", index < ids.size() - 1 ? index + 1 : null); return out;
  }
  private List<Map<String, Object>> questionRows(Map<String, Object> session, List<Long> ids, int offset, int take) {
    if (ids.isEmpty() || offset >= ids.size()) return List.of(); var wanted = ids.subList(offset, Math.min(ids.size(), offset + take));
    var rows = db.query("select q.id question_id,q.subject_id,q.question_type_id,q.answer_mode,q.choice_variant,q.stem,null::text analysis,q.status question_status from questions q where q.id=any(?::bigint[])", this::row, (Object) wanted.toArray(Long[]::new));
    var byId = new HashMap<Long, Map<String, Object>>(); for (var row : rows) { long question = ((Number) row.get("question_id")).longValue(); row.put("options", db.query("select id,question_id,option_label,sort_order,content from question_options where question_id=? order by sort_order", this::row, question)); var submitted = feedback(session, answer(((Number) session.get("user_id")).longValue(), ((Number) session.get("id")).longValue(), question)); if (submitted != null) { row.put("analysis", submitted.get("analysis")); row.put("result", submitted); } byId.put(question, row); }
    return wanted.stream().map(byId::get).filter(Objects::nonNull).toList();
  }
  private Map<String, Object> answer(long user, long session, long question) { var rows = db.query("select a.id,a.user_id,a.session_id,a.bank_id,a.question_id,a.answer_key_id,a.answer_payload,a.is_correct,a.score,a.max_score,a.answered_at,k.answer_payload answer_key_payload,k.explanation_payload explanation_payload,q.analysis from practice_answers a join question_answer_keys k on k.id=a.answer_key_id join questions q on q.id=a.question_id where a.user_id=? and a.session_id=? and a.question_id=?", this::row, user, session, question); return rows.isEmpty() ? null : rows.getFirst(); }
  @Transactional
  public Map<String, Object> submit(long user, long session, long question, Map<String, Object> payload, Integer duration) {
    if (duration != null && duration < 0) throw bad("durationMs must be non-negative"); var value = this.session(user, session); var old = answer(user, session, question); if (old != null) return feedback(value, old);
    if (!"active".equals(value.get("status"))) throw state("Practice session is not active"); if (!queue(session).contains(question)) throw ApiException.of(404, "NOT_FOUND", "Question is not part of this practice session");
    var modes = db.query("select answer_mode from questions where id=?", (r, n) -> r.getString(1), question); if (modes.isEmpty()) throw ApiException.of(404, "NOT_FOUND", "Question is not part of this practice session");
    validate(modes.getFirst(), payload); var keys = db.query("select id,answer_payload from question_answer_keys where question_id=? and is_primary", this::row, question); if (keys.isEmpty()) throw state("Question has no primary answer key");
    Boolean correct = grader.grade(modes.getFirst(), map(keys.getFirst().get("answer_payload")), payload); String body = encode(payload);
    var inserted = db.query("insert into practice_answers(session_id,user_id,bank_id,question_id,answer_key_id,answer_payload,is_correct,score,max_score) values(?,?,?,?,?,?::jsonb,?,?,?) on conflict(session_id,question_id) do nothing returning id,user_id,session_id,bank_id,question_id,answer_key_id,answer_payload,is_correct,score,max_score,answered_at", this::row, session, user, value.get("bank_id"), question, keys.getFirst().get("id"), body, correct, correct == null ? null : (correct ? 1d : 0d), 1d);
    if (!inserted.isEmpty()) bump(user, ((Number) value.get("bank_id")).longValue()); return feedback(value, answer(user, session, question));
  }
  public static boolean hiddenExam(Map<String, Object> session) { return "exam".equals(session.get("session_type")) && !"completed".equals(session.get("status")); }
  public static Map<String, Object> hideSummary(Map<String, Object> session) {
    if (hiddenExam(session)) for (String field : List.of("correct_count", "wrong_count", "score")) if (session.containsKey(field)) session.put(field, null);
    return session;
  }
  private static Map<String, Object> feedback(Map<String, Object> session, Map<String, Object> answer) {
    if (answer == null || !hiddenExam(session)) return answer;
    var hidden = new LinkedHashMap<>(answer);
    for (String field : List.of("answer_key_id", "is_correct", "score", "max_score", "answer_key_payload", "explanation_payload", "analysis")) hidden.put(field, null);
    return hidden;
  }
  private void validate(String mode, Map<String, Object> payload) { Object value = payload == null ? null : payload.get("value"); if ("choice".equals(mode) && selected(payload).isEmpty()) throw bad("Select at least one option before submitting"); if ("true_false".equals(mode) && !(value instanceof Boolean)) throw bad("Select true or false before submitting"); if ("fill_blank".equals(mode) && values(payload).isEmpty()) throw bad("Fill at least one blank before submitting"); if ("short_answer".equals(mode) && (!(value instanceof String) || ((String) value).trim().isEmpty())) throw bad("Answer text is required before submitting"); }
  private List<String> selected(Map<String, Object> payload) { Object value = payload == null ? null : payload.get("selected"); if (value instanceof Collection<?> items) return items.stream().map(Object::toString).map(String::trim).filter(v -> !v.isEmpty()).toList(); return value == null ? List.of() : List.of(value.toString().trim()); }
  private List<String> values(Map<String, Object> payload) { Object value = payload == null ? null : payload.get("value"); if (value instanceof Collection<?> items) return items.stream().map(Object::toString).map(v -> v.trim().toLowerCase().replaceAll("\\s+", " ")).filter(v -> !v.isEmpty()).toList(); return value == null ? List.of() : List.of(value.toString().trim().toLowerCase()); }
  @SuppressWarnings("unchecked") private Map<String, Object> map(Object value) { try { return value instanceof Map<?, ?> map ? (Map<String, Object>) map : json.readValue(String.valueOf(value), new TypeReference<Map<String, Object>>() {}); } catch (Exception error) { return Map.of(); } }
  private String encode(Object value) { try { return json.writeValueAsString(value == null ? Map.of() : value); } catch (Exception error) { throw bad("Invalid answer payload"); } }
  @Transactional public Map<String, Object> complete(long user, long id, String status) { session(user, id); var rows = db.query("update practice_sessions set status=?,completed_at=now() where id=? and user_id=? and status='active' returning id", this::row, status, id, user); if (rows.isEmpty()) throw ApiException.of(404, "NOT_FOUND", "Active practice session not found"); var value = session(user, id); bump(user, ((Number) value.get("bank_id")).longValue()); return value; }
  public List<Map<String, Object>> results(long user, long id) { var value = session(user, id); if ("active".equals(value.get("status"))) throw state("Complete the practice session before viewing results"); var rows = db.query("select a.*,q.stem,q.answer_mode,q.analysis,k.answer_payload answer_key_payload,k.explanation_payload explanation_payload from practice_answers a join questions q on q.id=a.question_id join question_answer_keys k on k.id=a.answer_key_id where a.user_id=? and a.session_id=? order by a.answered_at,a.id", this::row, user, id); return rows.stream().map(answer -> feedback(value, answer)).toList(); }
  public void bump(long user, long bank) { try { redis.opsForValue().increment("practiq:cache-version:analytics:" + user); redis.opsForValue().increment("practiq:cache-version:bank-analytics:" + bank); } catch (Exception ignored) {} }
}
