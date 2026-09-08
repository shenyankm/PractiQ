package com.practiq.web;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiq.auth.AuthService;
import com.practiq.auth.WeChatClient;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;

class AuthJsonContractTest {
  private final ObjectMapper json = new ObjectMapper();

  @Test
  void wechatLoginReturnsTheDocumentedUserAndTokenEnvelope() {
    var fixture = fixture();
    var request = new MockHttpServletRequest();
    request.setRemoteAddr("127.0.0.1");
    var response = new MockHttpServletResponse();

    var result = fixture.controller.login(
        new AuthController.WeChatLogin("one-time-code"), request, response);
    JsonNode body = json.valueToTree(result.getBody());

    assertEquals(200, result.getStatusCode().value());
    assertEquals(7, body.at("/data/user/id").asInt());
    assertEquals("active", body.at("/data/user/status").asText());
    assertEquals("access-token", body.at("/data/tokens/accessToken").asText());
    assertEquals("refresh-token", body.at("/data/tokens/refreshToken").asText());
    assertEquals("2030-01-01T00:10:00Z", body.at("/data/tokens/expiresAt").asText());
    assertEquals("2030-02-01T00:00:00Z", body.at("/data/tokens/refreshExpiresAt").asText());
    assertEquals("Bearer", body.at("/data/tokens/tokenType").asText());
    assertEquals(2, response.getHeaders("Set-Cookie").size());
    verify(fixture.wechat).exchange("one-time-code");
    verify(fixture.auth).login(new WeChatClient.Session("openid-1", "unionid-1"));
  }

  @Test
  void refreshAndMePreserveTheClientJsonContract() {
    var fixture = fixture();
    var response = new MockHttpServletResponse();
    var refreshed = fixture.controller.refresh(
        new AuthController.Refresh("refresh-token"),
        new MockHttpServletRequest(),
        response);
    JsonNode refreshBody = json.valueToTree(refreshed.getBody());

    assertEquals("rotated-access", refreshBody.at("/data/tokens/accessToken").asText());
    assertEquals("rotated-refresh", refreshBody.at("/data/tokens/refreshToken").asText());
    assertEquals(2, response.getHeaders("Set-Cookie").size());
    verify(fixture.auth).refresh("refresh-token");

    JsonNode me = json.valueToTree(fixture.controller.me("Bearer rotated-access"));
    assertEquals(7, me.at("/data/id").asInt());
    assertEquals("active", me.at("/data/status").asText());
    assertTrue(me.get("meta").isNull());

    var logoutResponse = new MockHttpServletResponse();
    var logout = fixture.controller.logout("Bearer rotated-access", logoutResponse);
    assertEquals(204, logout.getStatusCode().value());
    assertEquals(2, logoutResponse.getHeaders("Set-Cookie").size());
    verify(fixture.auth).logout(7L);
  }

  private Fixture fixture() {
    var auth = mock(AuthService.class);
    var wechat = mock(WeChatClient.class);
    var redis = mock(StringRedisTemplate.class);
    @SuppressWarnings("unchecked")
    ValueOperations<String, String> values = mock(ValueOperations.class);
    when(redis.opsForValue()).thenReturn(values);
    when(values.increment(anyString())).thenReturn(1L);

    var identity = new WeChatClient.Session("openid-1", "unionid-1");
    when(wechat.exchange("one-time-code")).thenReturn(identity);
    when(auth.login(identity)).thenReturn(payload("access-token", "refresh-token"));
    when(auth.refresh("refresh-token")).thenReturn(payload("rotated-access", "rotated-refresh"));
    when(auth.require("Bearer rotated-access")).thenReturn(7L);
    when(auth.user(7L)).thenReturn(user());

    return new Fixture(auth, wechat, new AuthController(auth, wechat, redis, "test", false));
  }

  private Map<String, Object> payload(String access, String refresh) {
    return Map.of(
        "user", user(),
        "tokens", Map.of(
            "accessToken", access,
            "refreshToken", refresh,
            "expiresAt", "2030-01-01T00:10:00Z",
            "refreshExpiresAt", "2030-02-01T00:00:00Z",
            "tokenType", "Bearer"));
  }

  private Map<String, Object> user() {
    return Map.of(
        "id", 7,
        "displayName", "Contract User",
        "status", "active",
        "role", "user",
        "effectiveMembership", "free",
        "paidPro", false,
        "creditBalance", 0);
  }

  private record Fixture(AuthService auth, WeChatClient wechat, AuthController controller) {}
}
