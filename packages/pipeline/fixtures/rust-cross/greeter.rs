// greeter.rs — the Greeter trait (no supertrait); implemented across files.
pub trait Greeter {
    fn greet(&self, user: &str) -> String;
}