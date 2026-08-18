package com.practiq.config;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.practiq.common.ApiError;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ReadListener;
import jakarta.servlet.ServletException;
import jakarta.servlet.ServletInputStream;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.Ordered;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.util.ContentCachingResponseWrapper;

@Component
public class WebFilters extends OncePerRequestFilter implements Ordered {
  private static final Duration IDEMPOTENCY_TTL = Duration.ofHours(24);
  private static final Duration LOCK_TTL = Duration.ofSeconds(30);
  private final StringRedisTemplate redis;
  private final ObjectMapper json;
  @Value("${practiq.app-origin}") private String origin;
  @Value("${practiq.redis-key-prefix:practiq}") private String prefix;

  public WebFilters(StringRedisTemplate redis, ObjectMapper json) { this.redis = redis; this.json = json; }
  @Override public int getOrder() { return Ordered.HIGHEST_PRECEDENCE; }

  @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
    String requestId = request.getHeader("X-Request-ID");
    if (requestId == null || requestId.isBlank() || requestId.length() > 128) requestId = UUID.randomUUID().toString();
    request.setAttribute("requestId", requestId);
    securityHeaders(response, requestId);
    if (write(request) && !sameOrigin(request)) { error(response, 403, "INVALID_ORIGIN", "Cross-site requests are not allowed", null, requestId); return; }
    if (jsonRequest(request) && request.getContentLengthLong() > maximum(request)) { error(response, 413, "REQUEST_TOO_LARGE", "Request body is too large", null, requestId); return; }
    if (request.getRequestURI().startsWith("/api/") && !request.getRequestURI().startsWith("/api/health") && !rate(request)) { error(response, 429, "RATE_LIMITED", "Too many requests", null, requestId); return; }

