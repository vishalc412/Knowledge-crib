// Auth fixture for the Rust extractor — mirrors java/Auth.java: a controller with trait impls,
// a free fn, structs, an enum, a nested block comment, a lifetime, a `>>` generic, and a macro.
use std::collections::HashMap;
use std::sync::{Mutex, Arc};
use std::io::*;

#[derive(Debug)]
#[doc = r#"a raw doc"#]
pub struct Token {
    req: String,
}

pub enum Role {
    Admin,
    User,
}

pub trait Greeter {
    fn greet(&self, user: &str) -> String;
}

pub trait AuthApi: Greeter {
    fn login(&self, user: &str) -> String;
    fn issue(&self, req: Token) -> Token;
}

pub struct AuthController {
    service: UserService,
}

impl AuthApi for AuthController {
    fn login(&self, user: &str) -> String {
        self.validate(user);
        self.service.greet(user)
    }
    fn issue(&self, req: Token) -> Token {
        let t = Token { req: req.req };
        log("issued");
        t
    }
}

impl AuthController {
    fn validate(&self, user: &str) {
        if user.is_empty() {
            panic!()
        }
    }
}

fn log(msg: &str) {
    println!("{}", msg)
}

pub struct UserService;

impl Greeter for UserService {
    fn greet(&self, user: &str) -> String {
        format!("hi {}", user)
    }
}

/* outer /* inner */ outer */

pub fn make_map<'a>() -> HashMap<&'a str, Vec<Vec<Role>>> {
    HashMap::new()
}

macro_rules! vec2 {
    ($e:expr) => { vec![$e] }
}