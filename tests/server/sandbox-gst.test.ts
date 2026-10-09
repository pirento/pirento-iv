import test from 'node:test';
import assert from 'node:assert/strict';
import { createSandboxGst, SandboxGstError } from '../../server/integrations/gst/sandbox-gst.ts';
import { validGstin } from '../../server/validation/validation.ts';

const START = Date.UTC(2026, 0, 1);
const ENV = { SANDBOX_API_KEY: 'test-key-private', SANDBOX_API_SECRET: 'test-secret-private' };
const minute = 60_000;

function gstin(index = 1) {
  const prefix = `27ABCDE${String(index).padStart(4, '0')}F1Z`;
  return (
    prefix + [...'0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'].find((character) => validGstin(prefix + character))
  );
}

function jwt(expiresAt = START + 24 * 60 * minute) {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({ exp: expiresAt / 1000 })).toString('base64url');
  return `${header}.${claims}.test-signature`;
}

function taxpayer(number = gstin(), overrides: Record<string, unknown> = {}) {
  return {
    gstin: number,
    lgnm: ' Example Legal Business ',
    sts: 'Active',
    tradeNam: 'Example Brand',
    pradr: {
      addr: {
        bno: '10',
        flno: '2nd floor',
        bnm: 'Office',
        st: 'Sample Road',
        loc: 'Pune',
        dst: 'Pune',
        stcd: 'Maharashtra',
        pncd: '411001',
      },
    },
    ...overrides,
  };
}

function success(number = gstin(), overrides: Record<string, unknown> = {}) {
  return { code: 200, data: { status_cd: '1', data: taxpayer(number, overrides) } };
}

type Call = { url: string; options: RequestInit; headers: Headers };
function transport(handler?: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetcher = (async (url: string | URL | Request, options: RequestInit = {}) => {
    const call = { url: String(url), options, headers: new Headers(options.headers) };
    calls.push(call);
    if (handler) return handler(call, calls.length);
    return call.url.endsWith('/authenticate')
      ? Response.json({ code: 200, data: { access_token: jwt() } })
      : Response.json(success(JSON.parse(String(options.body)).gstin));
  }) as typeof fetch;
  return { calls, fetcher };
}

function adapter(mock = transport(), extras: Parameters<typeof createSandboxGst>[0] = {}) {
  return {
    mock,
    api: createSandboxGst({ environment: ENV, fetch: mock.fetcher, now: () => START, ...extras }),
  };
}

function safeError(status: number) {
  return (error: unknown) => {
    assert.ok(error instanceof SandboxGstError);
    assert.equal(error.status, status);
    assert.ok(!/private|test-signature|eyJ|provider-secret/.test(error.message));
    return true;
  };
}

test('Sandbox status exposes presence and safe mode only, with test as the fail-closed default', async () => {
  const { api, mock } = adapter();
  assert.deepEqual(api.status(), {
    provider: 'sandbox',
    mode: 'test',
    configured: true,
    keyConfigured: true,
    secretConfigured: true,
  });
  assert.ok(!JSON.stringify(api.status()).includes('private'));
  for (const environment of [
    {},
    { SANDBOX_API_KEY: ENV.SANDBOX_API_KEY },
    { ...ENV, SANDBOX_ENVIRONMENT: 'live' },
    { ...ENV, SANDBOX_API_SECRET: 'unsafe\nsecret' },
    { ...ENV, SANDBOX_API_KEY: 'x'.repeat(2049) },
  ]) {
    const missing = createSandboxGst({ environment, fetch: mock.fetcher });
    assert.equal(missing.status().configured, false);
    await assert.rejects(missing.lookup(gstin(), 'staff-1'), safeError(503));
  }
  assert.equal(mock.calls.length, 0);
  assert.equal(
    createSandboxGst({ environment: { ...ENV, SANDBOX_ENVIRONMENT: ' Production ' } }).status().mode,
    'production',
  );
});