    HttpServletRequest wrapped = cookieAuth(jsonRequest(request) ? new LimitedRequest(request, maximum(request)) : request);
    try {
      idempotent(wrapped, response, chain, requestId);
    } catch (BodyTooLargeException ex) {
      if (!response.isCommitted()) error(response, 413, "REQUEST_TOO_LARGE", "Request body is too large", null, requestId);
    }
  }

  private void idempotent(HttpServletRequest request, HttpServletResponse response, FilterChain chain, String requestId) throws IOException, ServletException {
    String key = Optional.ofNullable(request.getHeader("Idempotency-Key")).orElse("").trim();
    if (key.isEmpty() || "GET".equals(request.getMethod()) || request.getRequestURI().startsWith("/api/v1/auth/")) { chain.doFilter(request, response); return; }
    if (key.length() > 128 || key.indexOf('\r') >= 0 || key.indexOf('\n') >= 0) { error(response, 422, "VALIDATION_ERROR", "Invalid request", List.of(Map.of("field", "Idempotency-Key", "message", "must be at most 128 characters")), requestId); return; }
    String cacheKey = prefix + ":idempotency:" + sha(identity(request) + "\0" + request.getMethod() + "\0" + request.getRequestURI() + "\0" + key);
    String lockKey = cacheKey + ":lock";
    try {
      String cached = redis.opsForValue().get(cacheKey);
      if (cached != null) { replay(response, cached); return; }
      Boolean locked = redis.opsForValue().setIfAbsent(lockKey, "1", LOCK_TTL);
      if (!Boolean.TRUE.equals(locked)) { error(response, 409, "REQUEST_IN_PROGRESS", "An identical request is already in progress", null, requestId); return; }
    } catch (Exception ex) { error(response, 503, "IDEMPOTENCY_UNAVAILABLE", "Idempotent writes are temporarily unavailable", null, requestId); return; }

    ContentCachingResponseWrapper cachedResponse = new ContentCachingResponseWrapper(response);
    try {
      chain.doFilter(request, cachedResponse);
      if (cachedResponse.getStatus() >= 200 && cachedResponse.getStatus() < 400) {
        Map<String, Object> record = new LinkedHashMap<>();
        record.put("status", cachedResponse.getStatus());
        record.put("body", Base64.getEncoder().encodeToString(cachedResponse.getContentAsByteArray()));
        Map<String, String> headers = new LinkedHashMap<>();
        for (String name : cachedResponse.getHeaderNames()) if (!name.equalsIgnoreCase("content-length") && !name.equalsIgnoreCase("transfer-encoding")) headers.put(name, cachedResponse.getHeader(name));
        record.put("headers", headers);
        redis.opsForValue().set(cacheKey, json.writeValueAsString(record), IDEMPOTENCY_TTL);
      }
    } finally {
      try { redis.delete(lockKey); } catch (Exception ignored) { }
      cachedResponse.copyBodyToResponse();
    }
  }

  @SuppressWarnings("unchecked") private void replay(HttpServletResponse response, String raw) throws IOException {
    Map<String, Object> record = json.readValue(raw, new TypeReference<>() {});
    response.setStatus(((Number) record.get("status")).intValue());
    ((Map<String, String>) record.getOrDefault("headers", Map.of())).forEach(response::setHeader);
    response.getOutputStream().write(Base64.getDecoder().decode((String) record.getOrDefault("body", "")));
  }

  private HttpServletRequest cookieAuth(HttpServletRequest request) { return new HttpServletRequestWrapper(request) {
    @Override public String getHeader(String name) {
      String value = super.getHeader(name);
      if ("Authorization".equalsIgnoreCase(name) && (value == null || value.isBlank())) {
        Cookie[] cookies = getCookies();
        if (cookies != null) for (Cookie cookie : cookies) if ("session".equals(cookie.getName())) return "Bearer " + cookie.getValue();
      }
      return value;
    }
  }; }

  private boolean write(HttpServletRequest request) { return Set.of("POST", "PUT", "PATCH", "DELETE").contains(request.getMethod()); }
  private boolean jsonRequest(HttpServletRequest request) { String type = Optional.ofNullable(request.getContentType()).orElse("").toLowerCase(); return type.startsWith("application/json") || type.matches(".*\\+json(?:;.*)?"); }
  private long maximum(HttpServletRequest request) { String path = request.getRequestURI(); if (path.startsWith("/api/v1/auth/")) return 16 * 1024L; if (path.equals("/api/v1/billing/revenuecat/webhook")) return 256 * 1024L; if (path.startsWith("/api/v1/import-jobs/") && path.endsWith("/file")) return 25L * 1024 * 1024 * 4 / 3 + 1024 * 1024; return 1024 * 1024L; }
  private String identity(HttpServletRequest request) { Cookie[] cookies = request.getCookies(); if (cookies != null) for (Cookie c : cookies) if ("session".equals(c.getName())) return c.getValue(); return Optional.ofNullable(request.getHeader("Authorization")).orElse(""); }
  private boolean sameOrigin(HttpServletRequest request) { String supplied = Optional.ofNullable(request.getHeader("Origin")).orElse(request.getHeader("Referer")); if (supplied == null || supplied.isBlank()) return true; try { var actual = java.net.URI.create(supplied); var expected = java.net.URI.create(origin); return actual.getScheme().equals(expected.getScheme()) && actual.getAuthority().equals(expected.getAuthority()); } catch (Exception ex) { return false; } }
  private boolean rate(HttpServletRequest request) { try { String key = prefix + ":rate-limit:api:ip:" + Optional.ofNullable(request.getRemoteAddr()).orElse("unknown"); Long value = redis.opsForValue().increment(key); if (value != null && value == 1) redis.expire(key, Duration.ofMinutes(1)); return value == null || value <= 300; } catch (Exception ex) { return true; } }
  private String sha(String value) { try { return java.util.HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); } catch (Exception ex) { throw new IllegalStateException(ex); } }
  private void securityHeaders(HttpServletResponse response, String id) { response.setHeader("X-Request-ID", id); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("X-Frame-Options", "DENY"); response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin"); response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'"); }
  private void error(HttpServletResponse response, int status, String code, String message, Object details, String id) throws IOException { response.setStatus(status); response.setContentType("application/json"); json.writeValue(response.getOutputStream(), new ApiError(new ApiError.ErrorBody(code, message, details, id))); }

  static final class BodyTooLargeException extends IOException { }
  static final class LimitedRequest extends HttpServletRequestWrapper {
    private final long maximum;
    LimitedRequest(HttpServletRequest request, long maximum) { super(request); this.maximum = maximum; }
    @Override public ServletInputStream getInputStream() throws IOException { return new LimitedInputStream(super.getInputStream(), maximum); }
  }
  static final class LimitedInputStream extends ServletInputStream {
    private final ServletInputStream delegate; private final long maximum; private long read;
    LimitedInputStream(ServletInputStream delegate, long maximum) { this.delegate = delegate; this.maximum = maximum; }
    private void count(int amount) throws BodyTooLargeException { if (amount > 0 && (read += amount) > maximum) throw new BodyTooLargeException(); }
    @Override public int read() throws IOException { int value = delegate.read(); count(value < 0 ? 0 : 1); return value; }
    @Override public int read(byte[] bytes, int offset, int length) throws IOException { int value = delegate.read(bytes, offset, length); count(Math.max(value, 0)); return value; }
    @Override public boolean isFinished() { return delegate.isFinished(); }
    @Override public boolean isReady() { return delegate.isReady(); }
    @Override public void setReadListener(ReadListener listener) { delegate.setReadListener(listener); }
  }
}
