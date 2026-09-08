package com.practiq.auth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiq.common.ApiException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Set;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class HttpWeChatClient implements WeChatClient {
  private static final Set<Integer> INVALID_CODE_ERRORS = Set.of(40029, 40163);
  private final HttpClient http;
  private final ObjectMapper json;
  private final String appId;
  private final String appSecret;

  @Autowired
  public HttpWeChatClient(
      ObjectMapper json,
      @Value("${practiq.wechat.app-id:}") String appId,
      @Value("${practiq.wechat.app-secret:}") String appSecret) {
    this(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build(), json, appId, appSecret);
  }

  HttpWeChatClient(HttpClient http, ObjectMapper json, String appId, String appSecret) {
    this.http = http;
    this.json = json;
    this.appId = appId;
    this.appSecret = appSecret;
  }

  @Override
  public Session exchange(String code) {
    if (code == null || code.isBlank() || code.length() > 256) {
      throw ApiException.of(422, "VALIDATION_ERROR", "Invalid request");
    }
    if (appId.isBlank() || appSecret.isBlank()) {
      throw unavailable();
    }
    try {
      String url = "https://api.weixin.qq.com/sns/jscode2session?appid=" + enc(appId)
          + "&secret=" + enc(appSecret) + "&js_code=" + enc(code.trim())
          + "&grant_type=authorization_code";
      var response = http.send(
          HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10)).GET().build(),
          HttpResponse.BodyHandlers.ofString());
      if (response.statusCode() != 200) {
        throw unavailable();
      }
      return parse(response.body());
    } catch (ApiException e) {
      throw e;
    } catch (Exception e) {
      throw unavailable();
    }
  }

  Session parse(String body) {
    try {
      JsonNode value = json.readTree(body);
      int error = value.path("errcode").asInt(0);
      if (INVALID_CODE_ERRORS.contains(error)) {
        throw ApiException.of(401, "WECHAT_LOGIN_FAILED", "WeChat login code is invalid or expired");
      }
      if (error != 0) {
        throw unavailable();
      }
      String openid = value.path("openid").asText("").trim();
      if (openid.isEmpty()) {
        throw ApiException.of(502, "WECHAT_INVALID_RESPONSE", "WeChat returned invalid login data");
      }
      String unionid = value.path("unionid").asText("").trim();
      return new Session(openid, unionid.isEmpty() ? null : unionid);
    } catch (ApiException e) {
      throw e;
    } catch (Exception e) {
      throw ApiException.of(502, "WECHAT_INVALID_RESPONSE", "WeChat returned invalid login data");
    }
  }

  private ApiException unavailable() {
    return ApiException.of(502, "WECHAT_UNAVAILABLE", "WeChat login is temporarily unavailable");
  }

  private static String enc(String value) {
    return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20");
  }
}
