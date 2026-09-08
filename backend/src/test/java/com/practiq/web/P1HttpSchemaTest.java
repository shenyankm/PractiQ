package com.practiq.web;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.practiq.auth.AuthService;
import com.practiq.auth.WeChatClient;
import com.practiq.common.ApiExceptionHandler;
import com.practiq.config.WebFilters;
import com.practiq.service.*;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.request.AbstractMockHttpServletRequestBuilder;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/** Only db/api_schema_smoke.sh's one-use PostgreSQL container may run these HTTP/database regressions. */
@EnabledIfEnvironmentVariable(named = "PRACTIQ_DISPOSABLE_DB", matches = "true")
class P1HttpSchemaTest {
  private static final java.util.List<com.zaxxer.hikari.HikariDataSource> POOLS = new java.util.ArrayList<>();
  @org.junit.jupiter.api.AfterEach void closePools() { POOLS.forEach(com.zaxxer.hikari.HikariDataSource::close); POOLS.clear(); }
  private static final ObjectMapper JSON = new ObjectMapper();
  private record Identity(long id, String header, String refresh) {}
  private static final class Fixture {
    final JdbcTemplate db;
    final DataSourceTransactionManager manager;
    final AuthService auth;
    final StringRedisTemplate redis = mock(StringRedisTemplate.class);
    final ValueOperations<String, String> values;
    final PracticeService practice;
    final AiTaskService tasks;
    final IdempotentWrites writes;
    final MockMvc mvc;
    final Identity owner, member;
    final long bank, question, group, studyGroup, media;
    final String type;
    Fixture() throws Exception { this("/unused-p1-storage"); }
    @SuppressWarnings("unchecked") Fixture(String mount) throws Exception {
      var source = new com.zaxxer.hikari.HikariDataSource(); source.setJdbcUrl(System.getenv("POSTGRES_URL")); source.setUsername("postgres"); source.setPassword("postgres"); source.setMaximumPoolSize(8); source.setMinimumIdle(0); POOLS.add(source);
      db = new JdbcTemplate(source); manager = new DataSourceTransactionManager(source);
      auth = new AuthService(db, new MembershipService(), JSON, "p1-test-secret");
      owner = login("owner-" + UUID.randomUUID()); member = login("member-" + UUID.randomUUID());
      db.update("update users set paid_pro_at=now() where id=?", owner.id);
      values = mock(ValueOperations.class); when(redis.opsForValue()).thenReturn(values); when(values.increment(anyString())).thenReturn(1L);
      bank = db.queryForObject("insert into question_banks(owner_user_id,subject_id,name) values(?,'general','P1 private') returning id", Long.class, owner.id);
      type = "p1-" + UUID.randomUUID();
      db.update("insert into question_types(id,subject_id,display_name,answer_mode) values(?,'general','P1','true_false')", type);
      question = db.queryForObject("insert into questions(owner_user_id,subject_id,question_type_id,answer_mode,stem,analysis) values(?,'general',?,'true_false','P1 secret stem','P1 secret analysis') returning id", Long.class, owner.id, type);
      db.update("insert into question_answer_keys(question_id,answer_mode,answer_payload,explanation_payload) values(?,'true_false','{\"answer\":true}','{\"text\":\"P1 secret explanation\"}')", question);
      db.update("update questions set status='active' where id=?", question);
      group = db.queryForObject("insert into question_groups(owner_user_id,subject_id,title) values(?,'general','P1 group') returning id", Long.class, owner.id);
      db.update("insert into group_question_links(group_id,question_id,sort_order) values(?,?,1)", group, question);
      db.update("update question_groups set status='active' where id=?", group);
      db.update("insert into bank_group_links(bank_id,group_id,sort_order,status) values(?,?,1,'active')", bank, group);
      studyGroup = db.queryForObject("insert into study_groups(owner_user_id,name) values(?,'P1 study') returning id", Long.class, owner.id);
      db.update("insert into study_group_members(group_id,user_id,status) values(?,?,'accepted'),(?,?,'accepted')", studyGroup, owner.id, studyGroup, member.id);
      db.update("insert into study_group_banks(group_id,bank_id,linked_by) values(?,?,?)", studyGroup, bank, owner.id);
      db.update("insert into user_bank_favorites(user_id,bank_id) values(?,?)", member.id, bank);
      media = db.queryForObject("insert into media_assets(created_by,storage_path,original_name,media_type,mime_type,size_bytes,checksum_sha256) values(?,?,'x.png','image','image/png',8,repeat('0',64)) returning id", Long.class, owner.id, "p1/" + UUID.randomUUID());
      db.update("insert into question_media_links(question_id,media_id,sort_order) values(?,?,1)", question, media);
      var mediaService = new MediaService(db, mount);
      practice = transactional(new PracticeService(db, redis, JSON, new GradingService()), manager);
      var constructor = AiTaskService.class.getDeclaredConstructor(JdbcTemplate.class, ObjectMapper.class, java.math.BigDecimal.class, java.math.BigDecimal.class, java.math.BigDecimal.class, java.math.BigDecimal.class);
      constructor.setAccessible(true);
      tasks = transactional(constructor.newInstance(db, JSON, java.math.BigDecimal.ONE, java.math.BigDecimal.ONE, java.math.BigDecimal.ONE, java.math.BigDecimal.ONE), manager);
      writes = new IdempotentWrites(db, manager, JSON, new ReplayAuthorization(db, JSON, mediaService), new IdempotencyAdmission(source));
      var filter = new WebFilters(redis, JSON, auth, writes);
      mvc = MockMvcBuilders.standaloneSetup(transactional(new ContentController(db, auth, JSON), manager), new PracticeController(auth, practice),
          new AnalyticsSearchController(db, auth), transactional(new BankManagementController(db, auth), manager), transactional(new StudyGroupController(db, auth), manager),
          new MediaController(auth, mediaService), new AiTaskController(auth, tasks),
          new ImportController(auth, new ImportService(db, "/unused-p1-storage", java.math.BigDecimal.ONE, "", ""))).setControllerAdvice(new ApiExceptionHandler()).addFilters(filter).build();
    }
    Identity login(String openid) {
      var login = new TransactionTemplate(manager).execute(ignored -> auth.login(new WeChatClient.Session(openid, null)));
      var user = (Map<?, ?>) login.get("user"); var tokens = (Map<?, ?>) login.get("tokens");
      return new Identity(((Number) user.get("id")).longValue(), "Bearer " + tokens.get("accessToken"), String.valueOf(tokens.get("refreshToken")));
    }
    JsonNode request(AbstractMockHttpServletRequestBuilder<?> request, Identity user, int status) throws Exception {
      var result = mvc.perform(request.header("Authorization", user.header)).andReturn();
      var response = result.getResponse();
      assertEquals(status, response.getStatus(), response.getContentAsString() + " " + result.getResolvedException());
      return response.getContentAsByteArray().length == 0 ? JSON.createObjectNode() : JSON.readTree(response.getContentAsByteArray());
    }
    JsonNode write(String path, String body, Identity user, int status, String key) throws Exception {
      return request(post(path).header("Idempotency-Key", key).contentType("application/json").content(body), user, status);
    }
    long start(String mode, Identity user) throws Exception {
      return write("/api/v1/practice-sessions", "{\"allQuestions\":false,\"bankId\":" + bank + ",\"mode\":\"" + mode + "\",\"questionTypeId\":\"" + type + "\"}", user, 201, UUID.randomUUID().toString()).at("/data/id").asLong();
    }
    String answer() { return "{\"questionId\":" + question + ",\"answerPayload\":{\"value\":false}}"; }
  }

