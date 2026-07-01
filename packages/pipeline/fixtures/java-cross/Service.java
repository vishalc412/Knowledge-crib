package com.example;

public class Service implements Greeter {
    @Override
    public String greet(String user) {
        return "hi " + user;
    }
}