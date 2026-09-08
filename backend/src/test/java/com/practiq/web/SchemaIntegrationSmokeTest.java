package com.practiq.web;

import static org.junit.jupiter.api.Assertions.*;

import tools.jackson.databind.ObjectMapper;
import com.practiq.auth.AuthService;
import com.practiq.auth.FirstAdminBootstrapService;
import com.practiq.auth.WeChatClient;
import com.practiq.common.ApiException;
import com.practiq.service.GradingService;
import com.practiq.service.MembershipService;
import com.practiq.service.ImportService;
import com.practiq.service.MediaService;
import com.practiq.service.PracticeService;
import com.practiq.service.PaymentService;
import com.practiq.service.WeChatPayGateway;
import java.nio.file.Files;
import java.time.Instant;
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
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.mock.web.MockMultipartFile;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import static org.mockito.ArgumentMatchers.any;

@EnabledIfEnvironmentVariable(named = "POSTGRES_URL", matches = ".+")
class SchemaIntegrationSmokeTest {
  private JdbcTemplate db() {
    var source = new PGSimpleDataSource();
    source.setUrl(System.getenv("POSTGRES_URL"));
    source.setUser(System.getenv().getOrDefault("POSTGRES_USER", "postgres"));
    source.setPassword(System.getenv().getOrDefault("POSTGRES_PASSWORD", "postgres"));
    return new JdbcTemplate(source);
  }

  private void rollback(JdbcTemplate db, java.util.function.Consumer<JdbcTemplate> work) {
    new TransactionTemplate(new DataSourceTransactionManager(db.getDataSource())).executeWithoutResult(status -> { work.accept(db); status.setRollbackOnly(); });
  }

