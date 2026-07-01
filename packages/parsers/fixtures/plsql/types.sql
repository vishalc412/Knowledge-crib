-- PL/SQL fixture for CREATE TYPE / CREATE VIEW extraction (Track 2 deep-context).
-- Models the Oracle object-type + collection + view shapes that were previously skipped
-- (parser.ts "CREATE TYPE/VIEW/INDEX/etc. — not modelled"), so e.g. T_APPLICANT_CTX_OBJ
-- now becomes an addressable symbol node with its full attribute list.

CREATE OR REPLACE TYPE applicant_ctx_obj AS OBJECT (
  applicant_id   NUMBER,
  full_name      VARCHAR2(200),
  date_of_birth  DATE,
  gender         VARCHAR2(1),
  nationality    VARCHAR2(2),
  residency_code VARCHAR2(8),
  monthly_income NUMBER,
  existing_debt  NUMBER,
  kyc_passed     VARCHAR2(1)
);
/

CREATE OR REPLACE TYPE income_source_obj AS OBJECT (
  source_type VARCHAR2(20),
  amount      NUMBER,
  frequency   VARCHAR2(10)
);
/

-- a collection type: TABLE OF <object type>
CREATE OR REPLACE TYPE income_sources AS TABLE OF income_source_obj;
/

-- a nested-table / VARRAY collection
CREATE OR REPLACE TYPE doc_list AS VARRAY(50) OF VARCHAR2(100);
/

CREATE OR REPLACE VIEW applicant_summary (
  applicant_id,
  full_name,
  total_income
) AS
  SELECT applicant_id, full_name, monthly_income + NVL(existing_debt, 0)
    FROM applicants;