/// Classify a status code into a response tier.
/// Panics on impossible states; returns Err for known failures.
pub fn classify(code: u32) -> Result<String, String> {
    let label = mk_label(code);
    if code == 0 {
        return Err("zero code".to_string());
    }
    match code {
        200 => Ok(label),
        404 => Ok(String::from("missing")),
        _ => panic!("unexpected code"),
    }
}

fn mk_label(code: u32) -> String {
    format!("code-{}", code)
}