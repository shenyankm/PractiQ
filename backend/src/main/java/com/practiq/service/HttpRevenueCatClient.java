package com.practiq.service;

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
import java.util.HashSet;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class HttpRevenueCatClient implements RevenueCatClient {
  private final HttpClient http;
  private final ObjectMapper json;
  private final String projectId, secret;
  public HttpRevenueCatClient(ObjectMapper json, @Value("${practiq.revenuecat.project-id:}") String projectId, @Value("${practiq.revenuecat.secret-api-key:}") String secret) { this(HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(10)).build(), json, projectId, secret); }
  HttpRevenueCatClient(HttpClient http, ObjectMapper json, String projectId, String secret) { this.http=http; this.json=json; this.projectId=projectId; this.secret=secret; }
  public Set<String> activeEntitlementIds(String appUserId) {
    if (projectId.isBlank() || secret.isBlank()) throw ApiException.of(502,"REVENUECAT_UNAVAILABLE","Subscription verification is temporarily unavailable");
    try {
      String url="https://api.revenuecat.com/v2/projects/"+enc(projectId)+"/customers/"+enc(appUserId)+"/active_entitlements?limit=100";
      var response=http.send(HttpRequest.newBuilder(URI.create(url)).timeout(Duration.ofSeconds(10)).header("Accept","application/json").header("Authorization","Bearer "+secret).GET().build(),HttpResponse.BodyHandlers.ofString());
      if(response.statusCode()==404)return Set.of();
      if(response.statusCode()!=200)throw unavailable();
      JsonNode items=json.readTree(response.body()).path("items");
      if(!items.isArray())throw ApiException.of(502,"REVENUECAT_INVALID_RESPONSE","Subscription verification returned invalid data");
      Set<String> ids=new HashSet<>(); for(JsonNode item:items)if(item.path("entitlement_id").isTextual())ids.add(item.path("entitlement_id").asText()); return ids;
    } catch(ApiException e){throw e;} catch(Exception e){throw unavailable();}
  }
  private ApiException unavailable(){return ApiException.of(502,"REVENUECAT_UNAVAILABLE","Subscription verification is temporarily unavailable");}
  private static String enc(String value){return URLEncoder.encode(value,StandardCharsets.UTF_8).replace("+","%20");}
}