test('Sandbox uses only fixed test or production hosts and sends the secret only to authentication', async () => {
  for (const mode of ['test', 'production']) {
    const { api, mock } = adapter(transport(), { environment: { ...ENV, SANDBOX_ENVIRONMENT: mode } });
    const result = await api.lookup(` ${gstin().toLowerCase()} `, 'staff-1');
    assert.equal(result.name, 'Example Legal Business');
    assert.equal(result.stateCode, '27');
    const host = mode === 'test' ? 'https://test-api.sandbox.co.in' : 'https://api.sandbox.co.in';
    assert.equal(mock.calls.length, 2);
    assert.equal(mock.calls[0].url, `${host}/authenticate`);
    assert.equal(mock.calls[1].url, `${host}/gst/compliance/public/gstin/search`);
    for (const call of mock.calls) {
      assert.equal(call.options.method, 'POST');
      assert.equal(call.options.redirect, 'error');
      assert.ok(call.options.signal instanceof AbortSignal);
      assert.equal(call.headers.get('x-api-key'), ENV.SANDBOX_API_KEY);
      assert.equal(call.headers.get('x-api-version'), '1.0.0');
      assert.ok(!call.url.includes('private'));
    }
    assert.equal(mock.calls[0].headers.get('x-api-secret'), ENV.SANDBOX_API_SECRET);
    assert.equal(mock.calls[1].headers.get('x-api-secret'), null);
    assert.equal(mock.calls[1].headers.get('authorization'), jwt());
    assert.equal(mock.calls[1].headers.get('x-accept-cache'), 'false');
    assert.deepEqual(JSON.parse(String(mock.calls[1].options.body)), { gstin: gstin() });
    assert.equal(result.address, '10, 2nd floor, Office, Sample Road, Pune, Pune, Maharashtra, 411001');
  }
});

test('Cancelled registrations remain cancelled, legal name is used, and absent addresses remain empty', async () => {
  const mock = transport((call) =>
    call.url.endsWith('/authenticate')
      ? Response.json({ code: 200, data: { access_token: jwt() } })
      : Response.json(success(gstin(), { sts: 'Cancelled', pradr: undefined })),
  );
  const { api } = adapter(mock);
  assert.deepEqual(await api.lookup(gstin(), 'staff-1'), {
    gstin: gstin(),
    name: 'Example Legal Business',
    address: '',
    stateCode: '27',
    status: 'Cancelled',
  });
});

test('No-records errors embedded in HTTP 200 responses are returned as safe not-found errors', async () => {
  const { api } = adapter(
    transport((call) =>
      call.url.endsWith('/authenticate')
        ? Response.json({ code: 200, data: { access_token: jwt() } })
        : Response.json({
            code: 200,
            data: { status_cd: '0', error: { error_cd: 'FO8000', message: 'provider-secret' } },
          }),
    ),
  );
  await assert.rejects(api.lookup(gstin(), 'staff-1'), safeError(404));
});

test('Invalid GSTIN checksums and missing client sessions are rejected before any upstream request', async () => {
  const { api, mock } = adapter();
  for (const number of ['invalid', gstin().slice(0, 14) + (gstin().at(-1) === '0' ? '1' : '0')])
    await assert.rejects(api.lookup(number, 'staff-1'), safeError(400));
  await assert.rejects(api.lookup(gstin(), ''), safeError(400));
  assert.equal(mock.calls.length, 0);
});

test('Malformed taxpayer structures, mismatched GSTINs and schema limit violations cannot be applied', async () => {
  const payloads: unknown[] = [
    { code: '200', data: { status_cd: '1', data: taxpayer() } },
    { code: 200, data: { status_cd: 1, data: taxpayer() } },
    { code: 200, data: { status_cd: '0', error: { error_cd: 'unknown', message: 'provider-secret' } } },
    success(gstin(2)),
    success(gstin(), { lgnm: ['provider-secret'] }),
    success(gstin(), { lgnm: 'x'.repeat(201) }),
    success(gstin(), { sts: false }),
    success(gstin(), { sts: '' }),
    success(gstin(), { pradr: 'provider-secret' }),
    success(gstin(), { pradr: { addr: { bno: 10 } } }),
    success(gstin(), { pradr: { addr: { bno: 'x'.repeat(2001) } } }),
    [],
    null,
  ];
  for (const payload of payloads) {
    const { api, mock } = adapter(
      transport((call) =>
        call.url.endsWith('/authenticate')
          ? Response.json({ code: 200, data: { access_token: jwt() } })
          : Response.json(payload),
      ),
    );
    await assert.rejects(api.lookup(gstin(), 'staff-1'), safeError(502));
    assert.equal(mock.calls.length, 2);
  }
});