  @Test
  void usesCurrentSchemaThroughChangedServices() throws Exception {
    var db = db();
    long user = db.queryForObject("insert into users(display_name,paid_pro_at) values('Smoke',now()) returning id", Long.class);
    db.update("insert into credit_accounts(user_id,balance) values(?,2)", user);
    db.update("insert into question_types(id,subject_id,display_name,answer_mode) values('smoke-choice','general','Smoke','choice')");
    long bank = db.queryForObject("insert into question_banks(owner_user_id,subject_id,name) values(?,'general','Smoke') returning id", Long.class, user);
    db.update("update question_banks set status='public' where id=?", bank);
    long question = db.queryForObject("insert into questions(owner_user_id,subject_id,question_type_id,answer_mode,choice_variant,stem,analysis) values(?,'general','smoke-choice','choice','single','Smoke?','Explanation') returning id", Long.class, user);
    db.update("insert into question_options(question_id,option_label,sort_order,content) values(?,'A',1,'Yes'),(?,'B',2,'No')", question, question);
    db.update("insert into question_answer_keys(question_id,answer_mode,answer_payload,explanation_payload) values(?,'choice','{\"correct\":[\"A\"]}','{\"text\":\"Because\"}')", question);
    db.update("update questions set status='active' where id=?", question);
    db.update("insert into bank_question_links(bank_id,question_id,sort_order,status) values(?,?,1,'active')", bank, question);

    var references = new ReferenceController(db);
    assertTrue(((List<?>) references.subjects().getBody().data()).stream().map(item -> ((Map<?, ?>) item).get("subject_id")).anyMatch("general"::equals));
    var auth = mock(AuthService.class); when(auth.require(any())).thenReturn(user); var analytics = new AnalyticsSearchController(db, auth); assertFalse(((List<?>) analytics.search("Bearer smoke", null, "", "", 10, "", "Smoke").data()).isEmpty());

    var mount = Files.createTempDirectory("practiq-smoke");
    var redis = mock(StringRedisTemplate.class);
    var practice = new PracticeService(db, redis, new ObjectMapper(), new GradingService());
    var session = practice.start(user, bank, "practice", 1, "all", null, false);
    long sessionId = ((Number) session.get("id")).longValue();
    var answer = practice.submit(user, sessionId, question, Map.of("selected", List.of("A")), null);
    assertEquals(Boolean.TRUE, answer.get("is_correct"));
    assertEquals("Because", ((Map<?, ?>) new ObjectMapper().readValue(String.valueOf(answer.get("explanation_payload")), Map.class)).get("text"));
    db.update("insert into question_types(id,subject_id,display_name,answer_mode) values('smoke-short','general','Smoke short','short_answer')");
    long shortQuestion = db.queryForObject("insert into questions(owner_user_id,subject_id,question_type_id,answer_mode,stem) values(?,'general','smoke-short','short_answer','Explain') returning id", Long.class, user);
    db.update("insert into question_answer_keys(question_id,answer_mode,answer_payload) values(?,'short_answer','{\"answer\":\"Reference\"}')", shortQuestion);
    db.update("update questions set status='active' where id=?", shortQuestion);
    db.update("insert into bank_question_links(bank_id,question_id,sort_order,status) values(?,?,2,'active')", bank, shortQuestion);
    var shortSession = practice.start(user, bank, "practice", 1, "by_type", "smoke-short", false);
    long shortSessionId = ((Number) shortSession.get("id")).longValue();
    practice.submit(user, shortSessionId, shortQuestion, Map.of("value", "My answer"), null);
    assertNull(((Map<?, ?>) practice.questionPage(user, shortSessionId, 0).get("result")).get("is_correct"));

    var media = new MediaService(db, mount.toString());
    var png = new MockMultipartFile("file", "x.png", "image/png", new byte[] {(byte)137,80,78,71,13,10,26,10});
    var asset = media.upload(user, png);
    assertEquals("image", asset.get("media_type"));
    assertNotNull(db.queryForObject("select checksum_sha256 from media_assets where id=?", String.class, asset.get("id")));

    var imports = new ImportService(db, mount.toString(), java.math.BigDecimal.ONE, "", "");
    var job = imports.create(user, Map.of("paidPro", true), bank, "source.txt", "txt", Map.of());
    assertEquals(0, java.math.BigDecimal.ONE.negate().compareTo(db.queryForObject("select amount from credit_ledger where ai_task_id=?", java.math.BigDecimal.class, job.get("ai_task_id"))));
    assertEquals("text", job.get("source_type"));
    var uploadedFile = new MockMultipartFile("file", "source.txt", "text/plain", "ready".getBytes()); var uploaded = imports.upload(user, Map.of("paidPro", true), ((Number) job.get("id")).longValue(), uploadedFile); var stored = mount.resolve(String.valueOf(uploaded.get("source_storage_path"))); assertTrue(Files.exists(stored)); imports.action(user, Map.of("paidPro", false), ((Number) job.get("id")).longValue(), "cancel", null); assertFalse(Files.exists(stored));
    assertEquals(0, new java.math.BigDecimal("2").compareTo(db.queryForObject("select balance from credit_accounts where user_id=?", java.math.BigDecimal.class, user)));
    assertEquals(0, java.math.BigDecimal.ONE.compareTo(db.queryForObject("select amount from credit_ledger where ai_task_id=? and kind='release'", java.math.BigDecimal.class, job.get("ai_task_id"))));
  }

  @Test
  void resolvesWeChatUnionidsWithoutMergingUsers() {
    var db = db();
    rollback(db, ignored -> {
      var auth = new AuthService(db, new MembershipService(), new ObjectMapper(), "test-secret");
      String suffix = UUID.randomUUID().toString();
      long original = db.queryForObject("insert into users default values returning id", Long.class);
      db.update("insert into wechat_identities(user_id,openid,unionid) values(?,?,?)", original, "old-" + suffix, "union-" + suffix);
      var login = auth.login(new WeChatClient.Session("new-" + suffix, "union-" + suffix));
      assertEquals(original, ((Number) ((Map<?, ?>) login.get("user")).get("id")).longValue());
      assertEquals("new-" + suffix, db.queryForObject("select openid from wechat_identities where user_id=?", String.class, original));
      long other = db.queryForObject("insert into users default values returning id", Long.class);
      db.update("insert into wechat_identities(user_id,openid,unionid) values(?,?,?)", other, "other-openid-" + suffix, "other-unionid-" + suffix);
      var conflict = assertThrows(ApiException.class, () -> auth.login(new WeChatClient.Session("new-" + suffix, "other-unionid-" + suffix)));
      assertEquals("IDENTITY_CONFLICT", conflict.code);
      long inactive = db.queryForObject("insert into users(status) values('inactive') returning id", Long.class);
      db.update("insert into wechat_identities(user_id,openid) values(?,?)", inactive, "inactive-" + suffix);
      assertEquals(403, assertThrows(ApiException.class, () -> auth.login(new WeChatClient.Session("inactive-" + suffix, null))).status);
    });
  }

