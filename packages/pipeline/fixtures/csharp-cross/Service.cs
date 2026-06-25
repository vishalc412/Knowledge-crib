namespace Crib.Example;

public class Service : IGreeter
{
    public string Greet(string user)
    {
        return "hi " + user;
    }
}