package com.practiq.auth;

public interface WeChatClient {
  record Session(String openid, String unionid) {}

  Session exchange(String code);
}
