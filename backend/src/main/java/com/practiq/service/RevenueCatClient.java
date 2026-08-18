package com.practiq.service;

import java.util.Set;

public interface RevenueCatClient {
  Set<String> activeEntitlementIds(String appUserId);
}