test('Upstream HTTP and wrapped errors have stable safe messages and never automatically retry a paid lookup', async () => {
  for (const [upstream, status] of [
    [401, 503],
    [403, 503],
    [429, 429],
    [422, 400],
    [404, 404],
    [500, 502],
  ]) {
    for (const wrapped of [false, true]) {
      const { api, mock } = adapter(
        transport((call) =>
          call.url.endsWith('/authenticate')
            ? Response.json({ code: 200, data: { access_token: jwt() } })
            : Response.json(
                { code: upstream, message: 'provider-secret' },
                { status: wrapped ? 200 : upstream },
              ),
        ),
      );
      await assert.rejects(api.lookup(gstin(), 'staff-1'), safeError(status));
      assert.equal(mock.calls.length, 2);
    }
  }
});

test('Rejected provider response bodies are discarded and authentication failures never begin a lookup', async () => {
  for (const failingStage of ['auth', 'lookup']) {
    let cancelled = false;
    const { api, mock } = adapter(
      transport((call) => {
        if (failingStage === 'lookup' && call.url.endsWith('/authenticate'))
          return Response.json({ code: 200, data: { access_token: jwt() } });
        return new Response(
          new ReadableStream({
            cancel() {
              cancelled = true;
            },
          }),
          { status: 401 },
        );
      }),
    );
    await assert.rejects(api.lookup(gstin(), 'staff-1'), safeError(503));
    assert.equal(cancelled, true);
    assert.equal(mock.calls.length, failingStage === 'auth' ? 1 : 2);
  }
});

test('Provider timeouts and JSON decoding failures never expose credentials, tokens or upstream exception text', async () => {
  for (const failingStage of ['auth', 'lookup']) {
    const mock = transport((call) => {
      if (failingStage === 'lookup' && call.url.endsWith('/authenticate'))
        return Response.json({ code: 200, data: { access_token: jwt() } });
      throw new Error(`provider-secret: ${ENV.SANDBOX_API_SECRET}`);
    });
    const { api } = adapter(mock);
    const results = await Promise.allSettled([
      api.lookup(gstin(), 'staff-1'),
      api.lookup(gstin(), 'staff-2'),
    ]);
    for (const result of results) {
      assert.equal(result.status, 'rejected');
      if (result.status === 'rejected') safeError(502)(result.reason);
    }
  }
  const { api } = adapter(transport(() => new Response('provider-secret')));
  await assert.rejects(api.lookup(gstin(), 'staff-1'), safeError(502));
});

test('Authentication and lookup JSON readers cap declared and streamed response sizes', async () => {
  for (const failingStage of ['auth', 'lookup']) {
    for (const declared of [false, true]) {
      let cancelled = false;
      const { api } = adapter(
        transport((call) => {
          if (failingStage === 'lookup' && call.url.endsWith('/authenticate'))
            return Response.json({ code: 200, data: { access_token: jwt() } });
          return new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                if (!declared) controller.enqueue(new Uint8Array(129 * 1024));
              },
              cancel() {
                cancelled = true;
              },
            }),
            { headers: declared ? { 'content-length': String(129 * 1024) } : {} },
          );
        }),
      );
      await assert.rejects(api.lookup(gstin(), 'staff-1'), safeError(502));
      assert.equal(cancelled, true);
    }
  }
});

