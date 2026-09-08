package com.practiq.config;

import tools.jackson.databind.ObjectMapper;
import com.practiq.common.ApiError;
import com.practiq.common.ApiException;
import com.practiq.auth.AuthService;
import com.practiq.service.IdempotentWrites;
import java.io.ByteArrayInputStream;
import java.io.UncheckedIOException;
import java.util.ArrayList;
import org.springframework.dao.DataAccessException;
import org.springframework.transaction.TransactionException;
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
  private final StringRedisTemplate redis;
  private final ObjectMapper json;
  private final AuthService auth;
  private final IdempotentWrites writes;
  @Value("${practiq.app-origin}") private String origin;
  @Value("${practiq.redis-key-prefix:practiq}") private String prefix;

  public WebFilters(StringRedisTemplate redis, ObjectMapper json, AuthService auth, IdempotentWrites writes) { this.redis = redis; this.json = json; this.auth = auth; this.writes = writes; }
  @Override public int getOrder() { return Ordered.HIGHEST_PRECEDENCE; }

  @Override protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
    String requestId = request.getHeader("X-Request-ID");
    if (requestId == null || requestId.isBlank() || requestId.length() > 128) requestId = UUID.randomUUID().toString();
    request.setAttribute("requestId", requestId);
    securityHeaders(response, requestId);
    // Reject aliases before any raw-path policy or MVC's decoded/matrix-aware matching.
    if (!canonicalPath(request.getRequestURI())) { error(response, 400, "INVALID_PATH", "A canonical request path is required", null, requestId); return; }
    if (write(request) && !sameOrigin(request)) { error(response, 403, "INVALID_ORIGIN", "Cross-site requests are not allowed", null, requestId); return; }
    if ((jsonRequest(request) || wechatCallback(request)) && request.getContentLengthLong() > maximum(request)) { error(response, 413, "REQUEST_TOO_LARGE", "Request body is too large", null, requestId); return; }
    if (request.getRequestURI().startsWith("/api/") && !request.getRequestURI().startsWith("/api/health") && !rate(request)) { error(response, 429, "RATE_LIMITED", "Too many requests", null, requestId); return; }

    HttpServletRequest wrapped = cookieAuth((jsonRequest(request) || wechatCallback(request)) ? new LimitedRequest(request, maximum(request)) : request);
    try {
      idempotent(wrapped, response, chain, requestId);
    } catch (BodyTooLargeException ex) {
      if (!response.isCommitted()) error(response, 413, "REQUEST_TOO_LARGE", "Request body is too large", null, requestId);
    }
  }

  private void idempotent(HttpServletRequest request, HttpServletResponse response, FilterChain chain, String requestId) throws IOException, ServletException {
    String path = request.getRequestURI();
    if (!write(request) || !path.startsWith("/api/v1/") || path.startsWith("/api/v1/auth/") || wechatCallback(request)
        || path.equals("/api/v1/payment-orders") || path.matches("/api/v1/admin/payment-orders/[0-9]+/refund")) { chain.doFilter(request, response); return; }
    try {
      long user = auth.require(request.getHeader("Authorization"));
      String key = Optional.ofNullable(request.getHeader("Idempotency-Key")).orElse("").trim();
      if (key.isEmpty() || key.length() > 128 || key.indexOf('\r') >= 0 || key.indexOf('\n') >= 0) throw ApiException.of(422, "VALIDATION_ERROR", "A stable Idempotency-Key of 1-128 characters is required");
      try {
        // Redis is a required availability gate, never the source of idempotency truth.
        if (redis.opsForValue().increment(prefix + ":idempotency-availability") == null) throw new IllegalStateException();
      } catch (Exception unavailable) { throw ApiException.of(503, "IDEMPOTENCY_UNAVAILABLE", "Idempotent writes are temporarily unavailable"); }
      byte[] body;
      HttpServletRequest readable = request;
      String type = Optional.ofNullable(request.getContentType()).orElse("");
      if (type.toLowerCase().startsWith("multipart/form-data")) {
        // Preserve part order: single MultipartFile binding consumes the first same-name file.
        // Hash logical parts, not the random transport boundary. Servlet containers retain parsed parts.
        var fingerprints = new ArrayList<Object>();
        for (var part : request.getParts()) {
          if (part.getSize() > 26L * 1024 * 1024) throw new BodyTooLargeException();
          try (var input = part.getInputStream()) { fingerprints.add(List.of(part.getName(), Optional.ofNullable(part.getSubmittedFileName()).orElse(""), Optional.ofNullable(part.getContentType()).orElse(""), Base64.getEncoder().encodeToString(digest(input.readAllBytes())))); }
        }
        body = json.writeValueAsBytes(fingerprints);
        type = "multipart/form-data";
      } else {
        body = new LimitedInputStream(request.getInputStream(), maximum(request)).readAllBytes();
        readable = new BufferedRequest(request, body);
      }
      byte[] hash = digest((type + "\n" + Optional.ofNullable(request.getQueryString()).orElse("") + "\n" + Base64.getEncoder().encodeToString(body)).getBytes(StandardCharsets.UTF_8));
      HttpServletRequest executionRequest = readable;
      var buffered = new ContentCachingResponseWrapper(response);
      var result = writes.execute(user, request.getMethod(), path, key, hash, body, () -> {
        try { chain.doFilter(executionRequest, buffered); }
        catch (IOException ex) { throw new UncheckedIOException(ex); }
        catch (ServletException ex) { throw new FilterFailure(ex); }
        Map<String, String> headers = new LinkedHashMap<>();
        for (String name : buffered.getHeaderNames()) if (name.equalsIgnoreCase("Content-Type") || name.equalsIgnoreCase("Location")) headers.put(name, buffered.getHeader(name));
        return new IdempotentWrites.Result(buffered.getStatus(), buffered.getContentAsByteArray(), headers);
      });
      // Nothing is sent until the transaction, including deferred schema constraints, has committed.
      response.setStatus(result.status());
      result.headers().forEach(response::setHeader);
      response.getOutputStream().write(result.body());
    } catch (ApiException ex) { response.resetBuffer(); error(response, ex.status, ex.code, ex.getMessage(), ex.details, requestId); }
    catch (DataAccessException | TransactionException ex) { response.resetBuffer(); error(response, 503, "IDEMPOTENCY_UNAVAILABLE", "Idempotent writes are temporarily unavailable", null, requestId); }
    catch (UncheckedIOException ex) { throw ex.getCause(); }
    catch (FilterFailure ex) { throw (ServletException) ex.getCause(); }
  }

  private static byte[] digest(byte[] value) { try { return MessageDigest.getInstance("SHA-256").digest(value); } catch (Exception ex) { throw new IllegalStateException(ex); } }
  private static final class FilterFailure extends RuntimeException { FilterFailure(ServletException cause) { super(cause); } }
  static final class BufferedRequest extends HttpServletRequestWrapper {
    private final byte[] body;
    BufferedRequest(HttpServletRequest request, byte[] body) { super(request); this.body = body; }
    @Override public ServletInputStream getInputStream() {
      var input = new ByteArrayInputStream(body);
      return new ServletInputStream() {
        @Override public int read() { return input.read(); }
        @Override public int read(byte[] bytes, int offset, int length) { return input.read(bytes, offset, length); }
        @Override public boolean isFinished() { return input.available() == 0; }
        @Override public boolean isReady() { return true; }
        @Override public void setReadListener(ReadListener listener) { throw new UnsupportedOperationException("Synchronous request body"); }
      };
    }
    @Override public java.io.BufferedReader getReader() { return new java.io.BufferedReader(new java.io.InputStreamReader(getInputStream(), StandardCharsets.UTF_8)); }
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

  private static boolean canonicalPath(String path) {
    // Current ASCII path variables are numeric IDs, fixed actions or URL-safe invitation tokens.
    // Keep UTF-8 non-ASCII segment encoding; encoded ASCII could alias a policy prefix or delimiter.
    if (!path.startsWith("/") || path.contains(";") || path.contains("//")
        || path.matches(".*%[0-7][0-9a-fA-F].*") || path.chars().anyMatch(Character::isISOControl)) return false;
    try {
      var uri = java.net.URI.create(path);
      return uri.getRawQuery() == null && uri.getRawFragment() == null && path.equals(uri.normalize().getRawPath())
          && !uri.getPath().chars().anyMatch(Character::isISOControl);
    } catch (IllegalArgumentException invalid) { return false; }
  }

  private boolean write(HttpServletRequest request) { return Set.of("POST", "PUT", "PATCH", "DELETE").contains(request.getMethod()); }
  private boolean jsonRequest(HttpServletRequest request) { String type = Optional.ofNullable(request.getContentType()).orElse("").toLowerCase(); return type.startsWith("application/json") || type.matches(".*\\+json(?:;.*)?"); }
  private boolean wechatCallback(HttpServletRequest request) { return request.getRequestURI().equals("/api/v1/payments/wechat/notify") || request.getRequestURI().equals("/api/v1/payments/wechat/refund-notify"); }
  private long maximum(HttpServletRequest request) { String path = request.getRequestURI(); if (wechatCallback(request)) return 1024 * 1024L; if (path.startsWith("/api/v1/auth/")) return 16 * 1024L; if (path.startsWith("/api/v1/import-jobs/") && path.endsWith("/file")) return 25L * 1024 * 1024 * 4 / 3 + 1024 * 1024; return 1024 * 1024L; }
  private boolean sameOrigin(HttpServletRequest request) { String supplied = Optional.ofNullable(request.getHeader("Origin")).orElse(request.getHeader("Referer")); if (supplied == null || supplied.isBlank()) return true; try { var actual = java.net.URI.create(supplied); var expected = java.net.URI.create(origin); return actual.getScheme().equals(expected.getScheme()) && actual.getAuthority().equals(expected.getAuthority()); } catch (Exception ex) { return false; } }
  private boolean rate(HttpServletRequest request) { try { String key = prefix + ":rate-limit:api:ip:" + Optional.ofNullable(request.getRemoteAddr()).orElse("unknown"); Long value = redis.opsForValue().increment(key); if (value != null && value == 1) redis.expire(key, Duration.ofMinutes(1)); return value == null || value <= 300; } catch (Exception ex) { return true; } }
  private void securityHeaders(HttpServletResponse response, String id) { response.setHeader("Cache-Control", "no-store"); response.setHeader("X-Request-ID", id); response.setHeader("X-Content-Type-Options", "nosniff"); response.setHeader("X-Frame-Options", "DENY"); response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin"); response.setHeader("Content-Security-Policy", "default-src 'self'; object-src 'none'; frame-ancestors 'none'"); }
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
