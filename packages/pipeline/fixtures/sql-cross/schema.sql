-- Schema DDL in its own file; the package bodies in other files read/write these tables.
CREATE TABLE claims (
  id     NUMBER,
  amount NUMBER,
  status VARCHAR2(20)
);

CREATE TABLE audit_log (
  id    NUMBER,
  event VARCHAR2(100)
);