  @SuppressWarnings("unchecked")
  private static <T> T transactional(T target, DataSourceTransactionManager manager) {
    var proxy = new org.springframework.aop.framework.ProxyFactory(target);
    proxy.setProxyTargetClass(true);
    var interceptor = new org.springframework.transaction.interceptor.TransactionInterceptor();
    interceptor.setTransactionManager(manager);
    interceptor.setTransactionAttributeSource(new org.springframework.transaction.annotation.AnnotationTransactionAttributeSource());
    proxy.addAdvice(interceptor);
    return (T) proxy.getProxy();
  }

  private static void hidden(JsonNode value) {
    for (String field : List.of("analysis", "answer_keys", "answer_key_id", "answer_key_payload", "explanation_payload", "is_correct", "score", "max_score"))
      assertTrue(value.path(field).isNull() || value.path(field).isMissingNode(), field + ": " + value);
  }

  @Test void feedbackIsModeOnlyAcrossEverySessionHttpExitAndOwnerManagementIsSeparate() throws Exception {
    var f = new Fixture();
    hidden(f.request(get("/api/v1/questions/" + f.question), f.owner, 200).path("data"));
    assertEquals("P1 secret analysis", f.request(get("/api/v1/questions/" + f.question + "/management"), f.owner, 200).at("/data/analysis").asText());
    f.request(get("/api/v1/questions/" + f.question + "/management"), f.member, 404);
    hidden(f.request(get("/api/v1/banks/" + f.bank + "/items?includeAnswers=true"), f.owner, 200).at("/data/0"));
    hidden(f.request(get("/api/v1/search/questions?bankId=" + f.bank), f.owner, 200).at("/data/0"));
    for (String mode : List.of("all", "wrong", "by_type", "exam")) {
      long session = f.start(mode, f.owner);
      String path = "/api/v1/practice-sessions/" + session;
      hidden(f.request(get(path + "/question-page"), f.owner, 200).at("/data/question"));
      var answer = f.write(path + "/answers", f.answer(), f.owner, 201, "answer");
      assertEquals(answer, f.write(path + "/answers", f.answer(), f.owner, 201, "answer"));
      var duplicate = f.write(path + "/answers", f.answer(), f.owner, 201, "another-key");
      if (mode.equals("exam")) {
        hidden(answer.path("data")); hidden(duplicate.path("data"));
        hidden(f.request(get(path + "/questions"), f.owner, 200).at("/data/0/result"));
        var page = f.request(get(path + "/question-page"), f.owner, 200);
        hidden(page.at("/data/result")); assertTrue(page.at("/data/progress/0/isCorrect").isNull());
        var summary = f.request(get(path), f.owner, 200).path("data");
        assertTrue(summary.path("correct_count").isNull()); assertTrue(summary.path("wrong_count").isNull());
        f.request(get(path + "/results"), f.owner, 409);
      } else assertEquals("P1 secret analysis", answer.at("/data/analysis").asText());
      f.write(path + "/complete", "", f.owner, 200, "complete");
      assertEquals("P1 secret analysis", f.request(get(path + "/results"), f.owner, 200).at("/data/0/analysis").asText());
      assertEquals("P1 secret analysis", f.request(get(path + "/questions"), f.owner, 200).at("/data/0/analysis").asText());
    }
    long abandoned = f.start("exam", f.member); String path = "/api/v1/practice-sessions/" + abandoned;
    f.write(path + "/answers", f.answer(), f.member, 201, "answer");
    hidden(f.write(path + "/abandon", "", f.member, 200, "abandon").path("data"));
    hidden(f.request(get(path + "/results"), f.member, 200).at("/data/0"));
    hidden(f.write(path + "/answers", f.answer(), f.member, 201, "duplicate").path("data"));
    hidden(f.request(get(path + "/question-page"), f.member, 200).at("/data/result"));
    assertEquals(0, f.request(get("/api/v1/analytics/me/summary"), f.member, 200).at("/data/wrong").asInt());
  }

