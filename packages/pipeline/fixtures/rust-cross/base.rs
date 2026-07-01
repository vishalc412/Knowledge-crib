// base.rs — inherent impl with a run method; the cross-file `Base` import target.
pub struct Base {
    pub value: u32,
}

impl Base {
    pub fn run(&self) -> u32 {
        self.value
    }
}