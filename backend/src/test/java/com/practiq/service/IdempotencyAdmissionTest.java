package com.practiq.service;

import static org.junit.jupiter.api.Assertions.*;
import com.practiq.common.ApiException;
import com.zaxxer.hikari.HikariDataSource;
import org.junit.jupiter.api.Test;

class IdempotencyAdmissionTest {
  @Test void rejectsSingleConnectionPoolBeforeOpeningDatabaseConnections() {
    try (var pool = new HikariDataSource()) {
      pool.setMaximumPoolSize(1);
      assertTrue(assertThrows(IllegalStateException.class, () -> new IdempotencyAdmission(pool)).getMessage().contains(">= 2"));
      assertFalse(pool.isRunning());
    }
  }
  @Test void refusesUnboundedWaitAndRuntimePoolShrink() {
    try (var pool = new HikariDataSource()) {
      pool.setMaximumPoolSize(2); pool.setConnectionTimeout(0);
      assertTrue(assertThrows(IllegalStateException.class, () -> new IdempotencyAdmission(pool)).getMessage().contains("connectionTimeout"));
      pool.setConnectionTimeout(500);
      var gate = new IdempotencyAdmission(pool);
      pool.setMaximumPoolSize(1);
      assertEquals(503, assertThrows(ApiException.class, gate::enter).status);
      assertFalse(pool.isRunning());
    }
  }
  @Test void rejectsExistingTransactionsBeforeAcquiringAdmissionOrAnyConnection() {
    try (var pool = new HikariDataSource()) {
      pool.setMaximumPoolSize(2);
      var gate = new IdempotencyAdmission(pool);
      var db = org.mockito.Mockito.mock(org.springframework.jdbc.core.JdbcTemplate.class);
      var writes = new IdempotentWrites(db, org.mockito.Mockito.mock(org.springframework.transaction.PlatformTransactionManager.class),
          new tools.jackson.databind.ObjectMapper(), org.mockito.Mockito.mock(ReplayAuthorization.class), gate);
      org.springframework.transaction.support.TransactionSynchronizationManager.setActualTransactionActive(true);
      try {
        assertEquals(503, assertThrows(ApiException.class, () -> writes.execute(1, "PATCH", "/api/v1/users/me", "key", new byte[0], new byte[0], () -> { fail("Business ran"); return null; })).status);
      } finally { org.springframework.transaction.support.TransactionSynchronizationManager.setActualTransactionActive(false); }
      org.mockito.Mockito.verifyNoInteractions(db);
      gate.enter(); gate.leave();
    }
  }
  @Test void rejectsNestedAdmissionWithoutLosingOuterPermit() {
    try (var pool = new HikariDataSource()) {
      pool.setMaximumPoolSize(2);
      var gate = new IdempotencyAdmission(pool);
      gate.enter();
      assertEquals(503, assertThrows(ApiException.class, gate::enter).status);
      gate.leave();
      gate.enter(); gate.leave();
      assertFalse(pool.isRunning());
    }
  }
}