  @Test void revocationAndArchivalCloseOldSessionsFavoritesWeakQuestionsSearchAndMedia() throws Exception {
    for (String revoked : List.of("left", "removed", "unlinked", "banned", "deleted", "question", "group", "link")) {
      var f = new Fixture(); long session = f.start("all", f.member); String path = "/api/v1/practice-sessions/" + session;
      f.write(path + "/answers", f.answer(), f.member, 201, "answer");
      assertEquals(1, f.request(get("/api/v1/analytics/me/snapshot"), f.member, 200).at("/data/weakQuestions").size());
      f.request(get("/api/v1/media/" + f.media), f.member, 200);
      switch (revoked) {
        case "left" -> f.write("/api/v1/study-groups/" + f.studyGroup + "/leave", "", f.member, 204, "leave");
        case "removed" -> f.request(delete("/api/v1/study-groups/" + f.studyGroup + "/members/" + f.member.id).header("Idempotency-Key", "remove"), f.owner, 204);
        case "unlinked" -> f.request(delete("/api/v1/study-groups/" + f.studyGroup + "/banks/" + f.bank).header("Idempotency-Key", "unlink"), f.owner, 204);
        case "banned" -> { f.db.update("update question_banks set status='public' where id=?", f.bank); f.db.update("update question_banks set status='banned' where id=?", f.bank); }
        case "deleted" -> f.db.update("update question_banks set deleted_at=now() where id=?", f.bank);
        case "question" -> f.db.update("update questions set status='archived' where id=?", f.question);
        case "group" -> f.db.update("update question_groups set status='archived' where id=?", f.group);
        case "link" -> f.db.update("update bank_group_links set status='archived' where bank_id=?", f.bank);
      }
      for (String suffix : List.of("", "/questions", "/question-page", "/results")) f.request(get(path + suffix), f.member, 404);
      f.write(path + "/answers", f.answer(), f.member, 404, "answer"); // cached response must not bypass revocation
      f.write(path + "/answers", f.answer(), f.member, 404, "new");
      f.write(path + "/complete", "", f.member, 404, "complete");
      f.request(get("/api/v1/questions/" + f.question), f.member, 404);
      f.request(get("/api/v1/media/" + f.media), f.member, 404);
      assertEquals(0, f.request(get("/api/v1/search/questions?bankId=" + f.bank), f.member, 200).path("data").size());
      var snapshot = f.request(get("/api/v1/analytics/me/snapshot"), f.member, 200).path("data");
      assertEquals(0, snapshot.path("weakQuestions").size()); assertEquals(0, snapshot.path("recentSessions").size());
      if (List.of("left", "removed", "unlinked", "banned", "deleted").contains(revoked)) assertEquals(0, f.request(get("/api/v1/banks?scope=favorites"), f.member, 200).path("data").size());
      if (revoked.equals("left")) f.write("/api/v1/study-groups/" + f.studyGroup + "/leave", "", f.member, 204, "leave");
      if (revoked.equals("banned")) {
        f.request(patch("/api/v1/banks/" + f.bank).header("Idempotency-Key", "unban").contentType("application/json").content("{\"isPublic\":true}"), f.owner, 404);
        f.request(get("/api/v1/questions/" + f.question + "/management"), f.owner, 404);
        f.request(get("/api/v1/media/" + f.media), f.owner, 404);
        assertEquals("banned", f.db.queryForObject("select status from question_banks where id=?", String.class, f.bank));
      }
      assertEquals(1, f.db.queryForObject("select count(*) from practice_answers where session_id=?", Integer.class, session));
    }
  }