test('Concurrent identical GST lookups share authentication and one paid request; result mutations cannot poison cache', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const mock = transport(async (call) => {
    if (call.url.endsWith('/authenticate')) {
      await ready;
      return Response.json({ code: 200, data: { access_token: jwt() } });
    }
    return Response.json(success(JSON.parse(String(call.options.body)).gstin));
  });
  const { api } = adapter(mock);
  const first = api.lookup(gstin(), 'staff-1');
  const second = api.lookup(gstin(), 'staff-2');
  const third = api.lookup(gstin(2), 'staff-3');
  assert.equal(mock.calls.length, 1);
  release();
  const results = await Promise.all([first, second, third]);
  assert.equal(mock.calls.filter((call) => call.url.endsWith('/authenticate')).length, 1);
  assert.equal(mock.calls.filter((call) => !call.url.endsWith('/authenticate')).length, 2);
  assert.notEqual(results[0], results[1]);
  results[0].name = 'Changed locally';
  assert.equal((await api.lookup(gstin(), 'staff-1')).name, 'Example Legal Business');
  assert.equal(mock.calls.length, 3);
});

test('Successful cache expires after five minutes while auth tokens are reused and refreshed before expiry', async () => {
  let time = START;
  const mock = transport((call) =>
    call.url.endsWith('/authenticate')
      ? Response.json({ code: 200, data: { access_token: jwt(time + 10 * minute) } })
      : Response.json(success(JSON.parse(String(call.options.body)).gstin)),
  );
  const { api } = adapter(mock, { now: () => time });
  await api.lookup(gstin(), 'staff-1');
  time += 4 * minute;
  await api.lookup(gstin(), 'staff-1');
  assert.equal(mock.calls.length, 2);
  time += minute;
  await api.lookup(gstin(), 'staff-1');
  assert.equal(mock.calls.length, 3);
  time += 4 * minute;
  await api.lookup(gstin(2), 'staff-1');
  assert.equal(mock.calls.filter((call) => call.url.endsWith('/authenticate')).length, 2);
});

test('Missing, malformed and expired JWT tokens are rejected instead of cached or used as authorization', async () => {
  for (const value of [
    undefined,
    'provider-secret',
    jwt(START),
    jwt(START + minute),
    'aaa.bm90LWpzb24.ccc',
    jwt().replace('test-signature', 'bad\nsecret'),
  ]) {
    const { api, mock } = adapter(
      transport(() => Response.json({ code: 200, data: { access_token: value } })),
    );
    await assert.rejects(api.lookup(gstin(), 'staff-1'), safeError(502));
    assert.equal(mock.calls.length, 1);
  }
});

test('Rejected auth tokens are invalidated for the next deliberate lookup without retrying the failing request', async () => {
  let searches = 0;
  const mock = transport((call) => {
    if (call.url.endsWith('/authenticate'))
      return Response.json({ code: 200, data: { access_token: jwt() } });
    searches++;
    return searches === 1
      ? Response.json({ code: 401, message: 'provider-secret' })
      : Response.json(success(gstin()));
  });
  const { api } = adapter(mock);
  await assert.rejects(api.lookup(gstin(), 'staff-1'), safeError(503));
  assert.equal(mock.calls.length, 2);
  await api.lookup(gstin(), 'staff-1');
  assert.equal(mock.calls.length, 4);
  assert.equal(mock.calls.filter((call) => call.url.endsWith('/authenticate')).length, 2);
});

test('Per-client attempts are capped at ten per minute, including cache hits, and reset after the window', async () => {
  let time = START;
  const { api, mock } = adapter(transport(), { now: () => time });
  for (let index = 0; index < 10; index++) await api.lookup(gstin(), 'staff-1');
  await assert.rejects(api.lookup(gstin(), 'staff-1'), safeError(429));
  assert.equal(mock.calls.length, 2);
  time += minute;
  await api.lookup(gstin(), 'staff-1');
  assert.equal(mock.calls.length, 2);
});

test('Global attempts are capped at sixty per minute across clients and do not send excess paid requests', async () => {
  let time = START;
  const { api, mock } = adapter(transport(), { now: () => time });
  for (let index = 0; index < 60; index++) await api.lookup(gstin(index + 1), `staff-${index}`);
  await assert.rejects(api.lookup(gstin(61), 'new-staff'), safeError(429));
  assert.equal(mock.calls.length, 61);
  time += minute;
  await api.lookup(gstin(61), 'new-staff');
  assert.equal(mock.calls.length, 62);
});
