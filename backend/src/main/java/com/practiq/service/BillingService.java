package com.practiq.service;

import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

@Service public class BillingService {
  private final JdbcTemplate db; private final RevenueCatClient revenueCat; private final String pro, organization;
  public BillingService(JdbcTemplate db, RevenueCatClient revenueCat, @Value("${practiq.revenuecat.pro-entitlement-id:}") String pro, @Value("${practiq.revenuecat.organization-entitlement-id:organization}") String organization){this.db=db;this.revenueCat=revenueCat;this.pro=pro;this.organization=organization;}
  public String sync(long userId,String appUserId){String membership=membership(revenueCat.activeEntitlementIds(appUserId));db.update("update users set membership=? where id=? and membership is distinct from ?",membership,userId,membership); return membership;}
  public int syncAppUsers(Collection<String> appUserIds){if(appUserIds.isEmpty())return 0;var ids=appUserIds.stream().filter(s->s!=null&&!s.isBlank()).limit(100).toList();if(ids.isEmpty())return 0;String marks=String.join(",",Collections.nCopies(ids.size(),"?"));var users=db.query("select id,revenuecat_app_user_id::text from users where revenuecat_app_user_id::text in ("+marks+")",(r,n)->new Object[]{r.getLong(1),r.getString(2)},ids.toArray());for(var u:users)sync((Long)u[0],(String)u[1]);return users.size();}
  String membership(Set<String> ids){if(ids.contains(organization))return "organization";return ids.contains(pro)?"pro":"free";}
}
