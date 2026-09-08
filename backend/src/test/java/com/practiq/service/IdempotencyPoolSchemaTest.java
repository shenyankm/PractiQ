package com.practiq.service;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;
import com.practiq.common.ApiException;
import com.zaxxer.hikari.HikariDataSource;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.condition.EnabledIfEnvironmentVariable;
import org.postgresql.ds.PGSimpleDataSource;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DataSourceTransactionManager;
import org.springframework.transaction.CannotCreateTransactionException;
import tools.jackson.databind.ObjectMapper;

/** Real bounded pool, only in the existing one-use database smoke script. */
@EnabledIfEnvironmentVariable(named = "PRACTIQ_DISPOSABLE_DB", matches = "true")
class IdempotencyPoolSchemaTest {
  private HikariDataSource pool() {
    var pool = new HikariDataSource();
    pool.setJdbcUrl(System.getenv("POSTGRES_URL")); pool.setUsername("postgres"); pool.setPassword("postgres");
    pool.setMaximumPoolSize(2); pool.setMinimumIdle(0); pool.setConnectionTimeout(500);
    return pool;
  }
  private JdbcTemplate observer() {
    var source = new PGSimpleDataSource(); source.setUrl(System.getenv("POSTGRES_URL")); source.setUser("postgres"); source.setPassword("postgres");
    return new JdbcTemplate(source);
  }
  private IdempotentWrites service(JdbcTemplate db, IdempotencyAdmission gate) {
    return new IdempotentWrites(db, new DataSourceTransactionManager(db.getDataSource()), new ObjectMapper(), mock(ReplayAuthorization.class), gate);
  }
  private IdempotentWrites.Result result() { return new IdempotentWrites.Result(200, "{\"data\":{}}".getBytes(StandardCharsets.UTF_8), Map.of()); }
  private IdempotentWrites.Result run(IdempotentWrites writes, long user, String key, java.util.function.Supplier<IdempotentWrites.Result> work) {
    return writes.execute(user, "PATCH", "/api/v1/users/me", key, new byte[]{1}, new byte[0], work);
  }

  @Test void upgradedLegacyResultsKeepDataButRemainUnscopedAndUnreadable() {
    var db = observer();
    long user = db.queryForObject("select id from users where display_name='P1 migration preserved user'", Long.class);
    long task = db.queryForObject("select id from ai_tasks where user_id=? and status='succeeded'", Long.class, user);
    assertNull(db.queryForObject("select source_question_id from ai_tasks where id=?", Long.class, task));
    assertTrue(db.queryForObject("select result::text from ai_tasks where id=?", String.class, task).contains("legacy result retained"));
    assertEquals(404, assertThrows(ApiException.class, () -> new ContentAccess(db).task(user, task)).status);
  }

  @Test void twoConnectionPoolRejectsBothKeyCompetitorsBeforeAdmissionAndRecoversAfterFailure() throws Exception {
    var observer = observer(); long user = observer.queryForObject("insert into users default values returning id", Long.class);
    try (var pool = pool(); var threads = Executors.newFixedThreadPool(2)) {
      var db = new JdbcTemplate(pool); var gate = new IdempotencyAdmission(pool);
      var first = service(db, gate); var second = service(db, gate); // same singleton gate, even across service entry points
      var entered = new CountDownLatch(1); var release = new CountDownLatch(1);
      var running = threads.submit(() -> run(first, user, "original", () -> {
        assertEquals("5s", db.queryForObject("show lock_timeout", String.class));
        db.update("update users set display_name='Rolled back' where id=?", user);
        entered.countDown();
        try { assertTrue(release.await(5, TimeUnit.SECONDS)); } catch (InterruptedException error) { throw new RuntimeException(error); }
        throw new IllegalStateException("synthetic interrupted business attempt");
      }));
      assertTrue(entered.await(5, TimeUnit.SECONDS));
      assertEquals(2, pool.getHikariPoolMXBean().getActiveConnections());
      try {
        for (String key : new String[]{"original", "different"}) {
          assertTimeout(Duration.ofMillis(250), () -> assertEquals(503, assertThrows(ApiException.class,
              () -> run(second, user, key, () -> { fail("Rejected request ran"); return result(); })).status));
        }
        assertEquals(0, pool.getHikariPoolMXBean().getThreadsAwaitingConnection());
        assertEquals(0, observer.queryForObject("select count(*) from request_idempotency where user_id=? and idempotency_key='different'", Integer.class, user));
        assertEquals(1, observer.queryForObject("select count(*) from request_idempotency where user_id=? and response_body is null", Integer.class, user));
      } finally { release.countDown(); }
      assertThrows(java.util.concurrent.ExecutionException.class, () -> running.get(5, TimeUnit.SECONDS));
      assertNull(observer.queryForObject("select display_name from users where id=?", String.class, user));
      run(second, user, "original", () -> { db.update("update users set display_name='Recovered' where id=?", user); return result(); });
      run(first, user, "original", () -> { fail("Committed response must replay"); return result(); });
      run(first, user, "different", this::result);
      assertEquals("Recovered", observer.queryForObject("select display_name from users where id=?", String.class, user));
      assertEquals(2, observer.queryForObject("select count(*) from request_idempotency where user_id=? and response_status=200", Integer.class, user));
    }
  }

  @Test void unrelatedConnectionPressureTimesOutAndReleasesPermitForOriginalKeyRetry() throws Exception {
    var observer = observer(); long user = observer.queryForObject("insert into users default values returning id", Long.class);
    try (var pool = pool()) {
      var db = new JdbcTemplate(pool); var writes = service(db, new IdempotencyAdmission(pool));
      try (var unrelated = pool.getConnection()) {
        assertFalse(unrelated.isClosed());
        assertTimeout(Duration.ofSeconds(3), () -> assertThrows(CannotCreateTransactionException.class,
            () -> run(writes, user, "recover", () -> { fail("No inner connection was available"); return result(); })));
      }
      assertEquals(1, observer.queryForObject("select count(*) from request_idempotency where user_id=? and response_body is null", Integer.class, user));
      run(writes, user, "recover", this::result);
      assertEquals(1, observer.queryForObject("select count(*) from request_idempotency where user_id=? and response_status=200", Integer.class, user));
    }
  }
}
