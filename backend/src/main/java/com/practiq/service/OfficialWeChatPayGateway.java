package com.practiq.service;

import com.wechat.pay.java.core.RSAAutoCertificateConfig;
import com.wechat.pay.java.core.notification.NotificationParser;
import com.wechat.pay.java.core.notification.RequestParam;
import com.wechat.pay.java.service.payments.jsapi.JsapiServiceExtension;
import com.wechat.pay.java.service.payments.jsapi.model.Amount;
import com.wechat.pay.java.service.payments.jsapi.model.CloseOrderRequest;
import com.wechat.pay.java.service.payments.jsapi.model.Payer;
import com.wechat.pay.java.service.payments.jsapi.model.PrepayRequest;
import com.wechat.pay.java.service.payments.jsapi.model.QueryOrderByOutTradeNoRequest;
import com.wechat.pay.java.service.payments.model.Transaction;
import com.wechat.pay.java.service.refund.RefundService;
import com.wechat.pay.java.service.refund.model.AmountReq;
import com.wechat.pay.java.service.refund.model.CreateRequest;
import com.wechat.pay.java.service.refund.model.QueryByOutRefundNoRequest;
import java.util.LinkedHashMap;
import java.util.Map;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class OfficialWeChatPayGateway implements WeChatPayGateway {
  private final String appId, mchId, serial, privateKey, apiV3Key, notifyUrl, refundNotifyUrl;
  private volatile Services services;
  public OfficialWeChatPayGateway(@Value("${practiq.wechat.app-id:}") String appId, @Value("${practiq.wechat.pay.mch-id:}") String mchId, @Value("${practiq.wechat.pay.merchant-serial-number:}") String serial, @Value("${practiq.wechat.pay.merchant-private-key-path:}") String privateKey, @Value("${practiq.wechat.pay.api-v3-key:}") String apiV3Key, @Value("${practiq.wechat.pay.notify-url:}") String notifyUrl, @Value("${practiq.wechat.pay.refund-notify-url:}") String refundNotifyUrl) {
    this.appId=appId; this.mchId=mchId; this.serial=serial; this.privateKey=privateKey; this.apiV3Key=apiV3Key; this.notifyUrl=notifyUrl; this.refundNotifyUrl=refundNotifyUrl;
  }
  @Override public boolean available() { return configured(); }
  private boolean configured() { return nonBlank(appId)&&nonBlank(mchId)&&nonBlank(serial)&&nonBlank(privateKey)&&nonBlank(apiV3Key)&&nonBlank(notifyUrl)&&nonBlank(refundNotifyUrl); }
  private static boolean nonBlank(String s) { return s != null && !s.isBlank(); }
  private Services services() {
    if (!configured()) throw new Unavailable();
    Services value=services; if(value!=null)return value;
    synchronized(this) { if(services==null) try {
      var config=new RSAAutoCertificateConfig.Builder().merchantId(mchId).merchantSerialNumber(serial).privateKeyFromPath(privateKey).apiV3Key(apiV3Key).build();
      services=new Services(new JsapiServiceExtension.Builder().config(config).build(), new RefundService.Builder().config(config).build(), new NotificationParser(config));
    } catch (RuntimeException e) { throw new Unavailable(); } return services; }
  }
  @Override public Map<String,Object> prepay(String no,String description,int cents,String openid,String expiresAt) { try {
    var amount=new Amount(); amount.setTotal(cents); amount.setCurrency("CNY"); var payer=new Payer(); payer.setOpenid(openid);
    var request=new PrepayRequest(); request.setAppid(appId); request.setMchid(mchId); request.setDescription(description); request.setOutTradeNo(no); request.setTimeExpire(expiresAt); request.setNotifyUrl(notifyUrl); request.setAmount(amount); request.setPayer(payer);
    var response=services().jsapi.prepayWithRequestPayment(request); var value=new LinkedHashMap<String,Object>(); value.put("appId",response.getAppId()); value.put("timeStamp",response.getTimeStamp()); value.put("nonceStr",response.getNonceStr()); value.put("package",response.getPackageVal()); value.put("signType",response.getSignType()); value.put("paySign",response.getPaySign()); return value;
  } catch (Unavailable e) { throw e; } catch (RuntimeException e) { throw new Failed(); } }
  @Override public Payment query(String no) { try { var q=new QueryOrderByOutTradeNoRequest();q.setMchid(mchId);q.setOutTradeNo(no);return payment(services().jsapi.queryOrderByOutTradeNo(q)); } catch(Unavailable e){throw e;}catch(RuntimeException e){throw new Failed();} }
  @Override public void close(String no) { try { var q=new CloseOrderRequest();q.setMchid(mchId);q.setOutTradeNo(no);services().jsapi.closeOrder(q); } catch(Unavailable e){throw e;}catch(RuntimeException e){throw new Failed();} }
  @Override public Refund refund(String refundNo,String orderNo,String transactionId,int cents) { try { var amount=new AmountReq();amount.setRefund((long)cents);amount.setTotal((long)cents);amount.setCurrency("CNY");var request=new CreateRequest();request.setOutRefundNo(refundNo);request.setTransactionId(transactionId);request.setNotifyUrl(refundNotifyUrl);request.setAmount(amount);return refund(services().refund.create(request)); } catch(Unavailable e){throw e;}catch(RuntimeException e){throw new Failed();} }
  @Override public Refund queryRefund(String no) { try { var q=new QueryByOutRefundNoRequest();q.setOutRefundNo(no);return refund(services().refund.queryByOutRefundNo(q)); } catch(Unavailable e){throw e;}catch(RuntimeException e){throw new Failed();} }
  @Override public Payment paymentNotification(Map<String,String> headers,String raw) { return payment(parse(headers,raw,Transaction.class)); }
  @Override public Refund refundNotification(Map<String,String> headers,String raw) { return refund(parse(headers,raw,com.wechat.pay.java.service.refund.model.RefundNotification.class)); }
  private <T>T parse(Map<String,String> h,String raw,Class<T> type) { try { return services().parser.parse(new RequestParam.Builder().serialNumber(h.get("wechatpay-serial")).timestamp(h.get("wechatpay-timestamp")).nonce(h.get("wechatpay-nonce")).signature(h.get("wechatpay-signature")).body(raw).build(),type); }catch(Unavailable e){throw e;}catch(RuntimeException e){throw new Rejected();} }
  private Payment payment(Transaction t) { return new Payment(t.getOutTradeNo(),t.getAppid(),t.getMchid(),t.getAmount()==null?0:t.getAmount().getTotal(),t.getAmount()==null?null:t.getAmount().getCurrency(),t.getTransactionId(),t.getTradeState()==null?null:t.getTradeState().name()); }
  private Refund refund(com.wechat.pay.java.service.refund.model.Refund r) { return new Refund(r.getOutRefundNo(),r.getOutTradeNo(),r.getTransactionId(),r.getAmount()==null||r.getAmount().getRefund()==null?0:r.getAmount().getRefund().intValue(),r.getAmount()==null||r.getAmount().getTotal()==null?0:r.getAmount().getTotal().intValue(),r.getAmount()==null?null:r.getAmount().getCurrency(),r.getRefundId(),r.getStatus()==null?null:r.getStatus().name()); }
  private Refund refund(com.wechat.pay.java.service.refund.model.RefundNotification r) { return new Refund(r.getOutRefundNo(),r.getOutTradeNo(),r.getTransactionId(),r.getAmount()==null||r.getAmount().getRefund()==null?0:r.getAmount().getRefund().intValue(),r.getAmount()==null||r.getAmount().getTotal()==null?0:r.getAmount().getTotal().intValue(),r.getAmount()==null?null:r.getAmount().getCurrency(),r.getRefundId(),r.getRefundStatus()==null?null:r.getRefundStatus().name()); }
  private record Services(JsapiServiceExtension jsapi,RefundService refund,NotificationParser parser) {}
}