  @Test void independentResourcesCanUseAnotherLegalBankButAnExplicitSessionCannot() throws Exception {
    var f = new Fixture(); long session = f.start("all", f.member);
    long other = f.db.queryForObject("insert into question_banks(owner_user_id,subject_id,name) values(?,'general','Other legal path') returning id", Long.class, f.owner.id);
    f.db.update("update question_banks set status='public' where id=?", other);
    f.db.update("insert into bank_question_links(bank_id,question_id,sort_order,status) values(?,?,1,'active')", other, f.question);
    f.db.update("update question_banks set status='public' where id=?", f.bank); f.db.update("update question_banks set status='banned' where id=?", f.bank);
    f.request(get("/api/v1/practice-sessions/" + session), f.member, 404);
    f.request(get("/api/v1/questions/" + f.question), f.member, 200);
    f.request(get("/api/v1/media/" + f.media), f.member, 200);
    f.request(get("/api/v1/questions/" + f.question + "/management"), f.owner, 200);
    f.request(patch("/api/v1/questions/" + f.question).header("Idempotency-Key", "edit").contentType("application/json").content("{\"stem\":\"Changed legally\"}"), f.owner, 200);
    assertEquals("banned", f.db.queryForObject("select status from question_banks where id=?", String.class, f.bank));
    long draft = f.db.queryForObject("insert into questions(owner_user_id,subject_id,question_type_id,answer_mode,stem) values(?,'general',?,'true_false','Unlinked draft') returning id", Long.class, f.owner.id, f.type);
    f.request(get("/api/v1/questions/" + draft + "/management"), f.owner, 200);
  }

  @Test void durableHttpReplaySurvivesTokenRotationRejectsChangedBodiesAndRevokedAuthentication() throws Exception {
    var f = new Fixture(); String body = "{\"name\":\"Durable bank\",\"subject\":\"general\"}";
    var first = f.write("/api/v1/banks", body, f.member, 201, "stable");
    var rotated = new TransactionTemplate(f.manager).execute(ignored -> f.auth.refresh(f.member.refresh));
    var current = new Identity(f.member.id, "Bearer " + ((Map<?, ?>) rotated.get("tokens")).get("accessToken"), "");
    assertEquals(first, f.write("/api/v1/banks", body, current, 201, "stable"));
    assertNotEquals(first.at("/data/id"), f.write("/api/v1/banks", body, f.owner, 201, "stable").at("/data/id"));
    f.write("/api/v1/banks", body.replace("Durable", "Different"), current, 409, "stable");
    assertEquals(1, f.db.queryForObject("select count(*) from question_banks where owner_user_id=?", Integer.class, current.id));
    var record = f.db.queryForMap("select extract(epoch from expires_at-created_at) lifetime from request_idempotency where user_id=? and idempotency_key='stable'", current.id);
    assertEquals(86400, ((Number) record.get("lifetime")).intValue());
    f.db.update("update request_idempotency set created_at=now()-interval '25 hours',expires_at=now()-interval '1 hour' where user_id=?", current.id);
    var next = f.write("/api/v1/banks", body, current, 201, "stable");
    assertNotEquals(first.at("/data/id"), next.at("/data/id"));
    long created = next.at("/data/id").asLong();
    f.db.update("update question_banks set status='public' where id=?", created); f.db.update("update question_banks set status='banned' where id=?", created);
    f.write("/api/v1/banks", body, current, 404, "stable");
    f.db.update("update users set status='inactive' where id=?", current.id);
    f.write("/api/v1/banks", body, current, 401, "stable");
    assertEquals(0, f.db.queryForObject("select count(*) from auth_sessions where user_id=? and revoked_at is null", Integer.class, current.id));
    new TransactionTemplate(f.manager).executeWithoutResult(ignored -> f.auth.logout(f.owner.id));
    f.write("/api/v1/banks", body, f.owner, 401, "stable");
  }

