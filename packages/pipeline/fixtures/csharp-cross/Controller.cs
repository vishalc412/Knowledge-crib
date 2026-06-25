namespace Crib.Example;

using Crib.Example.Base;
using Crib.Example.Service;
using Crib.Example.Token;

public class Controller : Base, IGreeter
{
    private Service service;

    public Token Issue(string input)
    {
        return new Token(input);
    }

    public string Greet(string user)
    {
        return service.Greet(user);
    }
}