package com.practiq.common;
import jakarta.servlet.http.HttpServletRequest; import org.springframework.http.*; import org.springframework.http.converter.HttpMessageNotReadableException; import org.springframework.web.bind.*; import org.springframework.web.bind.annotation.*; import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
@RestControllerAdvice public class ApiExceptionHandler {
 @ExceptionHandler(ApiException.class) ResponseEntity<ApiError> api(ApiException e,HttpServletRequest r){return body(e.status,e.code,e.getMessage(),e.details,r);}
 @ExceptionHandler({MethodArgumentNotValidException.class,MethodArgumentTypeMismatchException.class}) ResponseEntity<ApiError> validation(Exception e,HttpServletRequest r){return body(422,"VALIDATION_ERROR","Invalid request",null,r);}
 @ExceptionHandler(HttpMessageNotReadableException.class) ResponseEntity<ApiError> json(HttpServletRequest r){return body(400,"INVALID_JSON","Request body must be valid JSON",null,r);}
 @ExceptionHandler(Exception.class) ResponseEntity<ApiError> other(Exception e,HttpServletRequest r){return body(500,"INTERNAL_ERROR","Unexpected server error",null,r);}
 private ResponseEntity<ApiError> body(int s,String c,String m,Object d,HttpServletRequest r){String id=(String)r.getAttribute("requestId"); return ResponseEntity.status(s).header("X-Request-ID",id==null?"":id).body(new ApiError(new ApiError.ErrorBody(c,m,d,id)));}
}
