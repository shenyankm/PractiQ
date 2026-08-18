package com.practiq.service;
import java.time.*;
import org.springframework.stereotype.Service;
@Service public class MembershipService { public String effective(String membership, OffsetDateTime trialEndsAt){ if("pro".equals(membership)||"organization".equals(membership)) return membership; return trialEndsAt!=null&&trialEndsAt.isAfter(OffsetDateTime.now(ZoneOffset.UTC))?"pro":"free"; } public boolean atLeast(String actual,String required){return rank(actual)>=rank(required);} private int rank(String v){return switch(v){case "organization"->2;case "pro"->1;default->0;};} }
