package com.practiq.auth;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.stereotype.Component;

@Component
@ConditionalOnProperty(name = "practiq.bootstrap-first-admin-openid")
public class FirstAdminBootstrapRunner implements ApplicationRunner {
  private final FirstAdminBootstrapService bootstrap;
  private final Environment environment;

  public FirstAdminBootstrapRunner(FirstAdminBootstrapService bootstrap, Environment environment) {
    this.bootstrap = bootstrap;
    this.environment = environment;
  }

  @Override public void run(ApplicationArguments arguments) {
    if (!"none".equals(environment.getProperty("spring.main.web-application-type"))) throw new IllegalStateException("First-admin bootstrap requires spring.main.web-application-type=none");
    bootstrap.bootstrap(environment.getRequiredProperty("practiq.bootstrap-first-admin-openid"));
  }
}
