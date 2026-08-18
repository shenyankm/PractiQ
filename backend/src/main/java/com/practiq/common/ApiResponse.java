package com.practiq.common;
import java.util.*;
public record ApiResponse<T>(T data, Map<String,Object> meta) { public static <T> ApiResponse<T> ok(T data){return new ApiResponse<>(data,null);} public static <T> ApiResponse<T> ok(T data,Map<String,Object> meta){return new ApiResponse<>(data,meta);} }
