package com.practiq.web;

import com.practiq.auth.AuthService;
import com.practiq.common.ApiResponse;
import com.practiq.service.StudyGroupService;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

@RestController @RequestMapping("/api/v1/study-groups") public class StudyGroupController {
 private final AuthService auth;private final StudyGroupService groups; public StudyGroupController(AuthService auth,StudyGroupService groups){this.auth=auth;this.groups=groups;} private long user(String h){return auth.require(h);} private static void id(long x){if(x<1)throw com.practiq.common.ApiException.of(422,"VALIDATION_ERROR","Invalid request");}
 @GetMapping ApiResponse<?> list(@RequestHeader(value="Authorization",required=false)String h){return ApiResponse.ok(groups.list(user(h)));}
 @PostMapping ResponseEntity<ApiResponse<?>> create(@RequestHeader(value="Authorization",required=false)String h,@Valid @RequestBody Create body){return ResponseEntity.status(201).body(ApiResponse.ok(groups.create(user(h),body.name(),body.description())));}
 @GetMapping("/{groupId}") ApiResponse<?> get(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long groupId){id(groupId);return ApiResponse.ok(groups.get(user(h),groupId));}
 @PatchMapping("/{groupId}") ApiResponse<?> update(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long groupId,@Valid @RequestBody Update body){id(groupId);return ApiResponse.ok(groups.update(user(h),groupId,body.name(),body.description()!=null,body.description()));}
 @DeleteMapping("/{groupId}") ResponseEntity<Void> delete(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long groupId){id(groupId);groups.delete(user(h),groupId);return ResponseEntity.noContent().build();}
 @PostMapping("/{groupId}/members") ResponseEntity<ApiResponse<?>> add(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long groupId,@Valid @RequestBody Member body){id(groupId);return ResponseEntity.status(201).body(ApiResponse.ok(groups.addMember(user(h),groupId,body.username())));}
 @DeleteMapping("/{groupId}/members/{userId}") ResponseEntity<Void> remove(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long groupId,@PathVariable long userId){id(groupId);id(userId);groups.removeMember(user(h),groupId,userId);return ResponseEntity.noContent().build();}
 @GetMapping("/{groupId}/members/{userId}/stats") ApiResponse<?> stats(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long groupId,@PathVariable long userId){id(groupId);id(userId);return ApiResponse.ok(groups.stats(user(h),groupId,userId));}
 @PutMapping("/{groupId}/banks/{bankId}") ResponseEntity<ApiResponse<?>> link(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long groupId,@PathVariable long bankId){id(groupId);id(bankId);return ResponseEntity.status(201).body(ApiResponse.ok(groups.linkBank(user(h),groupId,bankId)));}
 @DeleteMapping("/{groupId}/banks/{bankId}") ResponseEntity<Void> unlink(@RequestHeader(value="Authorization",required=false)String h,@PathVariable long groupId,@PathVariable long bankId){id(groupId);id(bankId);groups.unlinkBank(user(h),groupId,bankId);return ResponseEntity.noContent().build();}
 record Create(@NotBlank @Size(max=100) String name,@Size(max=500) String description){} record Update(@Size(max=100) String name,@Size(max=500) String description){} record Member(@NotBlank String username){}
}
