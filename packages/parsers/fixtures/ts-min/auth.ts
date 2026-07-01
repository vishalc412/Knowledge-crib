export class AuthService {
  login(email: string, pw: string): Session {
    return this.issue(email);
  }

  private issue(email: string): Session {
    return makeSession(email);
  }
}

export function makeSession(email: string): Session {
  return { email };
}

interface Session {
  email: string;
}
