// service.rs — Service struct implementing Greeter (cross-file implements edge).
use crate::greeter::Greeter;

pub struct Service;

impl Greeter for Service {
    fn greet(&self, user: &str) -> String {
        format!("hi {}", user)
    }
}