  @Test void noncanonicalBankPathsCannotBypassKeyOrDependencyAdmission() throws Exception {
    var f = new Fixture();
    String body = "{\"name\":\"Must not be created\",\"subject\":\"general\"}";
    for (boolean unavailable : List.of(false, true)) {
      if (unavailable) when(f.values.increment(contains("idempotency-availability"))).thenThrow(new IllegalStateException("Redis down"));
      for (String path : List.of("/api/v1;v=1/banks", "/api/v1%3Bv=1/banks", "/api/v%31/banks", "/api%2Fv1/banks", "/api/v1%253Bv=1/banks")) {
        for (boolean keyed : List.of(false, true)) {
          var request = post(java.net.URI.create(path)).contentType("application/json").content(body);
          if (keyed) request.header("Idempotency-Key", "alias");
          assertEquals("INVALID_PATH", f.request(request, f.member, 400).at("/error/code").asText());
        }
      }
      f.request(post("/api/v1/banks").contentType("application/json").content(body), f.member, 422);
    }
    assertEquals("IDEMPOTENCY_UNAVAILABLE", f.write("/api/v1/banks", body, f.member, 503, "canonical").at("/error/code").asText());
    assertEquals(0, f.db.queryForObject("select count(*) from question_banks where owner_user_id=?", Integer.class, f.member.id));
    assertEquals(0, f.db.queryForObject("select count(*) from request_idempotency where user_id=?", Integer.class, f.member.id));
  }

  @Test void aiResultsRetainProvenanceAndReportsExcludeUnreleasedExamEvidence() throws Exception {
    for (String revoke : List.of("banned", "left", "deleted")) {
      var f = new Fixture();
      f.db.update("update users set paid_pro_at=now() where id=?", f.member.id);
      f.db.update("insert into credit_accounts(user_id,balance) values(?,100),(?,100)", f.owner.id, f.member.id);
      long exam = f.start("exam", f.member); String examPath = "/api/v1/practice-sessions/" + exam;
      f.write(examPath + "/answers", f.answer(), f.member, 201, "answer");
      f.write("/api/v1/analytics/report-tasks", "{}", f.member, 409, "active-exam-report");
      f.write(examPath + "/abandon", "", f.member, 200, "abandon");
      f.write("/api/v1/analytics/report-tasks", "{}", f.member, 409, "abandoned-exam-report");
      long practice = f.start("all", f.member);
      f.write("/api/v1/practice-sessions/" + practice + "/answers", f.answer(), f.member, 201, "answer");
      long report = f.write("/api/v1/analytics/report-tasks", "{}", f.member, 201, "report").at("/data/id").asLong();
      assertEquals(1, f.db.queryForObject("select (request_payload->'stats'->>'attemptCount')::int from ai_tasks where id=?", Integer.class, report));
      assertEquals(1, f.db.queryForObject("select count(*) from ai_report_sources where task_id=?", Integer.class, report));
      long answer = f.write("/api/v1/questions/" + f.question + "/ai-answer-tasks", "", f.owner, 201, "ai-answer").at("/data/id").asLong();
      assertEquals(f.question, f.db.queryForObject("select source_question_id from ai_tasks where id=?", Long.class, answer));
      assertFalse(f.db.queryForObject("select request_payload::text from ai_tasks where id=?", String.class, answer).contains("questionId"));
      // Persist synthetic model results directly: this test never calls a real AI provider.
      for (long task : List.of(report, answer)) {
        f.db.update("update ai_tasks set status='running',started_at=now() where id=?", task);
        f.db.update("update ai_tasks set status='succeeded',finished_at=now(),result='{\"text\":\"Sensitive saved result\"}' where id=?", task);
      }
      f.request(get("/api/v1/ai-tasks/" + report), f.member, 200);
      f.request(get("/api/v1/ai-tasks/" + answer), f.owner, 200);
      long job = f.write("/api/v1/import-jobs", "{\"bankId\":" + f.bank + ",\"sourceType\":\"text\"}", f.owner, 201, "import").at("/data/id").asLong();
      if (revoke.equals("left")) f.write("/api/v1/study-groups/" + f.studyGroup + "/leave", "", f.member, 204, "leave");
      else if (revoke.equals("banned")) { f.db.update("update question_banks set status='public' where id=?", f.bank); f.db.update("update question_banks set status='banned' where id=?", f.bank); }
      else f.db.update("update question_banks set deleted_at=now() where id=?", f.bank);
      f.request(get("/api/v1/ai-tasks/" + report), f.member, 404);
      f.write("/api/v1/analytics/report-tasks", "{}", f.member, 404, "report");
      if (!revoke.equals("left")) {
        f.request(get("/api/v1/ai-tasks/" + answer), f.owner, 404);
        f.request(get("/api/v1/import-jobs/" + job + "/outputs"), f.owner, 404);
        f.request(get("/api/v1/import-jobs/" + job + "/stream"), f.owner, 404);
      }
    }
  }

