FROM eclipse-temurin:21-jre
WORKDIR /app
COPY target/practiq-backend-0.2.0.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "/app/app.jar"]