  @Test
  void rotatesRefreshTokensAndKeepsOnlyTheNewestLoginSession() {
    var db = db();
    rollback(db, ignored -> {
      var auth = new AuthService(db, new MembershipService(), new ObjectMapper(), "test-secret");
      String suffix = UUID.randomUUID().toString();
      var identity = new WeChatClient.Session("rotation-" + suffix, null);

      var first = auth.login(identity);
      long user = ((Number) ((Map<?, ?>) first.get("user")).get("id")).longValue();
      String firstAccess = String.valueOf(((Map<?, ?>) first.get("tokens")).get("accessToken"));
      var second = auth.login(identity);
      String secondRefresh = String.valueOf(((Map<?, ?>) second.get("tokens")).get("refreshToken"));
      assertEquals(1, db.queryForObject("select count(*) from auth_sessions where user_id=? and revoked_at is null", Integer.class, user));
      assertEquals(401, assertThrows(ApiException.class, () -> auth.require("Bearer " + firstAccess)).status);

      var rotated = auth.refresh(secondRefresh);
      String rotatedAccess = String.valueOf(((Map<?, ?>) rotated.get("tokens")).get("accessToken"));
      assertEquals(user, auth.require("Bearer " + rotatedAccess));
      assertEquals(401, assertThrows(ApiException.class, () -> auth.refresh(secondRefresh)).status);
      assertEquals(0, db.queryForObject("select count(*) from auth_sessions where user_id=? and revoked_at is null", Integer.class, user));
      assertEquals(401, assertThrows(ApiException.class, () -> auth.require("Bearer " + rotatedAccess)).status);
    });
  }

