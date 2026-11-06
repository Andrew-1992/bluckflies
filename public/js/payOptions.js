// Which ways to pay are switched on (from the server), so the interface only
// offers those. Until the answer arrives, the common methods are assumed.

const DEFAULT = ['card', 'bank_transfer'];
let methods = DEFAULT;
let cardProvider = '';
let loading = null;

export function loadPaymentOptions() {
  loading ??= fetch('/api/payment-options')
    .then((r) => (r.ok ? r.json() : null))
    .then((data) => {
      if (data && Array.isArray(data.methods)) {
        methods = data.methods.map((m) => m.method);
        cardProvider = typeof data.cardProvider === 'string' ? data.cardProvider : '';
      }
    })
    .catch(() => { /* keep the defaults */ });
  return loading;
}

export const hasMethod = (m) => methods.includes(m);
/** Apple Pay / Google Pay only exist on Stripe's page. */
export const hasWallets = () => cardProvider === 'stripe';
