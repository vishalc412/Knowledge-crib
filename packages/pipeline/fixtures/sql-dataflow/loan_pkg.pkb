-- A package body in its own file. assess_application declares a cursor whose SELECT reads
-- loan_applications (declared in loans.sql) — a CROSS-FILE cursor read emitted by the SqlResolver.
CREATE OR REPLACE PACKAGE BODY loan_pkg IS
  PROCEDURE assess_application(p_id NUMBER) IS
    v_status  VARCHAR2(20);
    CURSOR c_app IS SELECT status, credit_score FROM loan_applications WHERE id = p_id;
  BEGIN
    FOR rec IN c_app LOOP
      v_status := rec.status;
      UPDATE loan_applications SET status = v_status WHERE id = p_id;
    END LOOP;
  END assess_application;
END loan_pkg;