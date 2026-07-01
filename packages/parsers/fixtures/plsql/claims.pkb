-- PL/SQL fixture for the M10 extractor golden: a self-contained package body plus the
-- table DDL it reads/writes. Everything resolves within this one file (local edges).
CREATE TABLE claims (
  id     NUMBER,
  amount NUMBER,
  status VARCHAR2(20)
);

CREATE OR REPLACE PACKAGE BODY claim_pkg IS
  PROCEDURE validate_claim(p_id NUMBER) IS
    v_status VARCHAR2(20);
  BEGIN
    SELECT status INTO v_status FROM claims WHERE id = p_id;
    IF v_status = 'OPEN' THEN
      UPDATE claims SET status = 'REVIEW' WHERE id = p_id;
    END IF;
  END validate_claim;

  PROCEDURE process_claim(p_id NUMBER) IS
    v_amt NUMBER;
  BEGIN
    validate_claim(p_id);
    SELECT amount INTO v_amt FROM claims WHERE id = p_id;
    IF v_amt > 1000 THEN
      INSERT INTO claims (id, amount, status) VALUES (p_id, v_amt, 'BIG');
    ELSE
      DELETE FROM claims WHERE id = p_id;
    END IF;
  END process_claim;
END claim_pkg;