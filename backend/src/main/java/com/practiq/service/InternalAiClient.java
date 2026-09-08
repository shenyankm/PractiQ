package com.practiq.service;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.MediaType;
import org.springframework.http.client.SimpleClientHttpRequestFactory;
import org.springframework.stereotype.Component;
import org.springframework.web.client.RestClient;
import org.springframework.web.client.RestClientResponseException;

@Component
public class InternalAiClient {
  public record Usage(UUID callKey, String modelId, int inputTokens, int outputTokens, String callKind) {}
  public record Result(JsonNode data, List<Usage> usage) {}
  public static class CallFailed extends RuntimeException {
    private final List<Usage> usage; private final JsonNode error;
    CallFailed(String message, List<Usage> usage, JsonNode error, Throwable cause) { super(message, cause); this.usage = usage; this.error = error; }
    public List<Usage> usage() { return usage; } public JsonNode error() { return error; }
  }

  private final RestClient rest; private final ObjectMapper json; private final String token; private final boolean enabled;
  InternalAiClient(ObjectMapper json, @Value("${practiq.ai.base-url}") String baseUrl, @Value("${practiq.ai.service-token:}") String token, @Value("${practiq.ai.enabled:true}") boolean enabled) {
    this.json = json; this.token = token == null ? "" : token.trim(); this.enabled = enabled;
    var requests = new SimpleClientHttpRequestFactory(); requests.setConnectTimeout(5_000); requests.setReadTimeout(185_000);
    this.rest = RestClient.builder().baseUrl(baseUrl.replaceAll("/+$", "")).requestFactory(requests).build();
  }
  public boolean available() { return enabled && !token.isBlank(); }

  public Result call(String operation, JsonNode payload) {
    if (!available()) throw new CallFailed("AI service is not configured", List.of(), json.createObjectNode().put("code", "AI_UNAVAILABLE"), null);
    try {
      String body = rest.post().uri("/api/v1/ai/" + operation).contentType(MediaType.APPLICATION_JSON).accept(MediaType.APPLICATION_JSON).header("Authorization", "Bearer " + token).body(payload).retrieve().body(String.class);
      JsonNode root = json.readTree(body); if (root == null || !root.has("data")) throw new IllegalStateException("AI response envelope is invalid"); return new Result(root.get("data"), usage(root));
    } catch (RestClientResponseException error) {
      try { JsonNode root = json.readTree(error.getResponseBodyAsString()); JsonNode detail = root.path("error"); throw new CallFailed(detail.path("message").asText("AI request failed"), usage(root), detail, error); }
      catch (CallFailed failure) { throw failure; }
      catch (Exception ignored) { throw new CallFailed("AI request failed", List.of(), json.createObjectNode().put("code", "AI_HTTP_ERROR").put("status", error.getStatusCode().value()), error); }
    } catch (CallFailed error) { throw error; }
    catch (Exception error) { throw new CallFailed("AI service request failed", List.of(), json.createObjectNode().put("code", "AI_NETWORK_ERROR"), error); }
  }

  private List<Usage> usage(JsonNode root) {
    var values = new ArrayList<Usage>(); JsonNode items = root.path("meta").path("usage"); if (!items.isArray()) return values;
    for (JsonNode item : items) try { values.add(new Usage(UUID.fromString(item.path("callKey").asText()), item.path("modelId").asText(), item.path("inputTokens").asInt(), item.path("outputTokens").asInt(), item.path("callKind").asText())); } catch (RuntimeException ignored) { /* malformed usage is not billable */ }
    return values;
  }
}
