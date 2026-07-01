package com.example;

import com.example.AuditClient;
import com.example.LoanRepository;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class LoanConfig {
    // @Bean producer methods — each PRODUCES its return type for the Spring container (the dual of the
    // injects DI graph). AuditClient is imported (cross-file produces edge); LoanRepository is imported
    // too (a Java-config redefinition of the @Repository bean — legal, if unusual).
    @Bean
    public AuditClient auditClient() {
        return new AuditClient();
    }

    @Bean
    public LoanRepository loanRepository() {
        return new LoanRepository();
    }
}