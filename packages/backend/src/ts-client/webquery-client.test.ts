import { describe, it, expect, vi } from 'vitest';
import { WebQueryClient } from './webquery-client.js';

function staleSocketError(message: string, code?: string) {
  const err: any = new Error(message);
  if (code) err.code = code;
  return err;
}

function okResponse(body: any = { ok: 1 }) {
  return { data: { status: { code: 0, message: 'ok' }, body } };
}

describe('WebQueryClient stale keep-alive retry', () => {
  it('retries once when the keep-alive socket was closed by the server', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn()
      .mockRejectedValueOnce(staleSocketError('socket hang up', 'ECONNRESET'))
      .mockResolvedValueOnce(okResponse());
    (client as any).http = { get };

    const result = await client.execute(1, 'serverinfo');
    expect(result).toEqual({ ok: 1 });
    expect(get).toHaveBeenCalledTimes(2);
    client.destroy();
  });

  it('does not retry more than once', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockRejectedValue(staleSocketError('socket hang up', 'ECONNRESET'));
    (client as any).http = { get };

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/socket hang up/);
    expect(get).toHaveBeenCalledTimes(2);
    client.destroy();
  });

  it('does not retry TS API errors (HTTP response received)', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockResolvedValue({ data: { status: { code: 1538, message: 'invalid parameter' } } });
    (client as any).http = { get };

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/invalid parameter/);
    expect(get).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('does not retry non-socket network errors', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const get = vi.fn().mockRejectedValue(staleSocketError('timeout of 15000ms exceeded', 'ECONNABORTED'));
    (client as any).http = { get };

    await expect(client.execute(1, 'serverinfo')).rejects.toThrow(/timeout/);
    expect(get).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('retries POST requests the same way', async () => {
    const client = new WebQueryClient('10.0.0.1', 10080, 'key');
    const post = vi.fn()
      .mockRejectedValueOnce(staleSocketError('read ECONNRESET', 'ECONNRESET'))
      .mockResolvedValueOnce(okResponse());
    (client as any).http = { post };

    const result = await client.executePost(1, 'clientaddperm', { foo: 'bar' });
    expect(result).toEqual({ ok: 1 });
    expect(post).toHaveBeenCalledTimes(2);
    client.destroy();
  });
});
