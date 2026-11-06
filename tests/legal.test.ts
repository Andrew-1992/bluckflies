import { readFileSync } from 'node:fs';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/http/app.js';
import { fillTemplate, LEGAL_PAGES } from '../src/http/legal.js';
import { testConfig, testContainer } from './helpers.js';

const COMPANY = {
  LEGAL_COMPANY_NAME: 'BluckFlies Travel <Ltd> & Co',
  LEGAL_COMPANY_ADDRESS: 'Hai Malakal, Juba, South Sudan',
  SUPPORT_EMAIL: 'help@bluckflies.example',
  SUPPORT_PHONE: '+211912345678',
};

describe('legal pages', () => {
  it('serves terms, privacy and refunds as drafts until approved, with gaps clearly marked', async () => {
    const app = createApp(testContainer().c);
    for (const path of Object.keys(LEGAL_PAGES)) {
      const res = await request(app).get(path).expect(200).expect('content-type', /html/);
      expect(res.text).toContain('Draft for legal review');
      if (path !== '/refunds') expect(res.text).toContain('[to be completed: company legal name]'); // refunds page names no company
      expect(res.text).not.toMatch(/\{\{\w+\}\}/); // every placeholder filled
      expect(res.text).not.toContain('<!--'); // reviewer notes are not published
    }
  });

  it('fills in the company details, escaped, and drops the banner once approved', async () => {
    const app = createApp(testContainer({}, { ...COMPANY, LEGAL_PAGES_APPROVED: 'true', DATA_RETENTION_DAYS: '45' }).c);
    const terms = (await request(app).get('/terms').expect(200)).text;
    expect(terms).toContain('BluckFlies Travel &lt;Ltd&gt; &amp; Co');
    expect(terms).not.toContain('<Ltd>');
    expect(terms).not.toContain('Draft for legal review');
    expect(terms).toContain('help@bluckflies.example');
    expect((await request(app).get('/privacy').expect(200)).text).toContain('deleted 45 days after the last message');
  });

  it('refuses to mark the pages approved without the company details', () => {
    expect(() => testConfig({ LEGAL_PAGES_APPROVED: 'true' })).toThrow(/LEGAL_PAGES_APPROVED=true needs/);
  });

  it('treats an unknown placeholder as an error, not blank text', () => {
    expect(() => fillTemplate('Hello {{nobody}}', {})).toThrow(/unknown placeholder \{\{nobody\}\}/);
  });

  it('does not serve the raw templates', async () => {
    const app = createApp(testContainer().c);
    await request(app).get('/legal/terms.html').expect(404);
    expect(readFileSync(new URL('../legal/terms.html', import.meta.url), 'utf8')).toContain('{{company}}');
  });
});
