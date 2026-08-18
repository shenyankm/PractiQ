package com.practiq;
import static org.junit.jupiter.api.Assertions.*;
import com.practiq.web.StudyGroupController;
import java.lang.reflect.Method;
import java.util.Arrays;
import org.junit.jupiter.api.Test;
import org.springframework.web.bind.annotation.*;
class StudyGroupSurfaceTest {
 @Test void exposesEveryStudyGroupMutation(){
  var names=Arrays.stream(StudyGroupController.class.getDeclaredMethods()).map(Method::getName).toList();
  assertTrue(names.containsAll(java.util.List.of("list","create","get","update","delete","add","remove","stats","link","unlink")));
  assertEquals("/api/v1/study-groups",StudyGroupController.class.getAnnotation(RequestMapping.class).value()[0]);
 }
}
