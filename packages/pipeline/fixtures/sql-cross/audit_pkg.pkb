-- A package body in its own file. log_event writes audit_log (declared in schema.sql).
CREATE OR REPLACE PACKAGE BODY audit_pkg IS
  PROCEDURE log_event(p_event VARCHAR2) IS
  BEGIN
    INSERT INTO audit_log (id, event) VALUES (1, p_event);
  END log_event;
END audit_pkg;