  @Test void deletedQuestionAndLegacyUnscopedAiResultsFailClosed() throws Exception {
    var f = new Fixture();
    long task = f.db.queryForObject("insert into ai_tasks(user_id,kind,status,deadline_at,price_snapshot,estimated_credits,source_question_id,finished_at,result) values(?,'answer_generation','succeeded',now()+interval '1 minute','{}',1,?,now(),'{\"text\":\"Sensitive\"}') returning id", Long.class, f.owner.id, f.question);
    f.request(get("/api/v1/ai-tasks/" + task), f.owner, 200);
    f.db.update("delete from questions where id=?", f.question);
    assertEquals(f.question, f.db.queryForObject("select source_question_id from ai_tasks where id=?", Long.class, task));
    f.request(get("/api/v1/ai-tasks/" + task), f.owner, 404);
    long legacy = f.db.queryForObject("insert into ai_tasks(user_id,kind,status,deadline_at,price_snapshot,estimated_credits,finished_at,result) values(?,'answer_generation','succeeded',now()+interval '1 minute','{}',1,now(),'{\"text\":\"Unknown source\"}') returning id", Long.class, f.owner.id);
    f.request(get("/api/v1/ai-tasks/" + legacy), f.owner, 404);
  }

  @Test void activeImportStreamStopsAfterCurrentBankPermissionIsRevoked() throws Exception {
    var f = new Fixture();
    f.db.update("insert into credit_accounts(user_id,balance) values(?,100)", f.owner.id);
    long job = f.write("/api/v1/import-jobs", "{\"bankId\":" + f.bank + ",\"sourceType\":\"text\"}", f.owner, 201, "stream-job").at("/data/id").asLong();
    var stream = f.mvc.perform(get("/api/v1/import-jobs/" + job + "/stream").header("Authorization", f.owner.header)).andReturn();
    assertTrue(stream.getRequest().isAsyncStarted());
    f.db.update("update question_banks set status='public' where id=?", f.bank);
    f.db.update("update question_banks set status='banned' where id=?", f.bank);
    assertInstanceOf(com.practiq.common.ApiException.class, stream.getAsyncResult(4000));
    f.mvc.perform(asyncDispatch(stream));
  }

  @Test void admittedBusinessFailuresBindBodiesAndReplayTheOriginalError() throws Exception {
    var f = new Fixture();
    String invalid = "{\"name\":\"\",\"subject\":\"general\"}";
    var first = f.write("/api/v1/banks", invalid, f.member, 422, "invalid");
    // Request IDs can differ in headers, but the admitted error body is returned byte-for-byte.
    assertEquals(first, f.write("/api/v1/banks", invalid, f.member, 422, "invalid"));
    f.write("/api/v1/banks", "{\"name\":\"Corrected\",\"subject\":\"general\"}", f.member, 409, "invalid");
    assertEquals(1, f.db.queryForObject("select count(*) from request_idempotency where user_id=? and idempotency_key='invalid' and response_status=422", Integer.class, f.member.id));
    assertEquals(0, f.db.queryForObject("select count(*) from question_banks where owner_user_id=?", Integer.class, f.member.id));
    // Admission authorization fails before binding a key.
    f.write("/api/v1/questions/" + f.question + "/publish", "", f.member, 404, "forbidden");
    assertEquals(0, f.db.queryForObject("select count(*) from request_idempotency where user_id=? and idempotency_key='forbidden'", Integer.class, f.member.id));
    long session = f.start("all", f.member);
    String complete = "/api/v1/practice-sessions/" + session + "/complete";
    f.write(complete, "", f.member, 200, "first-complete");
    f.write(complete, "", f.member, 404, "already-completed");
    f.write(complete, "{}", f.member, 409, "already-completed");
  }

