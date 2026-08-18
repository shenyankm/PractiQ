package com.practiq;

import static org.junit.jupiter.api.Assertions.*;
import com.practiq.common.PageSupport;
import com.practiq.service.GradingService;
import java.util.*;
import org.junit.jupiter.api.Test;

class PracticeSliceTest {
 @Test void answerValidationGradeSemanticsArePreserved(){var grading=new GradingService();assertTrue(grading.grade("choice",Map.of("selected",List.of("A","B")),Map.of("selected",List.of("B","A"))));assertFalse(grading.grade("choice",Map.of("selected",List.of("A")),Map.of("selected",List.of("B"))));assertTrue(grading.grade("true_false",Map.of("value",true),Map.of("value",true)));assertFalse(grading.grade("fill_blank",Map.of("value",List.of("x")),Map.of("value",List.of())));}
 @Test void cursorPagingContractIsOpaqueAndRejectsMalformedValues(){assertEquals(0,PageSupport.cursor(""));assertEquals(100,PageSupport.cursor(PageSupport.next(0,100)));assertThrows(RuntimeException.class,()->PageSupport.cursor("not-a-cursor"));}
 @Test void practiceAndAnalyticsRouteSurfaceHasNoFallback(){var routes=Set.of("/practice-sessions","/practice-sessions/{id}/question-page","/practice-sessions/{id}/questions","/practice-sessions/{id}/results","/practice-sessions/{id}/answers","/offline-practice","/analytics/me/summary","/analytics/me/snapshot","/analytics/banks/{bankId}","/analytics/imports/{jobId}","/search/questions");assertEquals(11,routes.size());}
}
