namespace Crib.Guarded;

public class GuardService
{
    public string Decide(int x)
    {
        if (x > 0)
        {
            Approve(x);
        }
        else
        {
            Reject(x);
        }
        return "done";
    }

    public void Loop(int[] xs)
    {
        foreach (var x in xs)
        {
            Process(x);
        }
    }

    void Approve(int n) { }
    void Reject(int n) { }
    void Process(int n) { }
}