  @Test
  void exposesSnapshotAndMineFavoritePaginationContracts() {
    var db = db();
    rollback(db, ignored -> {
      String suffix = UUID.randomUUID().toString();
      long user = db.queryForObject("insert into users(display_name) values('Contract') returning id", Long.class);
      long other = db.queryForObject("insert into users(display_name) values('Other') returning id", Long.class);
      long ownedA = db.queryForObject("insert into question_banks(owner_user_id,subject_id,name,description) values(?,'general','Mine A','First') returning id", Long.class, user);
      db.queryForObject("insert into question_banks(owner_user_id,subject_id,name) values(?,'general','Mine B') returning id", Long.class, user);
      long favorite = db.queryForObject("insert into question_banks(owner_user_id,subject_id,name,description) values(?,'general','Favorite','Saved') returning id", Long.class, other);
      db.update("update question_banks set status='public' where id=?", favorite);
      db.update("insert into user_bank_favorites(user_id,bank_id) values(?,?)", user, favorite);

      String type = "contract-short-" + suffix;
      db.update("insert into question_types(id,subject_id,display_name,answer_mode) values(?,'general','Contract short','short_answer')", type);
      long question = db.queryForObject("insert into questions(owner_user_id,subject_id,question_type_id,answer_mode,stem) values(?,'general',?,'short_answer','Review this question') returning id", Long.class, user, type);
      db.update("insert into question_answer_keys(question_id,answer_mode,answer_payload) values(?,'short_answer','{\"answer\":\"Reference\"}')", question);
      db.update("update questions set status='active' where id=?", question);
      db.update("insert into bank_question_links(bank_id,question_id,sort_order,status) values(?,?,1,'active')", ownedA, question);
      var practice = new PracticeService(db, mock(StringRedisTemplate.class), new ObjectMapper(), new GradingService());
      long session = ((Number) practice.start(user, ownedA, "practice", 1, "all", null, false).get("id")).longValue();
      practice.submit(user, session, question, Map.of("value", "answer"), null);
      db.update("insert into practice_sessions(user_id,bank_id,mode) values(?,?,'all')", user, ownedA);

      var auth = mock(AuthService.class);
      when(auth.require(any())).thenReturn(user);
      var content = new ContentController(db, auth, new ObjectMapper());

      var mine = content.banks("Bearer contract", "mine", "", "", 1, "");
      var mineRows = (List<?>) mine.data();
      assertEquals(1, mineRows.size());
      assertEquals(java.util.Set.of("id", "subject_id", "name", "description", "status", "created_at", "updated_at", "is_owner", "is_favorite"), ((Map<?, ?>) mineRows.getFirst()).keySet());
      var minePage = (Map<?, ?>) mine.meta().get("pagination");
      assertEquals(1, minePage.get("limit"));
      assertEquals(true, minePage.get("hasMore"));
      assertFalse(String.valueOf(minePage.get("cursor")).isBlank());

      var nextMine = content.banks("Bearer contract", "mine", "", "", 1, String.valueOf(minePage.get("cursor")));
      assertEquals(1, ((List<?>) nextMine.data()).size());
      assertEquals(false, ((Map<?, ?>) nextMine.meta().get("pagination")).get("hasMore"));

      var favorites = content.banks("Bearer contract", "favorites", "", "", 30, "");
      assertEquals(1, ((List<?>) favorites.data()).size());
      assertEquals(favorite, ((Number) ((Map<?, ?>) ((List<?>) favorites.data()).getFirst()).get("id")).longValue());
      assertEquals(true, ((Map<?, ?>) ((List<?>) favorites.data()).getFirst()).get("is_favorite"));

      var snapshot = (Map<?, ?>) new AnalyticsSearchController(db, auth).snapshot("Bearer contract").data();
      assertEquals(java.util.Set.of("summary", "recentSessions", "weakQuestions"), snapshot.keySet());
      var summary = (Map<?, ?>) snapshot.get("summary");
      assertEquals(java.util.Set.of("owned_banks", "favorite_banks", "attempts", "correct", "wrong", "sessions", "active_sessions", "active_imports", "accuracy"), summary.keySet());
      assertEquals(1L, ((Number) summary.get("attempts")).longValue());
      assertEquals(java.util.Set.of("id", "user_id", "bank_id", "session_type", "status", "question_count", "answered_count", "correct_count", "wrong_count", "started_at", "completed_at"), ((Map<?, ?>) ((List<?>) snapshot.get("recentSessions")).getFirst()).keySet());
      assertEquals(java.util.Set.of("bank_id", "question_id", "attempt_count", "correct_count", "wrong_count", "mastery_score", "stem", "question_type_id"), ((Map<?, ?>) ((List<?>) snapshot.get("weakQuestions")).getFirst()).keySet());
    });
  }

  @Test
  void serializesConcurrentUnionidLogins() throws Exception {
    var db = db();
    var auth = new AuthService(db, new MembershipService(), new ObjectMapper(), "test-secret");
    var transactions = new TransactionTemplate(new DataSourceTransactionManager(db.getDataSource()));
    String suffix = UUID.randomUUID().toString();
    var ready = new CountDownLatch(2); var start = new CountDownLatch(1);
    var pool = Executors.newFixedThreadPool(2);
    try {
      var first = pool.submit(() -> login(transactions, auth, "concurrent-a-" + suffix, "concurrent-union-" + suffix, ready, start));
      var second = pool.submit(() -> login(transactions, auth, "concurrent-b-" + suffix, "concurrent-union-" + suffix, ready, start));
      assertTrue(ready.await(5, TimeUnit.SECONDS)); start.countDown();
      long firstUser = first.get(10, TimeUnit.SECONDS), secondUser = second.get(10, TimeUnit.SECONDS);
      assertEquals(firstUser, secondUser);
      assertEquals(1, db.queryForObject("select count(*) from wechat_identities where unionid=?", Integer.class, "concurrent-union-" + suffix));
      db.update("delete from users where id=?", firstUser);
    } finally { pool.shutdownNow(); }
  }

