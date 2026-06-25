export class AuthService {
  login(email: string): Session {
    return this.issue(email);
  }

  issue(email: string): Session {
    return { email };
  }
}

export interface Session {
  email: string;
}
