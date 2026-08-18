package com.practiq.service;
import static org.junit.jupiter.api.Assertions.*;
import java.util.Set;
import org.junit.jupiter.api.Test;
class BillingRulesTest {
 @Test void organizationWinsOverProAndUnknownIsFree(){
  var service=new BillingService(null, id->Set.of(),"pro","organization");
  assertEquals("organization",service.membership(Set.of("pro","organization")));
  assertEquals("pro",service.membership(Set.of("pro")));
  assertEquals("free",service.membership(Set.of("other")));
 }
}
