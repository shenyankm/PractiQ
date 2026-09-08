package com.practiq.auth;

import static org.junit.jupiter.api.Assertions.*;

import tools.jackson.databind.ObjectMapper;
import com.practiq.common.ApiException;
import java.net.http.HttpClient;
import org.junit.jupiter.api.Test;

class HttpWeChatClientTest {
  private final HttpWeChatClient client =
      new HttpWeChatClient(HttpClient.newHttpClient(), new ObjectMapper(), "app", "secret");

  @Test
  void parsesTrustedIdentityWithoutPersistingSessionKey() {
    var session = client.parse("{\"openid\":\"openid-1\",\"unionid\":\"union-1\",\"session_key\":\"secret\"}");
    assertEquals("openid-1", session.openid());
    assertEquals("union-1", session.unionid());
  }

  @Test
  void rejectsExpiredCodesAndMissingOpenid() {
    var expired = assertThrows(
        ApiException.class,
        () -> client.parse("{\"errcode\":40029,\"errmsg\":\"invalid code\"}"));
    assertEquals(401, expired.status);
    assertEquals(
        "WECHAT_INVALID_RESPONSE",
        assertThrows(ApiException.class, () -> client.parse("{}")) .code);
  }
}
