package com.example;

import com.example.LoanService;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;

@RestController
@RequestMapping("/api/loans")
public class LoanController {
    private final LoanService service;

    public LoanController(LoanService service) {
        this.service = service;
    }

    @GetMapping("/{id}")
    public String getLoan(String id) {
        return service.evaluate(id);
    }

    @PostMapping
    public String issue(String id) {
        return service.evaluate(id);
    }
}