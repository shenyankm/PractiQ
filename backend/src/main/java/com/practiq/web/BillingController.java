package com.practiq.web;

import com.practiq.auth.AuthService;
import com.practiq.common.*;
import com.practiq.service.BillingService;
import java.security.MessageDigest;
import java.util.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.*;

@RestController @RequestMapping("/api/v1/billing") public class BillingController {
 private final AuthService auth; private final BillingService billing; private final String webhook;
 public BillingController(AuthService auth,BillingService billing,@Value("${practiq.revenuecat.webhook-authorization:}")String webhook){this.auth=auth;this.billing=billing;this.webhook=webhook;}
 @PostMapping("/sync") ApiResponse<?> sync(@RequestHeader(value="Authorization",required=false)String h){long id=auth.require(h);var user=auth.user(id);billing.sync(id,String.valueOf(user.get("revenuecatAppUserId")));return ApiResponse.ok(auth.user(id));}
 @PostMapping("/revenuecat/webhook") ApiResponse<?> webhook(@RequestHeader(value="Authorization",required=false)String supplied,@RequestBody Webhook body){if(!MessageDigest.isEqual((supplied==null?"":supplied).getBytes(java.nio.charset.StandardCharsets.UTF_8),webhook.getBytes(java.nio.charset.StandardCharsets.UTF_8)))throw ApiException.of(401,"INVALID_WEBHOOK_AUTH","Invalid webhook authorization");Set<String> ids=new LinkedHashSet<>();if(body.event()!=null){for(String k:List.of("app_user_id","original_app_user_id")){Object v=body.event().get(k);if(v instanceof String s&&!s.isBlank())ids.add(s);}for(String k:List.of("aliases","transferred_from","transferred_to","redeemed_from","redeemed_by")){Object v=body.event().get(k);if(v instanceof Collection<?> c)for(Object x:c)if(x instanceof String s&&!s.isBlank())ids.add(s);}}return ApiResponse.ok(Map.of("processedUsers",billing.syncAppUsers(ids)));}
 record Webhook(Map<String,Object> event){}
}
