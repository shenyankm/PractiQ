package com.practiq.auth;

import com.practiq.common.ApiException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

@Service
public class FirstAdminBootstrapService {
  private final JdbcTemplate jdbc;

  public FirstAdminBootstrapService(JdbcTemplate jdbc) { this.jdbc = jdbc; }

  @Transactional
  public void bootstrap(String openid) {
    if (openid == null || openid.isBlank()) throw new IllegalArgumentException("FIRST_ADMIN_OPENID is required");
    jdbc.query("select pg_advisory_xact_lock(hashtextextended('first-admin-bootstrap',0))", rs -> null);
    var users = jdbc.query("select u.id,u.status from wechat_identities w join users u on u.id=w.user_id where w.openid=? for update", (rs, n) -> new Object[] {rs.getLong(1), rs.getString(2)}, openid);
    if (users.isEmpty()) throw ApiException.of(404, "NOT_FOUND", "Active WeChat identity not found");
    Object[] user = users.getFirst();
    if (!"active".equals(user[1])) throw ApiException.of(409, "USER_INACTIVE", "WeChat identity is inactive");
    if (jdbc.queryForObject("select count(*) from users where role='admin'", Integer.class) != 0) throw ApiException.of(409, "ADMIN_EXISTS", "An administrator already exists");
    long id = (Long) user[0];
    jdbc.update("update users set role='admin' where id=?", id);
    jdbc.update("insert into admin_audits(actor_user_id,target_user_id,action,details) values(null,?,'bootstrap','{}'::jsonb)", id);
  }
}
