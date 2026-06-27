-- WS-7 cross-file data-flow fixture: the parent table lives in its own file so the child table's
-- FK REFERENCES and the package body's cursor SELECT resolve CROSS-FILE via the SchemaCatalog.
CREATE TABLE applicants (
  id    NUMBER PRIMARY KEY,
  name  VARCHAR2(100)
);