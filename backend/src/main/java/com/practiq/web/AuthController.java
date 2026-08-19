package com.practiq.web;

import com.practiq.auth.AuthService;
import com.practiq.auth.WeChatClient;
import com.practiq.common.ApiException;
import com.practiq.common.ApiResponse;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class AuthController {
  private final AuthService auth;
  private final WeChatClient wechat;
  private final StringRedisTemplate redis;
  private final String prefix;
  private final boolean secureCookies;

  public AuthController(
      AuthService auth,
      WeChatClient wechat,
      StringRedisTemplate redis,
      @Value("${practiq.redis-key-prefix:practiq}") String prefix,
      @Value("${practiq.secure-cookies:true}") boolean secureCookies) {
    this.auth = auth;
    this.wechat = wechat;
    this.redis = redis;
    this.prefix = prefix;
    this.secureCookies = secureCookies;
  }

  record WeChatLogin(@NotBlank String code) {}
  record Refresh(String refreshToken) {}
  record Profile(String displayName, String avatarUrl) {}

  @PostMapping("/auth/wechat-login")
  ResponseEntity<ApiResponse<?>> login(
      @Valid @RequestBody WeChatLogin body,
      HttpServletRequest request,
      HttpServletResponse response) {
    rate(request.getRemoteAddr());
    return issued(auth.login(wechat.exchange(body.code())), HttpStatus.OK, response);
  }

  @PostMapping("/auth/refresh")
  ResponseEntity<ApiResponse<?>> refresh(
      @RequestBody(required = false) Refresh body,
      HttpServletRequest request,
      HttpServletResponse response) {
    String raw = body == null ? null : body.refreshToken();
    if (raw == null || raw.isBlank()) {
      raw = cookie(request, "refresh_token");
    }
    if (raw == null || raw.isBlank()) {
      throw ApiException.of(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token");
    }
    return issued(auth.refresh(raw), HttpStatus.OK, response);
  }

  @GetMapping("/auth/me")
  ApiResponse<?> me(@RequestHeader(value = "Authorization", required = false) String header) {
    return ApiResponse.ok(auth.user(auth.require(header)));
  }

  @PostMapping("/auth/logout")
  ResponseEntity<Void> logout(
      @RequestHeader(value = "Authorization", required = false) String header,
      HttpServletResponse response) {
    auth.logout(auth.require(header));
    clear(response, "session", "/");
    clear(response, "refresh_token", "/api/v1/auth");
    return ResponseEntity.noContent().build();
  }

  @PatchMapping("/users/me")
  ApiResponse<?> update(
      @RequestHeader(value = "Authorization", required = false) String header,
      @RequestBody Profile body) {
    return ApiResponse.ok(auth.update(auth.require(header), body.displayName(), body.avatarUrl()));
  }

  private ResponseEntity<ApiResponse<?>> issued(
      java.util.Map<String, Object> value, HttpStatus status, HttpServletResponse response) {
    @SuppressWarnings("unchecked")
    var tokens = (java.util.Map<String, Object>) value.get("tokens");
    cookie(response, "session", (String) tokens.get("accessToken"), "/", Duration.ofMinutes(10));
    cookie(
        response,
        "refresh_token",
        (String) tokens.get("refreshToken"),
        "/api/v1/auth",
        Duration.ofDays(30));
    return ResponseEntity.status(status).body(ApiResponse.ok(value));
  }

  private void cookie(
      HttpServletResponse response, String name, String value, String path, Duration age) {
    ResponseCookie cookie = ResponseCookie.from(name, value)
        .path(path)
        .httpOnly(true)
        .sameSite("Lax")
        .secure(secureCookies)
        .maxAge(age)
        .build();
    response.addHeader(HttpHeaders.SET_COOKIE, cookie.toString());
  }

  private void clear(HttpServletResponse response, String name, String path) {
    response.addHeader(
        HttpHeaders.SET_COOKIE,
        ResponseCookie.from(name, "")
            .path(path)
            .httpOnly(true)
            .sameSite("Lax")
            .secure(secureCookies)
            .maxAge(Duration.ZERO)
            .build()
            .toString());
  }

  private String cookie(HttpServletRequest request, String name) {
    if (request.getCookies() != null) {
      for (Cookie cookie : request.getCookies()) {
        if (name.equals(cookie.getName())) {
          return cookie.getValue();
        }
      }
    }
    return "";
  }

  private void rate(String address) {
    try {
      String key = prefix + ":rate-limit:auth:wechat-login:ip:" + hash(address == null ? "unknown" : address);
      Long count = redis.opsForValue().increment(key);
      if (count != null) {
        redis.expire(key, Duration.ofMinutes(1));
      }
      if (count != null && count > 20) {
        throw ApiException.of(429, "RATE_LIMITED", "Too many authentication attempts");
      }
    } catch (ApiException e) {
      throw e;
    } catch (Exception e) {
      throw ApiException.of(
          503,
          "AUTH_RATE_LIMIT_UNAVAILABLE",
          "Authentication service is temporarily unavailable");
    }
  }

  private String hash(String value) {
    try {
      return HexFormat.of().formatHex(
          MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }
}
