// Track 3 fixture — guarded procedures with if/else + a loop, for the extract_rules decision
// table. `authorize` is the guarded procedure: one IF with a THEN call (`deny`) and an ELSE call
// (`grant`). `validate` has a `for` loop body action (`check`) to verify inLoop:true + branch:LOOP.
// All callees are intra-file free fns so the `calls` edges resolve and get guard-chain annotation.

pub fn authorize(user: &str) -> String {
    if user.is_empty() {
        deny(user)
    } else {
        grant(user)
    }
}

pub fn validate(user: &str) -> bool {
    for role in roles(user) {
        check(role);
    }
    true
}

pub fn grant(user: &str) -> String {
    format!("grant {}", user)
}

pub fn deny(user: &str) -> String {
    format!("deny {}", user)
}

pub fn check(role: &str) -> bool {
    role == "admin"
}

pub fn roles(user: &str) -> Vec<String> {
    vec![]
}