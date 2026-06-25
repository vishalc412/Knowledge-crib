-- PL/SQL fixture for the schema-1.2 (Workstream B/G) golden: a self-contained loan-rule-engine
-- package body that exercises EVERY behavior-bearing construct the deep extractor must surface:
--   * a CURSOR declaration (cursor node + declares + iterates)
--   * a comment block above a procedure (explanation node + describes)
--   * assignment statements (assignment node + assignTarget)
--   * a CASE statement (case-branch nodes + whenSelector)
--   * RAISE_APPLICATION_ERROR (raise node + errorCode + errorMessage + raises)
--   * an EXCEPTION block (exception-handler nodes + whenSelector + handles)
-- Everything resolves within this one file (local edges).
CREATE TABLE loan_applications (
  id          NUMBER,
  amount      NUMBER,
  status      VARCHAR2(20),
  credit_score NUMBER
);

CREATE OR REPLACE PACKAGE BODY loan_engine IS
  -- Assess one loan application: approve, reject, or escalate.
  -- Decision rules: amount > 50000 requires credit_score >= 700; otherwise score >= 600.
  PROCEDURE assess_application(p_id NUMBER) IS
    v_amount       NUMBER;
    v_status       VARCHAR2(20);
    v_score        NUMBER;
    v_decision     VARCHAR2(20);
    CURSOR c_app IS SELECT amount, status, credit_score FROM loan_applications WHERE id = p_id;
  BEGIN
    FOR rec IN c_app LOOP
      v_amount := rec.amount;
      v_status := rec.status;
      v_score  := rec.credit_score;
      CASE
        WHEN v_amount > 50000 AND v_score >= 700 THEN
          v_decision := 'APPROVE';
        WHEN v_score >= 600 THEN
          v_decision := 'APPROVE';
        ELSE
          v_decision := 'REJECT';
      END CASE;
      IF v_decision = 'REJECT' THEN
        RAISE_APPLICATION_ERROR(-20001, 'application rejected: insufficient credit');
      END IF;
      UPDATE loan_applications SET status = v_decision WHERE id = p_id;
    END LOOP;
  EXCEPTION
    WHEN NO_DATA_FOUND THEN
      v_decision := 'MISSING';
      UPDATE loan_applications SET status = 'MISSING' WHERE id = p_id;
    WHEN OTHERS THEN
      RAISE_APPLICATION_ERROR(-20002, 'assess_application failed');
  END assess_application;
END loan_engine;