  @Test void multipartRetriesHashFileContentsNotRandomBoundaries() throws Exception {
    var mount = java.nio.file.Files.createTempDirectory("practiq-p1-media-");
    try {
      var f = new Fixture(mount.toString());
      byte[] png = new byte[] {(byte)137,80,78,71,13,10,26,10};
      var file = new org.springframework.mock.web.MockPart("file", "x.png", png);
      file.getHeaders().setContentType(org.springframework.http.MediaType.IMAGE_PNG);
      var first = f.request(multipart("/api/v1/media").part(file).header("Idempotency-Key", "upload").contentType("multipart/form-data;boundary=one"), f.member, 201);
      assertEquals(first, f.request(multipart("/api/v1/media").part(file).header("Idempotency-Key", "upload").contentType("multipart/form-data;boundary=two"), f.member, 201));
      var changed = new org.springframework.mock.web.MockPart("file", "x.png", java.util.Arrays.copyOf(png, 9));
      changed.getHeaders().setContentType(org.springframework.http.MediaType.IMAGE_PNG);
      f.request(multipart("/api/v1/media").part(changed).header("Idempotency-Key", "upload"), f.member, 409);
      assertEquals(1, f.db.queryForObject("select count(*) from media_assets where created_by=?", Integer.class, f.member.id));
      long asset = first.at("/data/id").asLong();
      var content = f.mvc.perform(get("/api/v1/media/" + asset + "/content").header("Authorization", f.member.header)).andReturn().getResponse();
      assertEquals(200, content.getStatus()); assertEquals("no-store", content.getHeader("Cache-Control")); assertArrayEquals(png, content.getContentAsByteArray());
    } finally {
      try (var files = java.nio.file.Files.walk(mount)) { for (var file : files.sorted(java.util.Comparator.reverseOrder()).toList()) java.nio.file.Files.delete(file); }
    }
  }

  @Test void multipartSameNameFileOrderIsBoundOnSuccessAndRetryableFailure() throws Exception {
    var mount = java.nio.file.Files.createTempDirectory("practiq-p1-multipart-order-");
    try {
      for (boolean failFirst : List.of(false, true)) {
        var storage = mount.resolve(failFirst ? "blocked-storage" : "storage");
        if (failFirst) java.nio.file.Files.createFile(storage);
        else java.nio.file.Files.createDirectory(storage);
        var f = new Fixture(storage.toString());
        byte[] png = new byte[] {(byte)137,80,78,71,13,10,26,10};
        var a = new org.springframework.mock.web.MockPart("file", "a.png", png);
        var b = new org.springframework.mock.web.MockPart("file", "b.png", java.util.Arrays.copyOf(png, 9));
        a.getHeaders().setContentType(org.springframework.http.MediaType.IMAGE_PNG);
        b.getHeaders().setContentType(org.springframework.http.MediaType.IMAGE_PNG);
        var first = f.request(multipart("/api/v1/media").part(a, b).header("Idempotency-Key", "ordered")
            .contentType("multipart/form-data;boundary=one"), f.member, failFirst ? 500 : 201);
        if (failFirst) {
          assertEquals("MEDIA_STORAGE_FAILED", first.at("/error/code").asText());
          assertEquals(1, f.db.queryForObject("select count(*) from request_idempotency where user_id=? and idempotency_key='ordered' and response_body is null", Integer.class, f.member.id));
          java.nio.file.Files.delete(storage);
          java.nio.file.Files.createDirectory(storage);
        } else assertEquals("a.png", first.at("/data/original_name").asText());
        var changed = f.request(multipart("/api/v1/media").part(b, a).header("Idempotency-Key", "ordered"), f.member, 409);
        assertEquals("IDEMPOTENCY_KEY_REUSED", changed.at("/error/code").asText());
        var recovered = f.request(multipart("/api/v1/media").part(a, b).header("Idempotency-Key", "ordered")
            .contentType("multipart/form-data;boundary=two"), f.member, 201);
        assertEquals("a.png", recovered.at("/data/original_name").asText());
        if (!failFirst) assertEquals(first, recovered);
        assertEquals(1, f.db.queryForObject("select count(*) from media_assets where created_by=?", Integer.class, f.member.id));
        assertEquals(1, f.db.queryForObject("select count(*) from request_idempotency where user_id=? and idempotency_key='ordered' and response_status=201", Integer.class, f.member.id));
      }
    } finally {
      try (var files = java.nio.file.Files.walk(mount)) { for (var file : files.sorted(java.util.Comparator.reverseOrder()).toList()) java.nio.file.Files.delete(file); }
    }
  }

