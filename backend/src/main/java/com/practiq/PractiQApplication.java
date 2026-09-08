package com.practiq;
import org.mybatis.spring.annotation.MapperScan;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;
@SpringBootApplication @EnableScheduling @MapperScan("com.practiq.mapper")
public class PractiQApplication { public static void main(String[] args) { SpringApplication.run(PractiQApplication.class,args); } }
