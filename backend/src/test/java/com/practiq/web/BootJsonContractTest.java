package com.practiq.web;

import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

import com.practiq.auth.AuthService;
import com.practiq.auth.WeChatClient;
import com.practiq.mapper.UsersMapper;
import com.practiq.service.AiTaskWorker;
import com.practiq.service.MembershipService;
import com.practiq.service.PracticeService;
import com.practiq.service.IdempotentWrites;
import com.practiq.common.ApiException;
import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.time.OffsetDateTime;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.apache.ibatis.session.SqlSessionFactory;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import org.springframework.test.web.servlet.MockMvc;
import tools.jackson.databind.json.JsonMapper;

/** Exercises Boot's real MVC converters, filter and application JSON configuration. */
@SpringBootTest(properties = {
    "spring.datasource.url=jdbc:postgresql://127.0.0.1:1/unused",
    "spring.data.redis.url=redis://127.0.0.1:1",
    "practiq.auth-secret=contract-test-secret",
    "practiq.wechat.pay.mch-id=", "practiq.wechat.pay.merchant-private-key-path="
})
@AutoConfigureMockMvc
class BootJsonContractTest {
  @Autowired MockMvc mvc;
  @Autowired JsonMapper json;
  @Autowired SqlSessionFactory sqlSessions;
  @Autowired UsersMapper users;
  @MockitoBean AuthService auth;
  @MockitoBean WeChatClient wechat;
  @MockitoBean PracticeService practice;
  @MockitoBean IdempotentWrites writes;
  @MockitoBean StringRedisTemplate redis;
  @MockitoBean AiTaskWorker worker;
  private ValueOperations<String, String> values;

  @BeforeEach @SuppressWarnings("unchecked")
  void fixtures() {
    values = mock(ValueOperations.class);
    when(redis.opsForValue()).thenReturn(values);
    when(values.increment(anyString())).thenReturn(1L);
    when(auth.require("Bearer test-token")).thenReturn(7L);
    when(writes.execute(anyLong(), anyString(), anyString(), anyString(), any(byte[].class), any(byte[].class), any())).thenAnswer(call -> ((java.util.function.Supplier<?>) call.getArgument(6)).get());
  }

  @Test void contextRegistersMybatisAndMvcUsesConfiguredNullTimeAndMoneyDefaults() throws Exception {
    assertNotNull(users);
    assertTrue(sqlSessions.getConfiguration().isMapUnderscoreToCamelCase());
    var user = new LinkedHashMap<String, Object>();
    user.put("id", 7L);
    user.put("displayName", "Contract User");
    user.put("avatarUrl", null);
    user.put("creditBalance", new BigDecimal("1234567890.123456"));
    user.put("trialEndsAt", OffsetDateTime.parse("2030-01-01T00:00:00Z"));
    when(auth.user(7)).thenReturn(user);
    String body = mvc.perform(get("/api/v1/auth/me").header("Authorization", "Bearer test-token"))
        .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
    var result = json.readTree(body);
    assertEquals("Contract User", result.at("/data/displayName").asText());
    assertFalse(result.has("meta"));
    assertFalse(result.path("data").has("avatarUrl"));
    assertEquals("2030-01-01T00:00:00Z", result.at("/data/trialEndsAt").asText());
    assertTrue(body.contains("1234567890.123456"), body);
  }

  @Test void loginPreservesEnvelopeAndCookiesThroughRealMvc() throws Exception {
    var identity = new WeChatClient.Session("openid", null);
    when(wechat.exchange("one-time-code")).thenReturn(identity);
    when(auth.login(identity)).thenReturn(Map.of("user", Map.of("id", 7), "tokens", Map.of(
        "accessToken", "test-token", "refreshToken", "refresh-token", "tokenType", "Bearer",
        "expiresAt", "2030-01-01T00:10:00Z")));
    var response = mvc.perform(post("/api/v1/auth/wechat-login").contentType(MediaType.APPLICATION_JSON)
        .content("{\"code\":\"one-time-code\"}"))
        .andExpect(status().isOk()).andExpect(jsonPath("$.data.tokens.accessToken").value("test-token"))
        .andExpect(jsonPath("$.meta").doesNotExist()).andReturn().getResponse();
    assertEquals(2, response.getHeaders("Set-Cookie").size());
    verify(wechat).exchange("one-time-code");
  }

