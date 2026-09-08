package com.practiq.service;

import java.util.Map;

/** Narrow external trust boundary; production implementation uses wechatpay-java. */
public interface WeChatPayGateway {
  record Payment(String merchantOrderNo, String appId, String mchId, int amountCents, String currency, String transactionId, String state) {}
  record Refund(String merchantRefundNo, String merchantOrderNo, String transactionId, int amountCents, int totalAmountCents, String currency, String refundId, String state) {}
  Map<String, Object> prepay(String merchantOrderNo, String description, int amountCents, String openid, String expiresAt);
  Payment query(String merchantOrderNo);
  void close(String merchantOrderNo);
  Refund refund(String merchantRefundNo, String merchantOrderNo, String transactionId, int amountCents);
  Refund queryRefund(String merchantRefundNo);
  Payment paymentNotification(Map<String, String> headers, String rawBody);
  Refund refundNotification(Map<String, String> headers, String rawBody);
  boolean available();

  final class Unavailable extends RuntimeException { public Unavailable() { super("WeChat Pay is unavailable"); } }
  final class Failed extends RuntimeException { public Failed() { super("WeChat Pay request failed"); } }
  final class Rejected extends RuntimeException { public Rejected() { super("WeChat Pay notification rejected"); } }
}
