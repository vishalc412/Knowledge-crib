-- SQL side of the mixed fixture: a table + a procedure that writes it (all local to this file).
CREATE TABLE events (
  id   NUMBER,
  name VARCHAR2(100)
);

CREATE OR REPLACE PACKAGE BODY event_pkg IS
  PROCEDURE record(p_name VARCHAR2) IS
  BEGIN
    INSERT INTO events (id, name) VALUES (1, p_name);
  END record;
END event_pkg;