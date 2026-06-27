-- The child table: an inline FK REFERENCES applicants(id) — the parent is in applicants.sql, so
-- the references edge child -> parent is emitted CROSS-FILE by the SqlResolver.
CREATE TABLE loan_applications (
  id            NUMBER PRIMARY KEY,
  applicant_id  NUMBER REFERENCES applicants(id),
  amount        NUMBER,
  status        VARCHAR2(20),
  credit_score  NUMBER
);