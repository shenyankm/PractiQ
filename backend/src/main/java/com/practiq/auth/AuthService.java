package com.practiq.auth;

import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import com.practiq.common.ApiException;
import com.practiq.service.MembershipService;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuthService {
  static final String ISS = "practiq-api";
  static final String AUD = "practiq-mobile";
  private final JdbcTemplate jdbc;
  private final MembershipService membership;
  private final ObjectMapper json;
  private final String secret;

  public AuthService(
      JdbcTemplate jdbc,
      MembershipService membership,
      ObjectMapper json,
      @Value("${practiq.auth-secret}") String secret) {
    this.jdbc = jdbc;
    this.membership = membership;
    this.json = json;
    this.secret = secret;
    if (secret == null || secret.isBlank()) {
      throw new IllegalStateException("AUTH_SECRET is required");
    }
  }

  public record Tokens(
      String accessToken,
      String refreshToken,
      OffsetDateTime accessExpiresAt,
      OffsetDateTime refreshExpiresAt) {}

  @Transactional
  public Map<String, Object> login(WeChatClient.Session identity) {
    var locks = new java.util.TreeSet<String>();
    locks.add("wechat:openid:" + identity.openid());
    if (identity.unionid() != null) locks.add("wechat:unionid:" + identity.unionid());
    for (String lock : locks) jdbc.query(
        "select pg_advisory_xact_lock(hashtextextended(?,0))",
        ps -> ps.setString(1, lock), rs -> null);
    var users = identity.unionid() == null
        ? jdbc.query("select u.id,u.status,w.openid,w.unionid from wechat_identities w join users u on u.id=w.user_id where w.openid=?", (rs, n) -> new Object[] {rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4)}, identity.openid())
        : jdbc.query("select u.id,u.status,w.openid,w.unionid from wechat_identities w join users u on u.id=w.user_id where w.openid=? or w.unionid=?", (rs, n) -> new Object[] {rs.getLong(1), rs.getString(2), rs.getString(3), rs.getString(4)}, identity.openid(), identity.unionid());
    if (users.size() > 1) throw ApiException.of(409, "IDENTITY_CONFLICT", "WeChat identities belong to different users");
    long id;
    String status;
    if (users.isEmpty()) {
      id = jdbc.queryForObject("insert into users default values returning id", Long.class);
      jdbc.update("insert into wechat_identities(user_id,openid,unionid) values(?,?,?)", id, identity.openid(), identity.unionid());
      status = "active";
    } else {
      Object[] user = users.getFirst(); id = (Long) user[0]; status = (String) user[1];
      if (identity.unionid() != null) jdbc.update(
          "update wechat_identities set openid=?,unionid=coalesce(unionid,?) where user_id=?",
          identity.openid(), identity.unionid(), id);
    }
    if (!"active".equals(status)) throw ApiException.of(403, "USER_INACTIVE", "User account is disabled");
    revokeSessions(id, "new_login");
    return issued(id, newSession(id));
  }

  @Transactional(noRollbackFor = ApiException.class)
  public Map<String, Object> refresh(String raw) {
    var rows = jdbc.query(
        "select rt.id,rt.session_id,s.user_id,s.absolute_expires_at,rt.expires_at,rt.used_at,rt.revoked_at,s.revoked_at,u.status "
            + "from refresh_tokens rt join auth_sessions s on s.id=rt.session_id join users u on u.id=s.user_id "
            + "where rt.token_hash=? for update",
        (rs, n) -> new Object[] {
          rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getLong(3),
          rs.getObject(4, OffsetDateTime.class), rs.getObject(5, OffsetDateTime.class),
          rs.getObject(6), rs.getObject(7), rs.getObject(8), rs.getString(9)
        },
        sha(raw));
    if (rows.isEmpty()) {
      throw invalidRefresh();
    }
    Object[] value = rows.getFirst();
    if (!"active".equals(value[8])) {
      throw ApiException.of(403, "USER_INACTIVE", "User account is disabled");
    }
    var now = OffsetDateTime.now(ZoneOffset.UTC);
    if (value[5] != null || value[6] != null) {
      revokeSessions((Long) value[2], "refresh_token_reuse");
      throw invalidRefresh();
    }
    if (value[7] != null
        || !((OffsetDateTime) value[3]).isAfter(now)
        || !((OffsetDateTime) value[4]).isAfter(now)) {
      throw invalidRefresh();
    }
    UUID next = UUID.randomUUID();
    String rawNext = randomToken();
    OffsetDateTime refreshExpiry = now.plusDays(30);
    if (refreshExpiry.isAfter((OffsetDateTime) value[3])) {
      refreshExpiry = (OffsetDateTime) value[3];
    }
    jdbc.update(
        "insert into refresh_tokens(id,session_id,token_hash,parent_token_id,expires_at) values(?,?,?,?,?)",
        next,
        value[1],
        sha(rawNext),
        value[0],
        refreshExpiry);
    jdbc.update(
        "update refresh_tokens set used_at=now(),replaced_by_token_id=? where id=?",
        next,
        value[0]);
    Tokens tokens = new Tokens(
        jwt((Long) value[2], (UUID) value[1], now.plusMinutes(10)),
        rawNext,
        now.plusMinutes(10),
        refreshExpiry);
    return issued((Long) value[2], tokens);
  }

  @Transactional
  public void logout(long id) {
    revokeSessions(id, "logout");
  }

  @Transactional
  public Map<String, Object> update(long id, String displayName, String avatarUrl) {
    if (displayName == null && avatarUrl == null) {
      throw validation("displayName or avatarUrl is required");
    }
    String name = displayName == null ? null : displayName.trim();
    if (name != null && (name.isEmpty() || name.length() > 64)) {
      throw validation("displayName must contain 1-64 characters");
    }
    String avatar = avatarUrl == null || avatarUrl.isBlank() ? null : avatarUrl.trim();
    if (avatar != null) {
      if (avatar.length() > 2048) {
        throw validation("avatarUrl is too long");
      }
      try {
        URI uri = URI.create(avatar);
        String scheme = uri.getScheme();
        if ((!"https".equalsIgnoreCase(scheme) && !"http".equalsIgnoreCase(scheme))
            || uri.getHost() == null) {
          throw new IllegalArgumentException();
        }
      } catch (IllegalArgumentException e) {
        throw validation("avatarUrl must be an HTTP URL");
      }
    }
    jdbc.update(
        "update users set display_name=coalesce(?,display_name),avatar_url=case when ? then ? else avatar_url end where id=?",
        name,
        avatarUrl != null,
        avatar,
        id);
    return user(id);
  }

  public Map<String, Object> user(long id) {
    var users = jdbc.query(
        "select u.id,u.display_name,u.avatar_url,u.status,u.role,u.trial_ends_at,u.paid_pro_at,coalesce(c.balance,0) from users u left join credit_accounts c on c.user_id=u.id where u.id=?",
        (rs, n) -> {
          var trial = rs.getObject(6, OffsetDateTime.class);
          var paid = rs.getObject(7, OffsetDateTime.class);
          var value = new LinkedHashMap<String, Object>();
          value.put("id", rs.getLong(1));
          value.put("displayName", rs.getString(2));
          value.put("avatarUrl", rs.getString(3));
          value.put("status", rs.getString(4));
          value.put("role", rs.getString(5));
          value.put("effectiveMembership", membership.effective(paid, trial));
          value.put("paidPro", membership.paidPro(paid));
          value.put("trialEndsAt", trial == null ? null : trial.toString());
          value.put("paidProAt", paid == null ? null : paid.toString());
          value.put("creditBalance", rs.getBigDecimal(8));
          return value;
        },
        id);
    if (users.isEmpty()) {
      throw ApiException.of(404, "NOT_FOUND", "User not found");
    }
    return users.getFirst();
  }

  public long require(String header) {
    String token = header != null && header.startsWith("Bearer ") ? header.substring(7) : "";
    try {
      String[] parts = token.split("\\.");
      if (parts.length != 3
          || !MessageDigest.isEqual(
              Base64.getUrlDecoder().decode(parts[2]),
              Base64.getUrlDecoder().decode(sig(parts[0] + "." + parts[1])))) {
        throw new IllegalArgumentException();
      }
      Map<String, Object> claims = json.readValue(
          Base64.getUrlDecoder().decode(parts[1]), new TypeReference<>() {});
      if (!ISS.equals(claims.get("iss"))
          || !AUD.equals(claims.get("aud"))
          || !"at+jwt".equals(claims.get("typ"))) {
        throw new IllegalArgumentException();
      }
      long id = Long.parseLong(String.valueOf(claims.get("sub")));
      UUID session = UUID.fromString(String.valueOf(claims.get("sid")));
      long expiry = ((Number) claims.get("exp")).longValue();
      Integer active = jdbc.queryForObject(
          "select count(*) from auth_sessions s join users u on u.id=s.user_id "
              + "where s.id=? and s.user_id=? and s.revoked_at is null and s.absolute_expires_at>now() and u.status='active'",
          Integer.class,
          session,
          id);
      if (expiry <= Instant.now().getEpochSecond() || active == null || active == 0) {
        throw new IllegalArgumentException();
      }
      return id;
    } catch (Exception e) {
      throw ApiException.of(401, "UNAUTHENTICATED", "Authentication required");
    }
  }

  private Tokens newSession(long id) {
    var now = OffsetDateTime.now(ZoneOffset.UTC);
    UUID session = UUID.randomUUID();
    var absoluteExpiry = now.plusDays(90);
    String refresh = randomToken();
    var refreshExpiry = now.plusDays(30);
    jdbc.update(
        "insert into auth_sessions(id,user_id,absolute_expires_at) values(?,?,?)",
        session,
        id,
        absoluteExpiry);
    jdbc.update(
        "insert into refresh_tokens(session_id,token_hash,expires_at) values(?,?,?)",
        session,
        sha(refresh),
        refreshExpiry);
    return new Tokens(
        jwt(id, session, now.plusMinutes(10)),
        refresh,
        now.plusMinutes(10),
        refreshExpiry);
  }

  private void revokeSessions(long id, String reason) {
    jdbc.update(
        "update refresh_tokens set revoked_at=now() where session_id in "
            + "(select id from auth_sessions where user_id=?) and revoked_at is null",
        id);
    jdbc.update(
        "update auth_sessions set revoked_at=now(),revoke_reason=? where user_id=? and revoked_at is null",
        reason,
        id);
  }

  private Map<String, Object> issued(long id, Tokens tokens) {
    return Map.of(
        "user", user(id),
        "tokens", Map.of(
            "accessToken", tokens.accessToken,
            "refreshToken", tokens.refreshToken,
            "expiresAt", tokens.accessExpiresAt.toInstant().toString(),
            "refreshExpiresAt", tokens.refreshExpiresAt.toInstant().toString(),
            "tokenType", "Bearer"));
  }

  private String jwt(long id, UUID session, OffsetDateTime expiry) {
    try {
      Map<String, Object> header = Map.of("alg", "HS256", "typ", "JWT");
      Map<String, Object> claims = new LinkedHashMap<>();
      claims.put("iss", ISS);
      claims.put("aud", AUD);
      claims.put("sub", String.valueOf(id));
      claims.put("sid", session.toString());
      claims.put("typ", "at+jwt");
      claims.put("iat", Instant.now().getEpochSecond());
      claims.put("exp", expiry.toInstant().getEpochSecond());
      claims.put("jti", UUID.randomUUID().toString());
      String first = b64(json.writeValueAsBytes(header));
      String second = b64(json.writeValueAsBytes(claims));
      return first + "." + second + "." + sig(first + "." + second);
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  private String sig(String value) {
    try {
      Mac mac = Mac.getInstance("HmacSHA256");
      mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
      return b64(mac.doFinal(value.getBytes(StandardCharsets.US_ASCII)));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  private String b64(byte[] value) {
    return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
  }

  private byte[] sha(String value) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
    } catch (Exception e) {
      throw new IllegalStateException(e);
    }
  }

  private String randomToken() {
    byte[] value = new byte[32];
    new SecureRandom().nextBytes(value);
    return b64(value);
  }

  private ApiException invalidRefresh() {
    return ApiException.of(401, "INVALID_REFRESH_TOKEN", "Invalid refresh token");
  }

  private ApiException validation(String message) {
    return ApiException.of(
        422,
        "VALIDATION_ERROR",
        "Invalid request",
        List.of(Map.of("field", "body", "message", message)));
  }
}
