package com.practiq.web;

import com.practiq.auth.AuthService;
import com.practiq.common.*;
import com.practiq.service.PracticeService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import java.util.*;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

@RestController @RequestMapping("/api/v1/practice-sessions")
public class PracticeController {
 private final AuthService auth; private final PracticeService practice;
 PracticeController(AuthService auth,PracticeService practice){this.auth=auth;this.practice=practice;} private long user(String h){return auth.require(h);} private static void positive(long n){if(n<1)throw ApiException.of(422,"VALIDATION_ERROR","Invalid request");}
 public record Start(@Positive long bankId,String sessionType,@Positive @Max(500) Integer questionCount,String mode,@Size(max=64) String questionTypeId,boolean allQuestions){}
 public record Answer(@Positive long questionId,Map<String,Object> answerPayload,@PositiveOrZero Integer durationMs){}
 @GetMapping @SuppressWarnings("unchecked") ApiResponse<?> list(@RequestHeader(value="Authorization",required=false)String h,@RequestParam(defaultValue="")String status,@RequestParam(defaultValue="")String cursor,@RequestParam(required=false)Integer limit,@RequestParam(required=false)String updatedSince){long u=user(h);var p=practice.list(u,status,cursor,limit,updatedSince);return ApiResponse.ok(p.get("items"),(Map<String,Object>)p.get("meta"));}
 @PostMapping ResponseEntity<ApiResponse<?>> start(@RequestHeader(value="Authorization",required=false)String h,@Valid @RequestBody Start b){return ResponseEntity.status(201).body(ApiResponse.ok(practice.start(user(h),b.bankId(),b.sessionType(),b.questionCount(),b.mode(),b.questionTypeId(),b.allQuestions())));}
 @GetMapping("/{id}") ApiResponse<?> get(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long id){positive(id);return ApiResponse.ok(practice.get(user(h),id));}
 @GetMapping("/{id}/questions") ApiResponse<?> questions(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long id){positive(id);return ApiResponse.ok(practice.questions(user(h),id));}
 @GetMapping("/{id}/question-page") ApiResponse<?> page(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long id,@RequestParam(required=false)@PositiveOrZero Integer index){positive(id);return ApiResponse.ok(practice.questionPage(user(h),id,index));}
 @GetMapping("/{id}/results") ApiResponse<?> results(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long id){positive(id);return ApiResponse.ok(practice.results(user(h),id));}
 @PostMapping("/{id}/answers") ResponseEntity<ApiResponse<?>> answer(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long id,@Valid @RequestBody Answer b){positive(id);return ResponseEntity.status(201).body(ApiResponse.ok(practice.submit(user(h),id,b.questionId(),b.answerPayload()==null?Map.of():b.answerPayload(),b.durationMs())));}
 @PostMapping("/{id}/complete") ApiResponse<?> complete(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long id){positive(id);return ApiResponse.ok(practice.complete(user(h),id,"completed"));}
 @PostMapping("/{id}/abandon") ApiResponse<?> abandon(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long id){positive(id);return ApiResponse.ok(practice.complete(user(h),id,"abandoned"));}
}
