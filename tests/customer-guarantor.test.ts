/** A guarantor's name and phone number, required when the customer is registered. */
import { describe, it, expect, beforeAll } from 'vitest';
import { makeRequest, freshPhone, registrationFields } from './helpers';
import { POST as loginPOST } from '@/app/api/auth/login/route';
import { POST as customersPOST } from '@/app/api/customers/route';

describe('Guarantor at registration', () => {
  let token: string;
  beforeAll(async () => {
    token = (await (await loginPOST(makeRequest('POST', '/api/auth/login', { body: { email: 'agent@example.test', password: 'Passw0rd!123' } }))).json()).token;
  });
  const register = async (extra: Record<string, string>, phone?: string) =>
    customersPOST(makeRequest('POST', '/api/customers', { token, body: { ...registrationFields(), firstName: 'Kwesi', lastName: 'Guarantee', phone: phone ?? await freshPhone(), ...extra } }));

  it('saves the guarantor with the customer, in the same form as other numbers', async () => {
    const res = await register({ guarantorName: 'Efua Mensah', guarantorPhone: '024 111 2233' });
    expect(res.status).toBe(201);
    expect((await res.json()).customer).toMatchObject({ guarantorName: 'Efua Mensah', guarantorPhone: '0241112233' });
  });

  it('is required: both the name and a valid number', async () => {
    const none = await register({ guarantorName: '', guarantorPhone: '' });
    expect(none.status).toBe(400);
    expect((await none.json()).error).toMatch(/guarantor's name and phone number are required/);
    expect((await register({ guarantorName: 'Efua Mensah', guarantorPhone: '' })).status).toBe(400);
    expect((await register({ guarantorName: '', guarantorPhone: '0241112233' })).status).toBe(400);
    expect((await register({ guarantorName: 'Efua Mensah', guarantorPhone: '12' })).status).toBe(400);
  });

  it('refuses the customer\'s own number as the guarantor\'s', async () => {
    const phone = await freshPhone();
    const res = await register({ guarantorName: 'Efua Mensah', guarantorPhone: phone }, phone);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/cannot be the customer's own/);
  });
});
