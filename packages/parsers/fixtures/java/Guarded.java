package com.example.rules;

// Track-3 fixture: a procedure with if/else, loops, switch and a try — to verify the
// language-agnostic extract_rules decision-table verb over the Java extractor's guard-annotated edges.
public class Guarded {

    public String decide(int status, int limit) {
        if (status > 0) {
            return approve(status);
        } else {
            return reject(status);
        }
    }

    public int sum(int[] items) {
        int total = 0;
        for (int i = 0; i < items.length; i++) {
            total += add(total, items[i]);
        }
        return total;
    }

    public String classify(int day) {
        switch (day) {
            case 1:
                return weekday();
            default:
                return weekend();
        }
    }

    public String safe(int value) {
        try {
            return handle(value);
        } catch (Exception e) {
            return fallback();
        }
    }

    private String approve(int x) { return "approved:" + x; }
    private String reject(int x) { return "rejected:" + x; }
    private int add(int a, int b) { return a + b; }
    private String weekday() { return "weekday"; }
    private String weekend() { return "weekend"; }
    private String handle(int v) { return "handled:" + v; }
    private String fallback() { return "fallback"; }
}