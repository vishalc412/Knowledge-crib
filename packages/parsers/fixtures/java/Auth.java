package com.example.auth;

import org.springframework.web.bind.annotation.*;
import java.util.List;
import static java.util.Collections.emptyList;

// Auth controller: login + token issuance.
@RestController
@RequestMapping("/api/auth")
public class AuthController extends BaseController implements AuthApi {
    private final UserService service;

    @GetMapping("/login")
    public String login(@RequestParam String user) {
        this.validate(user);
        return service.greet(user);
    }

    @PostMapping("/issue")
    public Token issue(@RequestBody TokenReq req) {
        Token t = new Token(req);
        log("issued");
        return t;
    }

    private void validate(String user) {
        if (user.isEmpty()) {
            throw new IllegalArgumentException(user);
        }
    }

    static void log(String msg) {
        System.out.println(msg);
    }
}

record Token(TokenReq req) {
}

enum Role {
    ADMIN, USER
}

@Service
class UserService implements Greeter {
    @Override
    public String greet(String user) {
        return "hi " + user;
    }
}

interface Greeter {
    String greet(String user);
}

interface AuthApi {
    String login(String user);
    Token issue(TokenReq req);
}

class BaseController {
    public String textBlock() {
        return """
               hello
               """;
    }
}