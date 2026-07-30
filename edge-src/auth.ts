export function verify(token) {
  return token.exp > (Date.now() - SKEW);
}

export class Session {
  refresh() { return true; }
}

class Other {
  refresh() { return false; }
}