  private long login(TransactionTemplate transactions, AuthService auth, String openid, String unionid, CountDownLatch ready, CountDownLatch start) {
    try {
      ready.countDown(); if (!start.await(5, TimeUnit.SECONDS)) throw new IllegalStateException("concurrent login did not start");
      return transactions.execute(status -> ((Number) ((Map<?, ?>) auth.login(new WeChatClient.Session(openid, unionid)).get("user")).get("id")).longValue());
    } catch (InterruptedException error) { Thread.currentThread().interrupt(); throw new RuntimeException(error); }
  }

  @Test
  void paymentIdempotencyExpiresAndLateSuccessReplaysSafely() {
    var db = db();
    var conflict = payments(db);
    var created = conflict.payments.create(conflict.user, "pro", "same");
    long conflictOrder = id(created);
    assertEquals(java.util.Set.of("appId", "timeStamp", "nonceStr", "package", "signType", "paySign"), ((Map<?, ?>) created.get("requestPayment")).keySet());
    assertEquals(409, assertThrows(ApiException.class, () -> conflict.payments.create(conflict.user, "credits", "same")).status);

    var first = payments(db);
    long pending = first.expired("pro", "same", "NOTPAY");
      long replacement = first.create("pro", "same");
      assertNotEquals(pending, replacement);
      assertEquals("closed", first.status(pending));
    first.close(replacement);
    conflict.close(conflictOrder);

    var paid = payments(db);
    long order = paid.create("pro", "paid-key");
    paid.succeed(order);
    assertEquals(order, paid.create("pro", "paid-key"));

    var late = payments(db);
    long old = late.expired("pro", "old", "SUCCESS");
    var response = late.payments.create(late.user, "pro", "new");
    assertEquals(old, id(response));
    assertFalse(response.containsKey("requestPayment"));
    assertEquals(1, late.orders());
    assertEquals("paid", late.status(old));
  }

  @Test
  void paymentNotificationsAreTimestampedIdempotentAndAtomic() {
    var db = db();
      var f = payments(db);
      int before = f.replays();
      long order = f.create("pro", "notification");
      f.succeedRemote(order);
      String raw = "{\"id\":\"notification-1\"}";
      f.payments.paymentNotification(f.headers("nonce-1"), raw);
      f.payments.paymentNotification(f.headers("nonce-2"), raw);
      f.payments.paymentNotification(f.headers("nonce-1"), "{\"id\":\"notification-2\"}");
      assertEquals("paid", f.status(order));
      assertEquals(1, f.ledger(order, "bonus"));
      assertEquals(before + 1, f.replays());
      assertEquals(401, assertThrows(ApiException.class, () -> f.payments.paymentNotification(f.headersAt("stale", Instant.now().minusSeconds(301)), "{\"id\":\"stale\"}")).status);
      assertEquals(401, assertThrows(ApiException.class, () -> f.payments.paymentNotification(f.headersAt("future", Instant.now().plusSeconds(301)), "{\"id\":\"future\"}")).status);

      var mismatch = payments(db);
      int mismatchBefore = mismatch.replays();
      long mismatched = mismatch.create("pro", "mismatch");
      mismatch.gateway.notification = mismatch.gateway.payment(mismatch.merchant(mismatched), 1, "SUCCESS");
      assertEquals(422, assertThrows(ApiException.class, () -> mismatch.payments.paymentNotification(mismatch.headers("bad"), "{\"id\":\"bad\"}")).status);
      assertEquals("pending", mismatch.status(mismatched));
      assertEquals(mismatchBefore, mismatch.replays());
      mismatch.gateway.notification = mismatch.gateway.payment("wrong", 2990, "SUCCESS");
      assertEquals(422, assertThrows(ApiException.class, () -> mismatch.payments.paymentNotification(mismatch.headers("wrong"), "{\"id\":\"wrong\"}")).status);
      assertEquals(mismatchBefore, mismatch.replays());
      mismatch.close(mismatched);
  }

