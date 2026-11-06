// Support desk for BluckFlies staff. Each person signs in with their own
// account (email, password and, when required, a code from an authenticator
// app); every change is recorded under their name. The emergency admin token
// still works, recorded under the name typed in. All data is rendered with
// textContent.

import { el } from './js/dom.js';

const $ = (id) => document.getElementById(id);
const KEY = 'bluckflies.desk';
let creds = null;
let filter = 'open';
let current = null;

function load() {
  try { return JSON.parse(sessionStorage.getItem(KEY) ?? 'null'); } catch { return null; }
}
function save(c) {
  try { if (c) sessionStorage.setItem(KEY, JSON.stringify(c)); else sessionStorage.removeItem(KEY); } catch { /* memory only */ }
}

function admin(path, opts = {}) {
  return call(`/api/admin${path}`, opts);
}
function staffApi(path, opts = {}) {
  return call(`/api/staff${path}`, opts);
}

async function call(url, { method = 'GET', body, csv } = {}) {
  const type = csv !== undefined ? 'text/csv' : body ? 'application/json' : null;
  const res = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${creds.token}`,
      ...(creds.kind === 'token' ? { 'x-staff-name': creds.name } : {}),
      ...(type ? { 'content-type': type } : {}),
    },
    ...(csv !== undefined ? { body: csv } : body ? { body: JSON.stringify(body) } : {}),
  });
  if (res.status === 401) {
    signOut();
    throw new Error('Signed out: the token was not accepted.');
  }
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error?.message ?? `Request failed (${res.status})`);
  return data;
}

const fmt = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');
const reason = (r) => r.replace(/_/g, ' ');

async function refreshList() {
  try {
    const { tickets } = await admin(`/tickets${filter ? `?status=${filter}` : ''}`);
    $('list-status').textContent = tickets.length ? '' : 'No tickets here.';
    $('tickets').replaceChildren(...tickets.map((tk) => {
      const b = el('button', { type: 'button', 'aria-current': String(tk.id === current) }, [
        el('span', { class: 't-top' }, [el('span', { class: 'reason', text: reason(tk.reason) }), el('span', { class: `badge ${tk.status}`, text: tk.status.replace('_', ' ') })]),
        el('span', { class: 't-summary', text: tk.summary }),
        el('span', { class: 't-top' }, [el('span', { text: fmt(tk.createdAt) }), el('span', { text: tk.assignee ? `→ ${tk.assignee}` : 'unassigned' })]),
      ]);
      b.addEventListener('click', () => openTicket(tk.id));
      return el('li', {}, [b]);
    }));
  } catch (e) {
    $('list-status').textContent = e.message;
  }
}

function box(title, children) {
  return el('div', { class: 'desk-box' }, [el('h3', { text: title }), ...children]);
}
function pairs(list) {
  return el('dl', {}, list.filter(([, v]) => v).flatMap(([k, v]) => [el('dt', { text: k }), el('dd', {}, [v])]));
}
const tel = (n) => el('a', { href: `tel:${n}`, text: n });

async function openTicket(id) {
  current = id;
  const d = $('detail');
  d.replaceChildren(el('p', { class: 'note', text: 'Loading…' }));
  try {
    const t = await admin(`/tickets/${id}`);
    const tk = t.ticket;
    const status = (s, label) => {
      const b = el('button', { type: 'button', class: tk.status === s ? 'btn primary sm' : 'btn ghost sm', text: label });
      b.addEventListener('click', () => act(() => admin(`/tickets/${id}`, { method: 'PATCH', body: { status: s } })));
      return b;
    };
    const mine = el('button', { type: 'button', class: 'btn ghost sm', text: tk.assignee === creds.name ? 'Unassign me' : 'Assign to me' });
    mine.addEventListener('click', () => act(() => admin(`/tickets/${id}`, { method: 'PATCH', body: { assignee: tk.assignee === creds.name ? null : creds.name } })));

    const note = el('textarea', { 'aria-label': 'Internal note', placeholder: 'Internal note (not sent to the traveller)', maxlength: '2000' });
    const noteForm = el('form', {}, [note, el('button', { class: 'btn primary sm', type: 'submit', text: 'Add note' })]);
    noteForm.addEventListener('submit', (e) => { e.preventDefault(); if (note.value.trim()) act(() => admin(`/tickets/${id}/notes`, { method: 'POST', body: { body: note.value } })); });

    const sms = el('textarea', { 'aria-label': 'SMS to traveller', placeholder: 'SMS to the traveller (sent as "BluckFlies: …")', maxlength: '600' });
    const smsForm = el('form', {}, [sms, el('button', { class: 'btn primary sm', type: 'submit', text: 'Send SMS' })]);
    smsForm.addEventListener('submit', (e) => { e.preventDefault(); if (sms.value.trim()) act(() => admin(`/tickets/${id}/messages`, { method: 'POST', body: { text: sms.value } })); });

    const b = t.booking;
    const pay = t.payment;
    d.replaceChildren(
      el('div', { class: 'row' }, [el('h2', { text: `${reason(tk.reason)}` }), el('span', { class: `badge ${tk.status}`, text: tk.status.replace('_', ' ') })]),
      el('p', { text: tk.summary }),
      el('div', { class: 'row' }, [status('open', 'Open'), status('in_progress', 'In progress'), status('resolved', 'Resolved'), mine]),
      box('Traveller', [pairs([['Channel', t.channel], ['Phone', b?.contact.phone ? tel(b.contact.phone) : t.travellerPhone ? tel(t.travellerPhone) : 'unknown'], ['Email', b?.contact.email ? el('a', { href: `mailto:${b.contact.email}`, text: b.contact.email }) : ''], ['Language', b?.contact.language ?? '']])]),
      b
        ? box(`Booking ${b.pnr}`, [pairs([['Status', b.status], ['Flights', b.route], ['Departs', b.departs ? `${b.departs.slice(0, 10)} ${b.departs.slice(11, 16)} (local)` : ''], ['Total', b.total], ['Tickets', b.ticketNumbers.join(', ')], ['Travellers', b.passengers.join(', ')]])])
        : '',
      pay
        ? box('Payment', [
            pairs([['Method', pay.method.replace('_', ' ')], ['Status', pay.status.replace('_', ' ')], ['Amount due', pay.amountDue], ['Provider', pay.provider], ['Requested', fmt(pay.createdAt)]]),
            ...(['bank_transfer', 'cash_office'].includes(pay.method) && ['requested', 'cancelled', 'failed'].includes(pay.status) ? [manualPaymentForm(id, pay, b?.pnr)] : []),
            ...(pay.refundByHand && creds.role !== 'partner' ? [refundPaidForm(id, pay)] : []),
          ])
        : '',
      box('Conversation', [t.transcript.length ? el('div', { class: 'transcript' }, t.transcript.map((m) => el('p', { class: m.role, dir: 'auto', text: `${m.role === 'traveller' ? 'Traveller' : 'BluckFlies AI'}: ${m.text}` }))) : el('p', { class: 'note', text: 'No chat transcript.' })]),
      box('Notes', [el('ul', { class: 'notes' }, t.notes.map((n) => el('li', {}, [el('time', { text: fmt(n.createdAt) }), el('strong', { text: `${n.author}: ` }), n.body]))), noteForm]),
      box('Message the traveller', [smsForm]),
      el('p', { class: 'note', text: `Ticket ${tk.id} · opened ${fmt(tk.createdAt)} · updated ${fmt(tk.updatedAt)}` }),
    );
  } catch (e) {
    d.replaceChildren(el('p', { class: 'note', role: 'alert', text: e.message }));
  }
}

/**
 * Confirm a bank transfer only after the money shows on the bank statement, and
 * office cash only against a numbered receipt: the exact amount due. "Received"
 * issues the tickets (or refunds, if the seats were already released).
 */
function manualPaymentForm(id, pay, pnr) {
  const cash = pay.method === 'cash_office';
  const amount = el('input', { type: 'text', inputmode: 'decimal', required: '', placeholder: 'e.g. 412.50', 'aria-label': 'Amount received in USD', autocomplete: 'off' });
  const ref = el('input', {
    type: 'text', required: '', minlength: '2', maxlength: '60', autocomplete: 'off',
    placeholder: cash ? 'Receipt number you issued' : 'Bank transaction or deposit slip number',
    'aria-label': cash ? 'Receipt number' : 'Bank reference',
  });
  const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Note (optional)', 'aria-label': 'Note' });
  const late = pay.status !== 'requested'
    ? [el('p', { class: 'note', role: 'note', text: 'The seat hold has ended or the payment was marked not received. Confirming now records the money and refunds the traveller instead of ticketing.' })]
    : [];
  const form = el('form', { class: 'bank-form' }, [
    el('p', { class: 'note', text: cash
      ? `Take ${pay.amountDue} in US dollars for booking ${pnr ?? ''}, issue a numbered receipt, then confirm. Confirm only the exact amount.`
      : `Check the bank statement for ${pay.amountDue} with reference ${pnr ?? 'the booking code'}, or use "Import bank statement". Confirm only the exact amount.` }),
    ...late,
    el('label', {}, ['Amount received (USD)', amount]),
    el('label', {}, [cash ? 'Receipt number' : 'Bank reference', ref]),
    note,
    el('div', { class: 'row' }, [el('button', { class: 'btn primary sm', type: 'submit', text: cash ? 'Cash received' : 'Money received' })]),
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act(() => admin(`/tickets/${id}/manual-payment`, { method: 'POST', body: { received: true, amountUsd: amount.value, reference: ref.value, ...(note.value.trim() ? { note: note.value } : {}) } }));
  });
  if (pay.status === 'requested') {
    const no = el('button', { class: 'btn ghost sm', type: 'button', text: 'Not received' });
    no.addEventListener('click', () => act(() => admin(`/tickets/${id}/manual-payment`, { method: 'POST', body: { received: false, ...(note.value.trim() ? { note: note.value } : {}) } })));
    form.querySelector('.row')?.append(no);
  }
  return form;
}

/**
 * A refund the payment provider could not make (bank transfer, office cash):
 * pay it, then record the transfer number or cash receipt here. The booking is
 * marked refunded and the traveller gets the "refund done" message.
 */
function refundPaidForm(id, pay) {
  const cash = pay.method === 'cash_office';
  const ref = el('input', {
    type: 'text', required: '', minlength: '2', maxlength: '80', autocomplete: 'off',
    placeholder: cash ? 'Number of the receipt the traveller signed' : 'Bank transfer reference',
    'aria-label': cash ? 'Refund receipt number' : 'Refund transfer reference',
  });
  const note = el('input', { type: 'text', maxlength: '500', placeholder: 'Note (optional)', 'aria-label': 'Note' });
  const form = el('form', { class: 'bank-form' }, [
    el('p', { class: 'note', text: `Refund owed: see the amount in the ticket summary. ${cash ? 'Pay it in cash against the traveller\'s original receipt and ID, and have them sign a refund receipt.' : 'Send it by bank transfer to the account that paid, after checking it belongs to the traveller.'} Then record it here.` }),
    el('label', {}, [cash ? 'Refund receipt number' : 'Transfer reference', ref]),
    note,
    el('div', { class: 'row' }, [el('button', { class: 'btn primary sm', type: 'submit', text: 'Refund paid' })]),
  ]);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    act(() => admin(`/tickets/${id}/refund-paid`, { method: 'POST', body: { reference: ref.value, ...(note.value.trim() ? { note: note.value } : {}) } }));
  });
  return form;
}

// ------------------------------------------------- bank statement import

const MATCH_LABEL = {
  match: 'Ready to confirm',
  amount_differs: 'Amount differs: contact the traveller',
  already_confirmed: 'Already confirmed',
  duplicate: 'Second payment for this booking: check',
};

/** Upload the bank's CSV export, review the matches, then confirm the exact ones in one go. */
function openStatementImport() {
  current = null;
  const d = $('detail');
  const file = el('input', { type: 'file', accept: '.csv,text/csv', 'aria-label': 'Bank statement CSV file' });
  const out = el('div', { class: 'statement-out', 'aria-live': 'polite' });
  let csv = '';

  async function preview() {
    if (!file.files?.[0]) return;
    if (file.files[0].size > 2_000_000) { out.replaceChildren(el('p', { class: 'note', role: 'alert', text: 'The file is larger than 2 MB. Export a shorter date range.' })); return; }
    csv = await file.files[0].text();
    out.replaceChildren(el('p', { class: 'note', text: 'Matching…' }));
    try {
      render(await admin('/payments/bank-statement', { method: 'POST', csv }));
    } catch (e) {
      out.replaceChildren(el('p', { class: 'note', role: 'alert', text: e.message }));
    }
  }

  function render(r, done = false) {
    const ready = r.matches.filter((m) => m.status === 'match' && !m.bookingStatus);
    const boxes = new Map();
    const rows = r.matches.map((m) => {
      const box = el('input', { type: 'checkbox', 'aria-label': `Confirm ${m.pnr}` });
      box.checked = m.status === 'match' && !m.bookingStatus;
      box.disabled = m.status !== 'match' || Boolean(m.bookingStatus);
      boxes.set(m.lineId, box);
      return el('tr', { class: `m-${m.status}` }, [
        el('td', {}, [box]),
        el('td', { text: m.pnr }),
        el('td', { text: m.amount ?? '' }),
        el('td', { text: m.amountDue }),
        el('td', { text: m.bankReference ?? `row ${m.row}` }),
        el('td', { text: m.date ?? '' }),
        el('td', { text: m.error ?? (m.bookingStatus ? `Confirmed: booking ${m.bookingStatus}` : MATCH_LABEL[m.status]) }),
      ]);
    });
    const confirm = el('button', { class: 'btn primary sm', type: 'button', text: `Confirm ${ready.length} payment${ready.length === 1 ? '' : 's'}` });
    confirm.disabled = ready.length === 0;
    confirm.addEventListener('click', async () => {
      const ids = [...boxes].filter(([, b]) => b.checked && !b.disabled).map(([id]) => id);
      if (!ids.length) return;
      confirm.disabled = true;
      try {
        render(await admin(`/payments/bank-statement?apply=${ids.join(',')}`, { method: 'POST', csv }), true);
        refreshList();
      } catch (e) {
        out.prepend(el('p', { class: 'note', role: 'alert', text: e.message }));
        confirm.disabled = false;
      }
    });
    out.replaceChildren(
      el('p', { class: 'note', text: `${r.linesRead} lines read (amount column "${r.columns.amount}"${r.columns.reference ? `, reference column "${r.columns.reference}"` : ''}). ${r.matches.length} mention a booking code; ${r.unrelatedCredits} other incoming payments ignored.${done ? ` ${r.applied} confirmed.` : ''}` }),
      r.matches.length
        ? el('table', { class: 'statement' }, [
            el('thead', {}, [el('tr', {}, ['', 'Booking', 'Received', 'Due', 'Bank reference', 'Date', 'Result'].map((h) => el('th', { text: h })))]),
            el('tbody', {}, rows),
          ])
        : el('p', { class: 'note', text: 'No line mentions an open bank-transfer booking code.' }),
      ...(done ? [] : [el('div', { class: 'row' }, [confirm])]),
    );
  }

  file.addEventListener('change', preview);
  d.replaceChildren(
    el('h2', { text: 'Import bank statement' }),
    el('p', { text: 'Export the account statement from your bank as CSV (with a header row), then choose the file. Deposits whose description contains a booking code and the exact amount due are matched; nothing is confirmed until you press Confirm.' }),
    file,
    out,
  );
}

async function act(fn) {
  try {
    await fn();
  } catch (e) {
    alertText(e.message);
    return;
  }
  await Promise.all([refreshList(), current ? openTicket(current) : null]);
}
function alertText(msg) {
  $('detail').prepend(el('p', { class: 'note', role: 'alert', text: msg }));
}

// ------------------------------------------------------------- accounts

const SCREENS = ['signin', 'token-signin', 'setup-2fa', 'desk'];
function screen(id) {
  for (const s of SCREENS) $(s).hidden = s !== id;
  $('signout').hidden = !(id === 'desk' || id === 'setup-2fa');
}

function signOut() {
  const was = creds;
  creds = null;
  save(null);
  // Best effort, sent directly (not through call(), which signs out on 401).
  if (was?.kind === 'staff') fetch('/api/staff/logout', { method: 'POST', headers: { authorization: `Bearer ${was.token}` } }).catch(() => undefined);
  screen('signin');
  $('who').textContent = '';
  $('code-row').hidden = true;
}

async function signedIn() {
  if (creds.kind === 'staff') {
    try {
      const { staff } = await staffApi('/me');
      creds = { ...creds, name: staff.name, role: staff.role };
      save(creds);
      if (staff.needs2fa) return startSetup(staff);
    } catch {
      return; // call() already signed out on 401
    }
  }
  screen('desk');
  $('import-statement').onclick = openStatementImport;
  $('import-statement').hidden = creds.role === 'partner';
  $('manage-staff').hidden = creds.role !== 'admin';
  $('manage-staff').onclick = openStaff;
  $('reports').hidden = creds.role !== 'admin';
  $('reports').onclick = openReports;
  $('my-account').hidden = creds.kind !== 'staff';
  $('my-account').onclick = openAccount;
  $('who').textContent = `Signed in as ${creds.name}${creds.role ? ` (${creds.role})` : ''}`;
  refreshList();
}

$('signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('signin-error').textContent = '';
  const code = $('code').value.trim();
  try {
    const res = await fetch('/api/staff/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: $('email').value, password: $('password').value, ...(code ? { code } : {}) }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message ?? `Sign-in failed (${res.status})`);
    if (data.status === 'code_required') {
      $('code-row').hidden = false;
      $('code').focus();
      $('signin-error').textContent = 'Enter the 6-digit code from your authenticator app.';
      return;
    }
    creds = { kind: 'staff', token: data.token, name: data.staff.name, role: data.staff.role };
    save(creds);
    $('password').value = '';
    $('code').value = '';
    $('code-row').hidden = true;
    signedIn();
  } catch (err) {
    $('signin-error').textContent = err.message;
  }
});

$('token-signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  creds = { kind: 'token', name: $('name').value.trim(), token: $('token').value.trim(), role: 'admin' };
  try {
    await admin('/tickets?status=open');
    save(creds);
    $('token').value = '';
    signedIn();
  } catch (err) {
    $('token-error').textContent = err.message;
  }
});
$('use-token').addEventListener('click', () => screen('token-signin'));
$('use-account').addEventListener('click', () => screen('signin'));

async function startSetup(staff) {
  screen('setup-2fa');
  $('who').textContent = `Signed in as ${staff.name}`;
  $('setup-error').textContent = '';
  try {
    const { secret } = await staffApi('/2fa/start', { method: 'POST' });
    $('setup-key').textContent = secret.replace(/(.{4})/g, '$1 ').trim();
    $('setup-account').textContent = `BluckFlies: ${staff.email}`;
  } catch (err) {
    $('setup-error').textContent = err.message;
  }
}
$('setup-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await staffApi('/2fa/confirm', { method: 'POST', body: { code: $('setup-code').value.trim() } });
    $('setup-code').value = '';
    $('setup-key').textContent = '';
    signedIn();
  } catch (err) {
    $('setup-error').textContent = err.message;
  }
});

/** Change your own password (signs out your other devices). */
function openAccount() {
  current = null;
  const cur = el('input', { type: 'password', autocomplete: 'current-password', required: '' });
  const next = el('input', { type: 'password', autocomplete: 'new-password', required: '', minlength: '12' });
  const msg = el('p', { class: 'note', role: 'status' });
  const form = el('form', { class: 'stack' }, [
    el('label', {}, ['Current password', cur]),
    el('label', {}, ['New password (12 characters or more; a short sentence works well)', next]),
    el('button', { class: 'btn primary sm', type: 'submit', text: 'Change password' }),
    msg,
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await staffApi('/password', { method: 'POST', body: { current: cur.value, next: next.value } });
      cur.value = next.value = '';
      msg.textContent = 'Password changed. Your other devices were signed out.';
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  $('detail').replaceChildren(el('h2', { text: 'My account' }), el('p', { text: `${creds.name} · ${creds.role}` }), form);
}

/** Admins: finance CSV downloads (open in Excel or Google Sheets). */
function openReports() {
  current = null;
  const iso = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Africa/Juba' });
  const today = new Date();
  const from = el('input', { type: 'date', required: '', value: iso(new Date(today.getFullYear(), today.getMonth(), 1)) });
  const to = el('input', { type: 'date', required: '', value: iso(today) });
  const msg = el('p', { class: 'note', role: 'status' });
  const download = (kind, label, needsDates = true) => {
    const b = el('button', { type: 'button', class: 'btn primary sm', text: label });
    b.addEventListener('click', async () => {
      msg.textContent = 'Preparing…';
      try {
        const q = needsDates ? `?from=${from.value}&to=${to.value}` : '';
        const res = await fetch(`/api/admin/reports/${kind}${q}`, { headers: { authorization: `Bearer ${creds.token}`, ...(creds.kind === 'token' ? { 'x-staff-name': creds.name } : {}) } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error?.message ?? `Failed (${res.status})`);
        const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? `${kind}.csv`;
        const url = URL.createObjectURL(await res.blob());
        const a = el('a', { href: url, download: name });
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10_000);
        msg.textContent = `Downloaded ${name}.`;
      } catch (err) {
        msg.textContent = err.message;
      }
    });
    return b;
  };
  $('detail').replaceChildren(
    el('h2', { text: 'Finance reports' }),
    el('p', { text: 'CSV files for Excel or Google Sheets. Days are Juba days. Amounts are in US dollars unless a column says otherwise.' }),
    el('form', { class: 'stack' }, [el('label', {}, ['From', from]), el('label', {}, ['To', to])]),
    el('div', { class: 'report-list' }, [
      el('div', {}, [download('payments', 'Payments ledger'), el('p', { class: 'note', text: 'Every payment created, paid, changed or refunded in the period: booking, method, status, amount, charged currency and rate, references.' })]),
      el('div', {}, [download('daily', 'Daily summary'), el('p', { class: 'note', text: 'Per day: bookings paid, money received by payment method (by payment date), refunds completed, refunds still owed, requests not yet paid.' })]),
      el('div', {}, [download('refunds-owed', 'Refunds owed now', false), el('p', { class: 'note', text: 'Every refund not yet completed, oldest first, with days waiting and who must make it.' })]),
      el('div', {}, [download('ai-usage', 'AI assistant usage'), el('p', { class: 'note', text: 'Per day: AI model calls, conversations, tokens and estimated cost against the daily budget.' })]),
    ]),
    msg,
  );
}

const ROLE_HELP = { admin: 'Everything, including staff and exchange rates', agent: 'Tickets, payments and bank statements', partner: 'Only cash payments at their office' };

/** Admins: add staff and partner agents, change roles, disable, reset passwords or two-step login. */
async function openStaff() {
  current = null;
  const d = $('detail');
  d.replaceChildren(el('p', { class: 'note', text: 'Loading…' }));
  let list;
  try {
    ({ staff: list } = await admin('/staff'));
  } catch (err) {
    d.replaceChildren(el('p', { class: 'note', role: 'alert', text: err.message }));
    return;
  }
  const change = (id, body, confirmText) => async () => {
    if (confirmText && !window.confirm(confirmText)) return;
    try {
      await admin(`/staff/${id}`, { method: 'PATCH', body });
      openStaff();
    } catch (err) {
      d.prepend(el('p', { class: 'note', role: 'alert', text: err.message }));
    }
  };
  const btn = (text, fn) => {
    const b = el('button', { type: 'button', class: 'btn ghost sm', text });
    b.addEventListener('click', fn);
    return b;
  };
  const rows = list.map((s) => {
    const role = el('select', { 'aria-label': `Role of ${s.name}` }, ['admin', 'agent', 'partner'].map((r) => el('option', { value: r, text: r })));
    role.value = s.role;
    role.addEventListener('change', change(s.id, { role: role.value }, `Change ${s.name}'s role to ${role.value}? They will be signed out.`));
    return el('tr', {}, [
      el('td', {}, [el('strong', { text: s.name }), el('br'), el('span', { class: 'note', text: s.email })]),
      el('td', {}, [role]),
      el('td', { text: s.disabled ? 'Disabled' : s.lockedUntil && Date.parse(s.lockedUntil) > Date.now() ? 'Locked' : 'Active' }),
      el('td', { text: s.twoStepEnabled ? 'On' : 'Not set up' }),
      el('td', {}, [el('div', { class: 'row' }, [
        btn(s.disabled ? 'Enable' : 'Disable', change(s.id, { disabled: !s.disabled }, s.disabled ? null : `Disable ${s.name}? They are signed out at once.`)),
        btn('Reset password', async () => {
          const pw = window.prompt(`New temporary password for ${s.name} (12+ characters). Give it to them in person or by phone.`);
          if (pw) await change(s.id, { password: pw })();
        }),
        ...(s.twoStepEnabled ? [btn('Reset two-step', change(s.id, { reset2fa: true }, `Reset two-step login for ${s.name}? They set it up again at next sign-in.`))] : []),
        ...(s.lockedUntil ? [btn('Unlock', change(s.id, { unlock: true }))] : []),
      ])]),
    ]);
  });

  const email = el('input', { type: 'email', required: '', maxlength: '200', autocomplete: 'off' });
  const name = el('input', { required: '', minlength: '2', maxlength: '60', autocomplete: 'off' });
  const role = el('select', {}, Object.entries(ROLE_HELP).map(([r, help]) => el('option', { value: r, text: `${r}: ${help}` })));
  role.value = 'agent';
  const pw = el('input', { type: 'password', required: '', minlength: '12', autocomplete: 'new-password' });
  const msg = el('p', { class: 'note', role: 'status' });
  const form = el('form', { class: 'stack' }, [
    el('label', {}, ['Email', email]),
    el('label', {}, ['Name (shown on everything they do)', name]),
    el('label', {}, ['Role', role]),
    el('label', {}, ['Temporary password (12+ characters; they can change it)', pw]),
    el('button', { class: 'btn primary sm', type: 'submit', text: 'Add staff member' }),
    msg,
  ]);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await admin('/staff', { method: 'POST', body: { email: email.value, name: name.value, role: role.value, password: pw.value } });
      openStaff();
    } catch (err) {
      msg.textContent = err.message;
    }
  });
  d.replaceChildren(
    el('h2', { text: 'Staff and partner agents' }),
    el('table', { class: 'staff' }, [
      el('thead', {}, [el('tr', {}, ['Person', 'Role', 'Status', 'Two-step', ''].map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows),
    ]),
    el('h3', { text: 'Add a staff member or partner agent' }),
    form,
  );
}

$('signout').addEventListener('click', signOut);
document.querySelectorAll('[data-status]').forEach((b) => b.addEventListener('click', () => {
  filter = b.dataset.status;
  document.querySelectorAll('[data-status]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
  refreshList();
}));
setInterval(() => { if (creds && !$('desk').hidden && document.visibilityState === 'visible') refreshList(); }, 30_000);

creds = load();
if (creds?.kind) signedIn();
else screen('signin');
