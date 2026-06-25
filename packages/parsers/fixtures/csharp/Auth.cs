namespace Crib.Auth;

// Auth controller: login + token issuance.
[ApiController]
[Route("/api/auth")]
public class AuthController : BaseController, IAuthApi
{
    private readonly UserService service;

    [HttpGet("/login")]
    public string Login(string user)
    {
        this.Validate(user);
        return service.Greet(user);
    }

    [HttpPost("/issue")]
    public Token Issue(TokenReq req)
    {
        Token t = new Token(req);
        Log("issued");
        return t;
    }

    private void Validate(string user)
    {
        if (user.Length == 0)
        {
            throw new System.ArgumentException(user);
        }
    }

    static void Log(string msg)
    {
        System.Console.WriteLine(msg);
    }
}

record Token(TokenReq req);

enum Role
{
    Admin,
    User
}

[Service]
class UserService : IGreeter
{
    public override string Greet(string user)
    {
        return "hi " + user;
    }
}

interface IGreeter
{
    string Greet(string user);
}

interface IAuthApi
{
    string Login(string user);
    Token Issue(TokenReq req);
}

class BaseController
{
    public string Banner(string user)
    {
        string verbatim = @"line1
line2 ""quoted"" end";
        string interpolated = $"value={user}";
        return verbatim + interpolated;
    }
}