  @Test
  void refundsAreDurableIdempotentAndDoNotReactivateOrOverReverse() {
    var db = db();
      rollback(db, ignored -> {
      var f = payments(db, true);
      long pro = f.create("pro", "pro");
      f.succeed(pro);

      long processing = f.create("credits", "processing");
      f.succeed(processing);
      f.gateway.nextRefundState = "PROCESSING";
      f.payments.refund(f.admin, processing);
      assertEquals("pending", f.refundStatus(processing));
      f.gateway.refundState(f.refundNo(processing), "CLOSED");
      f.payments.reconcilePending();
      assertEquals("closed", f.refundStatus(processing));

      long credited = f.create("credits", "credit-success");
      f.succeed(credited);
      f.gateway.nextRefundState = "SUCCESS";
      f.payments.refund(f.admin, credited);
      f.payments.refund(f.admin, credited);
      assertEquals("succeeded", f.refundStatus(credited));
      assertEquals(1, f.ledger(credited, "payment_refund"));

      f.gateway.throwAfterRefundAccept = true;
      f.payments.refund(f.admin, pro);
      assertEquals(1, f.refunds(pro));
      assertEquals(f.refundNo(pro), f.gateway.lastQueriedRefund);
      assertEquals("refunded", f.status(pro));
      f.gateway.notification = f.gateway.payment(f.merchant(pro), 2990, "SUCCESS");
      f.payments.paymentNotification(f.headers("late"), "{\"id\":\"late\"}");
      assertNull(db.queryForObject("select paid_pro_at from users where id=?", java.time.OffsetDateTime.class, f.user));

      long laterPro = f.create("pro", "later-pro");
      f.succeed(laterPro);
      f.gateway.throwAfterRefundAccept = false;
      f.gateway.nextRefundState = "SUCCESS";
      f.payments.refund(f.admin, laterPro);
      assertEquals("refunded", f.status(laterPro));
      assertEquals(0, f.ledger(laterPro, "payment_refund"));
    });
  }

  @Test
  void reconciliationContinuesAfterOneBadRefund() {
    var db = db();
    rollback(db, ignored -> {
      var f = payments(db, true);
      long pro = f.create("pro", "pro"); f.succeed(pro);
      long bad = f.create("credits", "bad"); f.succeed(bad);
      f.gateway.nextRefundState = "PROCESSING"; f.payments.refund(f.admin, bad);
      long good = f.create("credits", "good"); f.succeed(good);
      f.gateway.nextRefundState = "PROCESSING"; f.payments.refund(f.admin, good);
      f.gateway.refundStates.put(f.refundNo(bad), new WeChatPayGateway.Refund(f.refundNo(bad), f.merchant(bad), f.transaction(bad), 1, 1000, "CNY", "bad", "SUCCESS"));
      f.gateway.refundState(f.refundNo(good), "SUCCESS");
      f.payments.reconcilePending();
      assertEquals("pending", f.refundStatus(bad));
      assertEquals("succeeded", f.refundStatus(good));
    });
  }

  private Fixture payments(JdbcTemplate db) { return payments(db, false); }
  private Fixture payments(JdbcTemplate db, boolean needsAdmin) {
    String suffix = UUID.randomUUID().toString();
    long user = db.queryForObject("insert into users default values returning id", Long.class);
    long admin = needsAdmin ? db.queryForObject("insert into users(role) values('admin') returning id", Long.class) : user;
    db.update("insert into wechat_identities(user_id,openid) values(?,?)", user, "payment-" + suffix);
    var gateway = new FakePay("app", "mch");
    return new Fixture(db, user, admin, gateway, new PaymentService(db, gateway, new ObjectMapper(), "app", "mch"));
  }

  private static long id(Map<String,Object> response) { return ((Number) ((Map<?, ?>) response.get("order")).get("id")).longValue(); }

