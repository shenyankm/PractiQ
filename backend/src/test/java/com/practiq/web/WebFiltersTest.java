package com.practiq.web;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;

import com.practiq.auth.AuthService;
import com.practiq.config.WebFilters;
import com.practiq.service.IdempotentWrites;
import java.net.URI;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.setup.MockMvcBuilders;
import org.springframework.web.bind.annotation.*;
import tools.jackson.databind.ObjectMapper;

class WebFiltersTest {
  private final StringRedisTemplate redis = mock(StringRedisTemplate.class);
  private final AuthService auth = mock(AuthService.class);
  private final IdempotentWrites writes = mock(IdempotentWrites.class);
  private final ProbeController controller = new ProbeController();
  private final MockMvc mvc = MockMvcBuilders.standaloneSetup(controller)
      .addFilters(new WebFilters(redis, new ObjectMapper(), auth, writes)).build();

  @RestController
  static class ProbeController {
    int calls;
    @PostMapping({"/api/v1/banks", "/api/v1/auth/wechat/login", "/api/v1/auth/refresh", "/api/v1/auth/logout",
        "/api/v1/payment-orders", "/api/v1/admin/payment-orders/1/refund", "/api/v1/payments/wechat/notify", "/api/v1/payments/wechat/refund-notify"})
    Map<String, String> write() { calls++; return Map.of("result", "ok"); }
    @GetMapping("/api/v1/reference/{id}")
    Map<String, String> read(@PathVariable String id, @RequestParam String q) { calls++; return Map.of("id", id, "q", q); }
  }

  @Test void mvcMatrixAliasesAreRejectedBeforeEveryPathPolicyAndDependency() throws Exception {
    var unfiltered = MockMvcBuilders.standaloneSetup(new ProbeController()).build();
    assertEquals(200, unfiltered.perform(post("/api/v1;v=1/banks")).andReturn().getResponse().getStatus());
    for (String path : List.of("/api/v1;v=1/banks", "/api;v=1/v1/banks", "/api/v1/banks;x=1",
        "/api/v1%3bv=1/banks", "/api/v1%3Bv=1/banks", "/api/v%31/banks", "/%61pi/v1/banks",
        "/api%2fv1/banks", "/api%2Fv1/banks", "/api%5cv1/banks", "/api\\v1/banks",
        "/api//v1/banks", "/api/./v1/banks", "/api/other/../v1/banks", "/api/v1/banks/..",
        "/api/%2e/v1/banks", "/api/v1%253bv=1/banks", "/api/v1%00/banks", "/api/v1%0a/banks", "/api/v1%C2%85/banks",
        "/api/v1/auth;v=1/refresh", "/api/v1/payment-orders;x=1", "/api/v1/admin/payment-orders/1/refund;x=1",
        "/api/v1/payments/wechat/notify;x=1")) {
      var response = mvc.perform(post("/api/v1/banks").with(request -> { request.setRequestURI(path); return request; })
          .header("Authorization", "Bearer valid").header("Idempotency-Key", "stable")).andReturn().getResponse();
      assertEquals(400, response.getStatus(), path);
      assertTrue(response.getContentAsString().contains("INVALID_PATH"), path);
    }
    assertEquals(0, controller.calls);
    verifyNoInteractions(auth, redis, writes);
  }

  @SuppressWarnings("unchecked")
  @Test void canonicalWritesStillRequireKeyAndFailClosedWhenRedisIsUnavailable() throws Exception {
    ValueOperations<String, String> values = mock(ValueOperations.class);
    when(redis.opsForValue()).thenReturn(values);
    when(values.increment(anyString())).thenReturn(1L);
    when(auth.require("Bearer valid")).thenReturn(7L);
    var missing = mvc.perform(post("/api/v1/banks").header("Authorization", "Bearer valid")).andReturn().getResponse();
    assertEquals(422, missing.getStatus());
    when(values.increment(contains("idempotency-availability"))).thenThrow(new IllegalStateException("Redis down"));
    var unavailable = mvc.perform(post("/api/v1/banks").header("Authorization", "Bearer valid")
        .header("Idempotency-Key", "stable")).andReturn().getResponse();
    assertEquals(503, unavailable.getStatus());
    assertTrue(unavailable.getContentAsString().contains("IDEMPOTENCY_UNAVAILABLE"));
    assertEquals(0, controller.calls);
    verifyNoInteractions(writes);
  }

  @Test void canonicalAuthenticationAndPaymentProtocolsKeepTheirExemptions() throws Exception {
    for (String path : List.of("/api/v1/auth/wechat/login", "/api/v1/auth/refresh", "/api/v1/auth/logout",
        "/api/v1/payment-orders", "/api/v1/admin/payment-orders/1/refund",
        "/api/v1/payments/wechat/notify", "/api/v1/payments/wechat/refund-notify")) {
      assertEquals(200, mvc.perform(post(path)).andReturn().getResponse().getStatus(), path);
    }
    assertEquals(7, controller.calls);
    verifyNoInteractions(auth, writes);
  }

  @Test void utf8PathSegmentsAndEncodedQueryAreNotRejectedOrRewritten() throws Exception {
    var response = mvc.perform(get(URI.create("/api/v1/reference/%E4%B8%AD%E6%96%87?q=%2F%3B%25%20")))
        .andReturn().getResponse();
    assertEquals(200, response.getStatus());
    var body = new ObjectMapper().readTree(response.getContentAsByteArray());
    assertEquals("中文", body.path("id").asText());
    assertEquals("/;% ", body.path("q").asText());
    assertEquals(1, controller.calls);
    verifyNoInteractions(auth, writes);
  }
}
