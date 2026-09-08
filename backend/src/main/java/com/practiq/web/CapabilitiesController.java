package com.practiq.web;

import com.practiq.common.ApiResponse;
import com.practiq.service.WeChatPayGateway;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class CapabilitiesController {
  private final WeChatPayGateway pay;
  private final boolean ai;

  CapabilitiesController(WeChatPayGateway pay, @Value("${practiq.ai.service-token:}") String token) {
    this.pay = pay;
    this.ai = token != null && !token.isBlank();
  }

  @GetMapping("/capabilities")
  ApiResponse<?> capabilities() {
    return ApiResponse.ok(Map.of("wechatPay", pay.available(), "ai", ai, "uploads", true));
  }
}
