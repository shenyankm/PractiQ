package com.practiq.common;
public record ApiError(ErrorBody error) { public record ErrorBody(String code,String message,Object details,String requestId){} }
