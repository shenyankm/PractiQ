package com.practiq.service;

import com.practiq.common.ApiException;
import java.security.MessageDigest;
import java.util.Map;
import java.util.Set;
import java.util.function.Supplier;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.TransactionDefinition;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.ObjectMapper;

/** Durable admission survives failure; business changes and successful response always commit together. */
@Service
public class IdempotentWrites {
  public record Result(int status, byte[] body, Map<String, String> headers) {}
  private record Stored(Result result) {}
  private final JdbcTemplate db;
  private final IdempotencyAdmission admission;
  private final TransactionTemplate transactions;
  private final ObjectMapper json;
  private final ReplayAuthorization authorization;
  public IdempotentWrites(JdbcTemplate db, PlatformTransactionManager manager, ObjectMapper json, ReplayAuthorization authorization, IdempotencyAdmission admission) {
    this.admission = admission;
    this.db = db; this.transactions = new TransactionTemplate(manager); this.json = json; this.authorization = authorization;
    transactions.setPropagationBehavior(TransactionDefinition.PROPAGATION_REQUIRES_NEW);
  }
  public Result execute(long user, String method, String path, String key, byte[] hash, byte[] requestBody, Supplier<Result> work) {
    if (org.springframework.transaction.support.TransactionSynchronizationManager.isActualTransactionActive())
      throw ApiException.of(503, "IDEMPOTENCY_UNAVAILABLE", "Coordinated writes must start outside an existing transaction");
    admission.enter();
    try { return executeAdmitted(user, method, path, key, hash, requestBody, work); }
    finally { admission.leave(); }
  }
  private Result executeAdmitted(long user, String method, String path, String key, byte[] hash, byte[] requestBody, Supplier<Result> work) {
    String route = method + " " + path;
    // Commit the fingerprint before running business code. An interrupted attempt remains safely retryable.
    transactions.executeWithoutResult(transaction -> {
      lock(user, route, key);
      db.update("delete from request_idempotency where user_id=? and route=? and idempotency_key=? and expires_at<=now()", user, route, key);
      Stored old = stored(user, route, key, hash);
      if (old != null && old.result() != null) return;
      authorization.request(user, method, path, requestBody);
      if (old == null) db.update("insert into request_idempotency(user_id,route,idempotency_key,request_hash,expires_at) values(?,?,?,?,now()+interval '24 hours')", user, route, key, hash);
    });
    return transactions.execute(coordinator -> {
      // This lock spans the separate business transaction and any rolled-back business error recording.
      // It has no TTL. Two connections are required while business work is running.
      lock(user, route, key);
      Stored old = stored(user, route, key, hash);
      if (old == null) throw ApiException.of(409, "REQUEST_IN_PROGRESS", "Retry with the same Idempotency-Key");
      if (old.result() != null) {
        if (old.result().status() < 400) authorization.check(user, method, path, old.result());
        else authorization.request(user, method, path, requestBody);
        return old.result();
      }
      authorization.request(user, method, path, requestBody);
      Result result = transactions.execute(business -> {
        db.execute("set local lock_timeout = '5s'");
        Result response = work.get();
        if (response.status() >= 200 && response.status() < 400) save(user, route, key, response);
        else business.setRollbackOnly();
        return response;
      });
      if (result.status() >= 400 && result.status() < 500 && !Set.of(401, 403).contains(result.status())) save(user, route, key, result);
      // Failures after admission retain the fingerprint. Authorization changes and 5xx are not terminal;
      // in particular, do not discard an admitted key merely because a controller returns business 404.
      return result;
    });
  }
  private void lock(long user, String route, String key) {
    db.execute("set local lock_timeout = '5s'");
    if (!Boolean.TRUE.equals(db.queryForObject("select pg_try_advisory_xact_lock(hashtextextended(?,0))", Boolean.class, "write:" + user + ":" + route + ":" + key)))
      throw ApiException.of(409, "REQUEST_IN_PROGRESS", "An identical request is already in progress");
  }
  private Stored stored(long user, String route, String key, byte[] hash) {
    var records = db.query("select request_hash,response_body from request_idempotency where user_id=? and route=? and idempotency_key=?", (r, n) -> {
      if (!MessageDigest.isEqual(hash, r.getBytes(1))) throw ApiException.of(409, "IDEMPOTENCY_KEY_REUSED", "Idempotency-Key was used with a different request");
      String body = r.getString(2);
      return new Stored(body == null ? null : json.readValue(body, Result.class));
    }, user, route, key);
    return records.isEmpty() ? null : records.getFirst();
  }
  private void save(long user, String route, String key, Result result) {
    if (db.update("update request_idempotency set response_status=?,response_body=?::jsonb where user_id=? and route=? and idempotency_key=?", result.status(), json.writeValueAsString(result), user, route, key) != 1)
      throw new IllegalStateException("Admitted idempotency record disappeared");
  }
}
