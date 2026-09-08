package com.practiq.web;

import com.practiq.auth.AuthService;
import com.practiq.common.ApiException;
import com.practiq.common.ApiResponse;
import com.practiq.service.PaymentService;
import com.practiq.service.WeChatPayGateway;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import java.util.Map;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1")
public class PaymentController {
  private final AuthService auth; private final PaymentService payments;
  public PaymentController(AuthService auth, PaymentService payments) { this.auth=auth;this.payments=payments; }
  record Create(@NotBlank String kind) {}
  @PostMapping("/payment-orders") ApiResponse<?> create(@RequestHeader(value="Authorization",required=false) String header,@RequestHeader("Idempotency-Key") String key,@Valid @RequestBody Create body) { return run(()->ApiResponse.ok(payments.create(auth.require(header),body.kind(),key))); }
  @GetMapping("/payment-orders/{id}") ApiResponse<?> get(@RequestHeader(value="Authorization",required=false) String header,@PathVariable long id) { return run(()->ApiResponse.ok(payments.get(auth.require(header),id))); }
  @PostMapping(value="/payments/wechat/notify",consumes="application/json") ResponseEntity<Void> notify(@RequestHeader Map<String,String> headers,@RequestBody byte[] raw) { run(()->{payments.paymentNotification(wechatHeaders(headers),new String(raw,java.nio.charset.StandardCharsets.UTF_8));return null;}); return ResponseEntity.ok().build(); }
  @PostMapping(value="/payments/wechat/refund-notify",consumes="application/json") ResponseEntity<Void> refundNotify(@RequestHeader Map<String,String> headers,@RequestBody byte[] raw) { run(()->{payments.refundNotification(wechatHeaders(headers),new String(raw,java.nio.charset.StandardCharsets.UTF_8));return null;}); return ResponseEntity.ok().build(); }
  @GetMapping("/admin/payment-orders") ApiResponse<?> admin(@RequestHeader(value="Authorization",required=false) String header) { return run(()->ApiResponse.ok(payments.admin(auth.require(header)))); }
  @PostMapping("/admin/payment-orders/{id}/refund") ApiResponse<?> refund(@RequestHeader(value="Authorization",required=false) String header,@PathVariable long id) { return run(()->ApiResponse.ok(payments.refund(auth.require(header),id))); }
  private Map<String,String> wechatHeaders(Map<String,String> headers) { var value=new java.util.HashMap<String,String>(); headers.forEach((k,v)->value.put(k.toLowerCase(java.util.Locale.ROOT),v)); return value; }
  private <T>T run(java.util.concurrent.Callable<T> call) { try{return call.call();}catch(WeChatPayGateway.Unavailable e){throw ApiException.of(503,"WECHAT_PAY_UNAVAILABLE","WeChat Pay is temporarily unavailable");}catch(WeChatPayGateway.Failed e){throw ApiException.of(502,"WECHAT_PAY_FAILED","WeChat Pay request failed");}catch(WeChatPayGateway.Rejected e){throw ApiException.of(401,"INVALID_WECHAT_SIGNATURE","Invalid WeChat signature");}catch(ApiException e){throw e;}catch(RuntimeException e){throw e;}catch(Exception e){throw new IllegalStateException(e);} }
}
