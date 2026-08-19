package com.practiq.service;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import org.springframework.stereotype.Service;

@Service
public class MembershipService {
  public String effective(OffsetDateTime paidProAt, OffsetDateTime trialEndsAt) {
    return paidProAt != null
        || trialEndsAt != null && trialEndsAt.isAfter(OffsetDateTime.now(ZoneOffset.UTC))
        ? "pro"
        : "free";
  }

  public boolean paidPro(OffsetDateTime paidProAt) {
    return paidProAt != null;
  }
}
