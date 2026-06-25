// controller.rs — imports Base + Token; constructs Token cross-file (cross-file call); owns Base.
use crate::base::Base;
use crate::token::Token;

pub struct Controller {
    base: Base,
}

impl Controller {
    pub fn issue(&self, input: String) -> Token {
        Token(input)
    }

    pub fn run(&self) -> u32 {
        self.base.run()
    }
}