  @Test void transactionLockAndResponsePersistenceAreAtomicIncludingConcurrentAndFailureCases() throws Exception {
    var f = new Fixture(); var entered = new CountDownLatch(1); var finish = new CountDownLatch(1);
    byte[] hash = new byte[] {1};
    try (var pool = Executors.newFixedThreadPool(2)) {
      var first = pool.submit(() -> f.writes.execute(f.member.id, "PATCH", "/api/v1/users/me", "concurrent", hash, new byte[0], () -> {
        f.db.update("update users set display_name='Exactly once' where id=?", f.member.id); entered.countDown();
        try { assertTrue(finish.await(10, TimeUnit.SECONDS)); } catch (InterruptedException error) { throw new RuntimeException(error); }
        return new IdempotentWrites.Result(200, "{\"data\":{}}".getBytes(StandardCharsets.UTF_8), Map.of());
      }));
      assertTrue(entered.await(5, TimeUnit.SECONDS));
      f.request(patch("/api/v1/users/me").header("Idempotency-Key", "concurrent").contentType("application/json").content("{}"), f.member, 409);
      var conflict = assertThrows(com.practiq.common.ApiException.class, () -> f.writes.execute(f.member.id, "PATCH", "/api/v1/users/me", "concurrent", hash, new byte[0], () -> { fail("Second writer ran"); return null; }));
      assertEquals("REQUEST_IN_PROGRESS", conflict.code); finish.countDown(); first.get(10, TimeUnit.SECONDS);
      f.writes.execute(f.member.id, "PATCH", "/api/v1/users/me", "concurrent", hash, new byte[0], () -> { fail("Replay executed business mutation"); return null; });
    }
    // Deferred DB failure at commit must roll back both mutation and response record.
    assertThrows(RuntimeException.class, () -> f.writes.execute(f.member.id, "PATCH", "/api/v1/users/me", "rollback", hash, new byte[0], () -> {
      f.db.update("update users set display_name='Must roll back' where id=?", f.member.id);
      f.db.update("update question_answer_keys set is_primary=false where question_id=?", f.question);
      return new IdempotentWrites.Result(200, new byte[0], Map.of());
    }));
    assertEquals("Exactly once", f.db.queryForObject("select display_name from users where id=?", String.class, f.member.id));
    assertEquals(1, f.db.queryForObject("select count(*) from request_idempotency where user_id=? and idempotency_key='rollback' and response_body is null", Integer.class, f.member.id));
    f.request(put("/api/v1/questions/" + f.question + "/answer-key").header("Idempotency-Key", "invalid-key")
        .contentType("application/json").content("{\"answerMode\":\"true_false\",\"answerPayload\":{}}"), f.owner, 503);
    assertEquals(1, f.db.queryForObject("select count(*) from question_answer_keys where question_id=?", Integer.class, f.question));
    assertEquals(1, f.db.queryForObject("select count(*) from request_idempotency where user_id=? and idempotency_key='invalid-key' and response_body is null", Integer.class, f.owner.id));
    f.request(put("/api/v1/questions/" + f.question + "/answer-key").header("Idempotency-Key", "invalid-key")
        .contentType("application/json").content("{\"answerMode\":\"true_false\",\"answerPayload\":{\"value\":true}}"), f.owner, 409);
    f.db.update("update questions set status='archived' where id=?", f.question);
    f.request(put("/api/v1/questions/" + f.question + "/answer-key").header("Idempotency-Key", "invalid-key")
        .contentType("application/json").content("{\"answerMode\":\"true_false\",\"answerPayload\":{}}"), f.owner, 200);
    assertEquals(2, f.db.queryForObject("select count(*) from question_answer_keys where question_id=?", Integer.class, f.question));
    when(f.values.increment(contains("idempotency-availability"))).thenThrow(new IllegalStateException("Redis down"));
    f.write("/api/v1/banks", "{\"name\":\"Offline\",\"subject\":\"general\"}", f.member, 503, "offline");
    assertEquals(0, f.db.queryForObject("select count(*) from question_banks where owner_user_id=?", Integer.class, f.member.id));
  }
}
