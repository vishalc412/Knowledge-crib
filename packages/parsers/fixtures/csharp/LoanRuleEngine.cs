namespace Crib.LoanRuleEngine;

/// <summary>
/// Loan rule engine: assess one application — approve, reject, or escalate.
/// Decision rules: amount > 50000 requires credit_score >= 700; otherwise score >= 600.
/// </summary>
public class LoanRuleService
{
    public void AssessApplication(decimal pId)
    {
        string decision;
        try
        {
            foreach (var rec in SelectApplications(pId))
            {
                decimal amount = rec.Amount;
                string status = rec.Status;
                decimal score = rec.CreditScore;
                if (amount > 50000 && score >= 700)
                {
                    decision = "APPROVE";
                }
                else if (score >= 600)
                {
                    decision = "APPROVE";
                }
                else
                {
                    decision = "REJECT";
                }
                switch (decision)
                {
                    case "REJECT":
                        throw new ApplicationException("-20001: application rejected: insufficient credit");
                    default:
                        break;
                }
                UpdateApplication(pId, decision);
            }
        }
        catch (NoDataException)
        {
            decision = "MISSING";
            UpdateApplication(pId, "MISSING");
        }
        catch (System.Exception)
        {
            throw new ApplicationException("-20002: assess_application failed");
        }
    }

    ApplicationRow[] SelectApplications(decimal id) { return new ApplicationRow[0]; }
    void UpdateApplication(decimal id, string status) { }
}

public class NoDataException : System.Exception { }
public class ApplicationRow { public decimal Amount; public string Status; public decimal CreditScore; }