/**
 * A bench fixture that deliberately contains insecure code.
 *
 * WHY IT EXISTS: every other smart_security fixture is ordinary source with no
 * findings, so the published reduction range was measured entirely on the
 * empty-result path -- a scan that reports "0 findings" costs the same 98 tokens
 * whatever file it was pointed at, which makes three such fixtures one reading
 * taken three times. The range only describes the tool once a file with real
 * findings is in the set, because a finding carries a message, a line and a
 * remediation, and that is where the response starts to cost something.
 *
 * NOTHING HERE IS A CREDENTIAL. The patterns below are injection sinks, a weak
 * PRNG and a permissive CORS header -- shapes a scanner recognises on their own,
 * with no key, password or token material of any kind, real or placeholder.
 * Nothing in this file is imported by anything.
 */
import { exec } from 'child_process';

interface Request {
  query: Record<string, string>;
  body: Record<string, string>;
}

interface Response {
  setHeader(name: string, value: string): void;
  send(body: string): void;
}

/** Code injection: the request decides what runs. */
export function runUserExpression(req: Request): unknown {
  // eslint-disable-next-line no-eval
  return eval(req.query.expression);
}

/** Code injection again, through the Function constructor. */
export function compileUserTemplate(source: string): () => string {
  return new Function(`return \`${source}\`;`) as () => string;
}

/** Command injection: a shell string built by concatenation. */
export function listUserDirectory(req: Request): void {
  exec('ls -la ' + req.query.path, () => undefined);
}

/** Insecure randomness used where unpredictability is the point. */
export function newSessionId(): string {
  return Math.random().toString(36).slice(2);
}

/** DOM sink assigned from untrusted input. */
export function renderComment(
  element: { innerHTML: string },
  req: Request
): void {
  element.innerHTML = req.body.comment;
}

/** A CORS policy that trusts every origin. */
export function openCors(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.send('ok');
}
