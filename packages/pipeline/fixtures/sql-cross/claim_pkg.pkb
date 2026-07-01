-- A package body in its own file. process_claim reads/writes claims (declared in schema.sql)
-- and calls audit_pkg.log_event (declared in audit_pkg.pkb) — all cross-file.
CREATE OR REPLACE PACKAGE BODY claim_pkg IS
  PROCEDURE process_claim(p_id NUMBER) IS
    v_amt NUMBER;
  BEGIN
    SELECT amount INTO v_amt FROM claims WHERE id = p_id;
    IF v_amt > 1000 THEN
      UPDATE claims SET status = 'PAID' WHERE id = p_id;
      audit_pkg.log_event('claim paid');
    END IF;
  END process_claim;
END claim_pkg;