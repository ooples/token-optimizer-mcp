/**
 * ONE MACHINE CAN HOLD MORE THAN ONE SUPERVISOR.
 *
 * The route window is 1000 ports wide and was fixed, so two supervisors -- two
 * projects, or two jest workers on one CI runner -- derived their routes from
 * the same thousand ports. Whichever bound first kept the derived port and the
 * loser fell back to an ephemeral one, which is the stable-URL guarantee lost
 * to nothing but coincidence. It surfaced as a route URL answering
 * `{"error":"not a supervisor route"}`: a 404 from a control server that had
 * never heard of that route.
 */
import { describe, expect, it } from '@jest/globals';
import { routePort } from '../../../src/proxy/supervisor.js';

const UPSTREAM = 'http://127.0.0.1:41234';

describe('an operator can move the route window', () => {
  it('derives inside the default window when nothing is set', () => {
    const port = routePort(UPSTREAM, {});
    expect(port).toBeGreaterThanOrEqual(17000);
    expect(port).toBeLessThan(18000);
  });

  it('derives inside a window the caller named', () => {
    const port = routePort(UPSTREAM, {
      TOKEN_OPTIMIZER_PROXY_ROUTE_BASE: '21000',
    });
    expect(port).toBeGreaterThanOrEqual(21000);
    expect(port).toBeLessThan(22000);
  });

  it('keeps the same upstream on the same port within a window', () => {
    // THE WHOLE POINT OF DERIVING RATHER THAN ASSIGNING: a restart has to land
    // back on the port the client was pointed at.
    const once = routePort(UPSTREAM, {
      TOKEN_OPTIMIZER_PROXY_ROUTE_BASE: '21000',
    });
    expect(
      routePort(UPSTREAM, { TOKEN_OPTIMIZER_PROXY_ROUTE_BASE: '21000' })
    ).toBe(once);
  });

  it('refuses a window that would reach into the ephemeral range', () => {
    // 32000 + 1000 = 33000, past the 32768 floor the kernel allocates outbound
    // source ports from -- where a route is demoted the moment an unrelated
    // socket holds it. That is the defect the fixed window exists to avoid, so
    // an override must not be able to reintroduce it.
    expect(() =>
      routePort(UPSTREAM, { TOKEN_OPTIMIZER_PROXY_ROUTE_BASE: '32000' })
    ).toThrow(/outbound source ports/);
  });

  it('refuses a window that swallows the control port', () => {
    expect(() =>
      routePort(UPSTREAM, {
        TOKEN_OPTIMIZER_PROXY_ROUTE_BASE: '20000',
        TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: '20500',
      })
    ).toThrow(/inside the route window/);
  });

  it('refuses a value that is not a port', () => {
    expect(() =>
      routePort(UPSTREAM, { TOKEN_OPTIMIZER_PROXY_ROUTE_BASE: 'high' })
    ).toThrow(/must be a port between/);
  });

  it('accepts a control port just outside the named window', () => {
    // THE POSITIVE CONTROL for the refusal above: the rule is the window, not
    // any nearby port, so the control port one below it is fine.
    expect(
      routePort(UPSTREAM, {
        TOKEN_OPTIMIZER_PROXY_ROUTE_BASE: '20000',
        TOKEN_OPTIMIZER_PROXY_CONTROL_PORT: '19999',
      })
    ).toBeGreaterThanOrEqual(20000);
  });
});