  private static final class Fixture {
    final JdbcTemplate db; final long user, admin; final FakePay gateway; final PaymentService payments;
    Fixture(JdbcTemplate db, long user, long admin, FakePay gateway, PaymentService payments) { this.db=db;this.user=user;this.admin=admin;this.gateway=gateway;this.payments=payments; }
    long create(String kind, String key) { return id(payments.create(user, kind, key)); }
    void succeed(long id) { succeedRemote(id); payments.get(user, id); }
    void succeedRemote(long id) { gateway.paymentState(merchant(id), "SUCCESS"); gateway.notification=gateway.query(merchant(id)); }
    String merchant(long id) { return db.queryForObject("select merchant_order_no from payment_orders where id=?", String.class, id); }
    String transaction(long id) { return "tx-" + merchant(id); }
    String status(long id) { return db.queryForObject("select status from payment_orders where id=?", String.class, id); }
    String refundStatus(long id) { return db.queryForObject("select status from payment_refunds where order_id=?", String.class, id); }
    String refundNo(long id) { return db.queryForObject("select merchant_refund_no from payment_refunds where order_id=?", String.class, id); }
    int orders() { return db.queryForObject("select count(*) from payment_orders where user_id=?", Integer.class, user); }
    int refunds(long id) { return db.queryForObject("select count(*) from payment_refunds where order_id=?", Integer.class, id); }
    int ledger(long id, String kind) { return db.queryForObject("select count(*) from credit_ledger where order_id=? and kind=?", Integer.class, id, kind); }
    int replays() { return db.queryForObject("select count(*) from wechat_notification_replays", Integer.class); }
    void close(long id) { db.update("update payment_orders set status='closed' where id=? and status='pending'", id); }
    long expired(String kind, String key, String state) { String merchant="expired-"+UUID.randomUUID(); int cents="pro".equals(kind)?2990:1000; Long id=db.queryForObject("insert into payment_orders(user_id,kind,merchant_order_no,app_id,mch_id,amount_cents,credits_amount,created_at,expires_at,idempotency_key,request_hash) values(?,?,?,?,?,?,?,now()-interval '31 minutes',now()-interval '1 minute',?,decode('00','hex')) returning id",Long.class,user,kind,merchant,"app","mch",cents,"credits".equals(kind)?new java.math.BigDecimal("100.00"):null,key); gateway.payments.put(merchant,gateway.payment(merchant,cents,state)); return id; }
    Map<String,String> headers(String nonce) { return headersAt(nonce, Instant.now()); }
    Map<String,String> headersAt(String nonce, Instant timestamp) { return Map.of("wechatpay-timestamp", String.valueOf(timestamp.getEpochSecond()), "wechatpay-nonce", nonce, "wechatpay-signature", "signature", "wechatpay-serial", "serial"); }
  }

  private static final class FakePay implements WeChatPayGateway {
    final String app, mch; final Map<String,Payment> payments = new java.util.HashMap<>(); final Map<String,Refund> refundStates = new java.util.HashMap<>();
    Payment notification; String nextRefundState = "SUCCESS"; boolean throwAfterRefundAccept; String lastQueriedRefund;
    FakePay(String app, String mch) { this.app=app; this.mch=mch; }
    public boolean available() { return true; }
    public Map<String,Object> prepay(String order,String description,int cents,String openid,String expires) { payments.putIfAbsent(order, payment(order, cents, "NOTPAY")); return Map.of("appId",app,"timeStamp","1","nonceStr","n","package","prepay_id=x","signType","RSA","paySign","s"); }
    Payment payment(String order, int cents, String state) { return new Payment(order, app, mch, cents, "CNY", "tx-" + order, state); }
    void paymentState(String order, String state) { Payment old=payments.get(order); payments.put(order, payment(order, old.amountCents(), state)); }
    public Payment query(String order) { return payments.get(order); }
    public void close(String order) { paymentState(order, "CLOSED"); }
    public Refund refund(String refund,String order,String transaction,int cents) { Refund value=new Refund(refund,order,transaction,cents,cents,"CNY","refund-"+refund,nextRefundState); refundStates.put(refund,value); if(throwAfterRefundAccept)throw new Failed(); return value; }
    void refundState(String refund, String state) { Refund old=refundStates.get(refund); refundStates.put(refund, new Refund(old.merchantRefundNo(),old.merchantOrderNo(),old.transactionId(),old.amountCents(),old.totalAmountCents(),old.currency(),old.refundId(),state)); }
    public Refund queryRefund(String refund) { lastQueriedRefund=refund; return refundStates.get(refund); }
    public Payment paymentNotification(Map<String,String> headers,String raw) { return notification; }
    public Refund refundNotification(Map<String,String> headers,String raw) { return null; }
  }

