package com.example.behavior;

/**
 * Behavior demo: exercises schema-1.2 deep-extraction nodes
 * (raise / exception-handler / assignment / case-branch / explanation).
 */
public class Behavior {

    /**
     * Decide on a status code with full fidelity.
     * Throws if negative, maps the rest via a switch.
     */
    public String decide(int status) {
        int count;
        count = status + 1;
        try {
            if (status < 0) {
                throw new IllegalStateException("negative status");
            }
            switch (status) {
                case 0:
                    return "zero";
                case 1:
                    return "one";
                default:
                    return "other";
            }
        } catch (IllegalStateException ex) {
            return "caught";
        }
    }

    public String multi(int x) {
        try {
            if (x == 0) {
                throw new IllegalArgumentException("zero x");
            }
            return "ok";
        } catch (RuntimeException | IllegalStateException e) {
            return "multi";
        }
    }
}