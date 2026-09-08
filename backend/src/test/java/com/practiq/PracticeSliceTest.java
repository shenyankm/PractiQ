package com.practiq;

import static org.junit.jupiter.api.Assertions.*;
import com.practiq.common.PageSupport;
import com.practiq.service.GradingService;
import java.util.*;
import org.junit.jupiter.api.Test;

class PracticeSliceTest {
 @Test void answerValidationGradeSemanticsArePreserved(){var grading=new GradingService();assertTrue(grading.grade("choice",Map.of("selected",List.of("A","B")),Map.of("selected",List.of("B","A"))));assertFalse(grading.grade("choice",Map.of("selected",List.of("A")),Map.of("selected",List.of("B"))));assertTrue(grading.grade("true_false",Map.of("value",true),Map.of("value",true)));assertFalse(grading.grade("fill_blank",Map.of("value",List.of("x")),Map.of("value",List.of())));assertFalse(grading.grade("fill_blank",Map.of("value",List.of("x")),Map.of("value",List.of("x","extra"))));}
 @Test void cursorPagingContractIsOpaqueAndRejectsMalformedValues(){assertEquals(0,PageSupport.cursor(""));assertEquals(100,PageSupport.cursor(PageSupport.next(0,100)));assertThrows(RuntimeException.class,()->PageSupport.cursor("not-a-cursor"));}
}
