package com.example;

import org.springframework.stereotype.Repository;

@Repository
public class LoanRepository {
    public String findById(String id) {
        return "loan:" + id;
    }
}