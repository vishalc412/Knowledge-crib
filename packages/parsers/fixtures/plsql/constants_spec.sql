-- PL/SQL fixture for WS-6 constant-value capture: a package SPEC with CONSTANT declarations
-- (the CONSTANT keyword PRECEDES the type in Oracle: `cname CONSTANT NUMBER := 30;`) plus a
-- plain defaulted variable and a parameterless procedure declaration. Asserts the literal
-- initializer, the constant flag, and the CORRECT dataType (NUMBER / VARCHAR2(20), not the
-- literal string "CONSTANT") all survive into the package node's meta.variables.
CREATE OR REPLACE PACKAGE constants_pkg IS
  C_RULE_PASSED            CONSTANT VARCHAR2(20) := 'PASSED';
  C_RULE_FAILED             CONSTANT VARCHAR2(20) := 'FAILED';
  C_THRESHOLD_AUTO_REJECT   CONSTANT NUMBER := 30;
  C_THRESHOLD_AUTO_APPROVE  CONSTANT NUMBER := 80;
  g_default_limit           NUMBER := 1000;
  PROCEDURE evaluate(p_id NUMBER);
END constants_pkg;
/