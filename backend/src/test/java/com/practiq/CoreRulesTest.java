package com.practiq;

import static org.junit.jupiter.api.Assertions.*;

import com.practiq.common.ApiException;
import com.practiq.common.PageSupport;
import com.practiq.service.GradingService;
import com.practiq.service.MembershipService;
import java.time.OffsetDateTime;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

class CoreRulesTest {
  @Test
  void cursorRoundTrip() {
    assertEquals(0, PageSupport.cursor(""));
    assertEquals(20, PageSupport.cursor(PageSupport.next(0, 20)));
    assertThrows(ApiException.class, () -> PageSupport.cursor("bad"));
  }

  @Test
  void trialAndPermanentPaymentGrantPro() {
    var service = new MembershipService();
    assertEquals("pro", service.effective(null, OffsetDateTime.now().plusDays(1)));
    assertEquals("free", service.effective(null, OffsetDateTime.now().minusDays(1)));
    assertEquals("pro", service.effective(OffsetDateTime.now().minusDays(30), null));
  }

  @Test
  void gradesChoiceAndBlanks() {
    var service = new GradingService();
    assertTrue(service.grade(
        "choice", Map.of("selected", List.of("A", "B")), Map.of("selected", List.of("B", "A"))));
    assertTrue(service.grade(
        "fill_blank",
        Map.of("value", List.of("Paris", "France")),
        Map.of("value", List.of(" paris ", "france"))));
    assertNull(service.grade("short_answer", Map.of(), Map.of()));
  }
}
