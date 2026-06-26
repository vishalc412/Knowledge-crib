package com.example;

import com.example.LoanRepository;
import org.springframework.stereotype.Service;
import org.springframework.beans.factory.annotation.Autowired;

@Service
public class LoanService {
    @Autowired
    private LoanRepository repo;

    public String evaluate(String id) {
        return repo.findById(id);
    }
}