  @Test
  void cloneKeepsGroupOnlyQuestionsOutOfTopLevelItems() {
    var db = db();
    rollback(db, ignored -> {
      String suffix = UUID.randomUUID().toString();
      long owner = db.queryForObject("insert into users default values returning id", Long.class);
      long cloneOwner = db.queryForObject("insert into users default values returning id", Long.class);
      String type = "clone-short-" + suffix;
      db.update("insert into question_types(id,subject_id,display_name,answer_mode) values(?,'general','Clone short','short_answer')", type);
      long bank = db.queryForObject("insert into question_banks(owner_user_id,subject_id,name) values(?,'general','Clone source') returning id", Long.class, owner);
      db.update("update question_banks set status='public' where id=?", bank);
      long group = db.queryForObject("insert into question_groups(owner_user_id,subject_id,title) values(?,'general','Only group') returning id", Long.class, owner);
      long question = db.queryForObject("insert into questions(owner_user_id,subject_id,question_type_id,answer_mode,stem) values(?,'general',?,'short_answer','Grouped only') returning id", Long.class, owner, type);
      db.update("insert into question_answer_keys(question_id,answer_mode,answer_payload) values(?,'short_answer','{\"answer\":\"Reference\"}')", question);
      db.update("update questions set status='active' where id=?", question);
      db.update("insert into group_question_links(group_id,question_id,sort_order) values(?,?,1)", group, question);
      db.update("update question_groups set status='active' where id=?", group);
      db.update("insert into bank_group_links(bank_id,group_id,sort_order,status) values(?,?,1,'active')", bank, group);
      var auth = mock(AuthService.class); when(auth.require(any())).thenReturn(cloneOwner);
      long clone = ((Number) ((Map<?, ?>) new ContentController(db, auth, new ObjectMapper()).cloneBank("Bearer clone", bank).data()).get("id")).longValue();
      long copied = db.queryForObject("select id from questions where owner_user_id=? and cloned_from_question_id=?", Long.class, cloneOwner, question);
      assertEquals(0, db.queryForObject("select count(*) from bank_question_links where bank_id=? and question_id=?", Integer.class, clone, copied));
      assertEquals(1, db.queryForObject("select count(*) from bank_group_links b join group_question_links g on g.group_id=b.group_id where b.bank_id=? and g.question_id=?", Integer.class, clone, copied));
    });
  }

  @Test
  void bootstrapsOnlyOneActiveAdminFromTrustedIdentity() {
    var db = db();
    rollback(db, ignored -> {
      var bootstrap = new FirstAdminBootstrapService(db);
      String suffix = UUID.randomUUID().toString();
      assertEquals(404, assertThrows(ApiException.class, () -> bootstrap.bootstrap("unknown-" + suffix)).status);
      long inactive = db.queryForObject("insert into users(status) values('inactive') returning id", Long.class);
      db.update("insert into wechat_identities(user_id,openid) values(?,?)", inactive, "inactive-admin-" + suffix);
      assertEquals(409, assertThrows(ApiException.class, () -> bootstrap.bootstrap("inactive-admin-" + suffix)).status);
      long active = db.queryForObject("insert into users default values returning id", Long.class);
      db.update("insert into wechat_identities(user_id,openid) values(?,?)", active, "admin-" + suffix);
      bootstrap.bootstrap("admin-" + suffix);
      assertEquals("admin", db.queryForObject("select role from users where id=?", String.class, active));
      assertEquals(1, db.queryForObject("select count(*) from admin_audits where target_user_id=? and actor_user_id is null and action='bootstrap' and details='{}'::jsonb", Integer.class, active));
      assertEquals("ADMIN_EXISTS", assertThrows(ApiException.class, () -> bootstrap.bootstrap("admin-" + suffix)).code);
    });
  }
}