  @Test void unknownAndInvalidRequestFieldsStillReturnValidationEnvelope() throws Exception {
    mvc.perform(post("/api/v1/auth/wechat-login").contentType(MediaType.APPLICATION_JSON)
        .content("{\"code\":\"ok\",\"unexpected\":true}"))
        .andExpect(status().isBadRequest()).andExpect(jsonPath("$.error.code").value("INVALID_JSON"));
    mvc.perform(post("/api/v1/auth/wechat-login").contentType(MediaType.APPLICATION_JSON)
        .content("{\"code\":\"\"}"))
        .andExpect(status().isUnprocessableEntity()).andExpect(jsonPath("$.error.code").value("VALIDATION_ERROR"));
    verifyNoInteractions(wechat);
  }

  @Test void practiceRoutesAndOptionalPrimitiveDefaultsRemainCompatible() throws Exception {
    when(practice.list(7, "", "", null, null)).thenReturn(Map.of("items", List.of(), "meta", Map.of()));
    when(practice.start(7, 3, null, null, null, null, false)).thenReturn(Map.of("id", 9));
    mvc.perform(get("/api/v1/practice-sessions").header("Authorization", "Bearer test-token"))
        .andExpect(status().isOk()).andExpect(jsonPath("$.data").isArray());
    mvc.perform(post("/api/v1/practice-sessions").header("Authorization", "Bearer test-token")
        .header("Idempotency-Key", "start").contentType(MediaType.APPLICATION_JSON).content("{\"bankId\":3}"))
        .andExpect(status().isCreated()).andExpect(jsonPath("$.data.id").value(9));
    verify(practice).start(7, 3, null, null, null, null, false);
  }

  @Test void legacyRedisResponsesCannotBypassCurrentAuthentication() throws Exception {
    when(values.get(contains(":idempotency:"))).thenReturn(
        "{\"status\":201,\"body\":\"eyJkYXRhIjp7ImlkIjo5fX0=\",\"headers\":{\"Content-Type\":\"application/json\"}}");
    when(auth.require("Bearer test-token")).thenThrow(ApiException.of(401, "UNAUTHORIZED", "Revoked"));
    mvc.perform(post("/api/v1/practice-sessions").header("Authorization", "Bearer test-token")
        .header("Idempotency-Key", "legacy").contentType(MediaType.APPLICATION_JSON).content("{\"bankId\":3}"))
        .andExpect(status().isUnauthorized());
    verifyNoInteractions(practice, writes);
  }

  @Test void replayableWritesRequireKeysAndFailClosedWhenRedisIsDown() throws Exception {
    mvc.perform(post("/api/v1/practice-sessions").header("Authorization", "Bearer test-token")
        .contentType(MediaType.APPLICATION_JSON).content("{\"bankId\":3}"))
        .andExpect(status().isUnprocessableEntity());
    when(values.increment(contains("idempotency-availability"))).thenThrow(new IllegalStateException("offline"));
    mvc.perform(post("/api/v1/practice-sessions").header("Authorization", "Bearer test-token")
        .header("Idempotency-Key", "stable").contentType(MediaType.APPLICATION_JSON).content("{\"bankId\":3}"))
        .andExpect(status().isServiceUnavailable());
    verifyNoInteractions(practice, writes);
  }

  @Test void existingSignedTokenClaimsAreAcceptedByJackson3() throws Exception {
    var db = mock(JdbcTemplate.class);
    UUID session = UUID.fromString("00000000-0000-0000-0000-000000000001");
    when(db.queryForObject(anyString(), eq(Integer.class), eq(session), eq(7L))).thenReturn(1);
    // Sign literal legacy JSON instead of generating it with the new mapper.
    String header = "{\"alg\":\"HS256\",\"typ\":\"JWT\"}";
    String claims = "{\"iss\":\"practiq-api\",\"aud\":\"practiq-mobile\",\"sub\":\"7\","
        + "\"sid\":\"" + session + "\",\"typ\":\"at+jwt\",\"iat\":1700000000,\"exp\":4102444800}";
    var base64 = Base64.getUrlEncoder().withoutPadding();
    String signed = base64.encodeToString(header.getBytes(StandardCharsets.UTF_8)) + "."
        + base64.encodeToString(claims.getBytes(StandardCharsets.UTF_8));
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec("contract-test-secret".getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
    String token = signed + "." + base64.encodeToString(mac.doFinal(signed.getBytes(StandardCharsets.US_ASCII)));
    assertEquals(7, new AuthService(db, new MembershipService(), json, "contract-test-secret").require("Bearer " + token));
  }
}
