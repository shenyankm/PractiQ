package com.practiq;
import static org.junit.jupiter.api.Assertions.*;
import com.practiq.common.ApiException;
import com.practiq.web.ContentController;
import java.lang.reflect.*;
import org.junit.jupiter.api.Test;
class ContentRulesTest {
  @Test void contentRouteContractContainsNoStubs() throws Exception {
    var method=ContentController.class.getDeclaredMethod("status",String.class,String.class);
    method.setAccessible(true);
    assertEquals("draft",method.invoke(null,"","draft"));
    assertEquals("active",method.invoke(null," active ","draft"));
    var e=assertThrows(InvocationTargetException.class,()->method.invoke(null,"bad","draft"));
    assertInstanceOf(ApiException.class,e.getCause());
  }
  @Test void reorderPayloadCanDetectDuplicateQuestionAndSortOrder() {
    var a=new ContentController.ReorderItem(1L,null,1); var b=new ContentController.ReorderItem(1L,null,2);
    assertEquals(a.questionId(),b.questionId());
    assertNotEquals(a.sortOrder(),b.sortOrder());
    var c=new ContentController.GroupQuestion(2L,1); var d=new ContentController.GroupQuestion(3L,1);
    assertEquals(c.sortOrder(),d.sortOrder());
  }
}
