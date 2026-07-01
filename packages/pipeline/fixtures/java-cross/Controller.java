package com.example;

import com.example.Base;
import com.example.Service;
import com.example.Token;

public class Controller extends Base implements Greeter {
    private Service service;

    public Token issue(String input) {
        return new Token(input);
    }

    @Override
    public String greet(String user) {
        return service.greet(user);
    }
}