// auth_api.rs — AuthApi trait with a cross-file supertrait (Greeter) → inherits edge.
use crate::greeter::Greeter;

pub trait AuthApi: Greeter {
    fn login(&self, user: &str) -> String;
}