namespace Crib.Behavior;

/// <summary>
/// Behavior fixture: throw, try/catch+when, switch, assignment, switch expression.
/// </summary>
public class BehaviorService
{
    public string Classify(int score)
    {
        try
        {
            if (score < 0)
            {
                throw new System.ArgumentOutOfRangeException("score must be non-negative");
            }
            string label = "low";
            switch (score)
            {
                case 0:
                    label = "zero";
                    break;
                case 1:
                    label = "one";
                    break;
                default:
                    label = "many";
                    break;
            }
            return label;
        }
        catch (System.ArgumentOutOfRangeException ex) when (score < -10)
        {
            Log(ex.Message);
            throw;
        }
        catch (System.Exception ex)
        {
            Log("handled");
            return "error";
        }
    }

    public string Name(int code)
    {
        string result = code switch
        {
            1 => "one",
            2 => "two",
            _ => "other"
        };
        return result;
    }

    void Log(string msg) { }
}