package com.practiq.service;

import com.practiq.common.ApiException;
import com.zaxxer.hikari.HikariDataSource;
import java.util.concurrent.Semaphore;
import javax.sql.DataSource;
import org.springframework.stereotype.Component;

/** One singleton gate for the application's actual JDBC pool, shared by every coordinated write. */
@Component
public final class IdempotencyAdmission {
  private final Semaphore slots;
  private final HikariDataSource pool;
  private final int maximumPoolSize;
  private final ThreadLocal<Boolean> entered = new ThreadLocal<>();

  public IdempotencyAdmission(DataSource source) {
    if (!(source instanceof HikariDataSource pool) || pool.getMaximumPoolSize() < 2)
      throw new IllegalStateException("Idempotent writes require a Hikari pool with explicit maximumPoolSize >= 2");
    if (pool.getConnectionTimeout() <= 0 || pool.getConnectionTimeout() >= Integer.MAX_VALUE)
      throw new IllegalStateException("Idempotent writes require a finite Hikari connectionTimeout");
    // Each admitted request holds one coordinator and one business connection. Acquire before either:
    // at most half the pool can become coordinators, so they cannot exhaust their own inner connections.
    this.pool = pool;
    this.maximumPoolSize = pool.getMaximumPoolSize();
    slots = new Semaphore(maximumPoolSize / 2);
  }

  public void enter() {
    if (pool.getMaximumPoolSize() != maximumPoolSize || pool.getConnectionTimeout() >= Integer.MAX_VALUE
        || Boolean.TRUE.equals(entered.get()) || !slots.tryAcquire())
      throw ApiException.of(503, "IDEMPOTENCY_UNAVAILABLE", "Write capacity is busy; retry with the same Idempotency-Key");
    entered.set(true);
  }
  public void leave() { entered.remove(); slots.release(); }
}
