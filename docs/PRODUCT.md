# BluckFlies — Product Description

BluckFlies is a conversational travel agent for flying into, out of, and within South Sudan. Travellers chat with it in English or Arabic, including Juba Arabic, from a phone browser on a low-bandwidth connection.

## What the agent does

| Capability | What happens |
|---|---|
| **Search** | Finds one-way and return flights on real airlines (through Duffel) by route, date, cabin and travellers (adults, children's ages, lap infants), including connections. A return trip is one search: each option covers both directions at one price set by the airline. It understands city names in English and Arabic and resolves relative dates against Juba time. Domestic routes are served by agents in production. |
| **Compare** | Ranks offers and tags the cheapest, fastest and best-value ones. It explains stops, duration, baggage and refundability, showing prices in USD with an indicative SSP equivalent. |
| **Reserve** | Collects and reads back passenger details (Latin-script names as on the passport, gender, date of birth, passport, email), then checks them against the priced fare. It then *proposes* the booking, and the traveller taps **Confirm**. Airlines that allow holds reserve the seats at once; pay-now airlines are booked as soon as payment arrives. |
| **Pay** | Cards (Visa, Mastercard, Amex, Apple Pay, Google Pay) through **Stripe Checkout**, the hosted payment page used by many AI and SaaS products and well suited to international and diaspora travellers. Locally, mobile money (MTN MoMo) charged in **South Sudanese pounds** at an exchange rate locked when the request is sent and shown before the traveller approves on their phone. Tickets are issued only after the provider confirms the exact amount and currency. |
| **Manage** | Retrieves bookings, explains cancellation outcomes and refund amounts, and cancels on traveller confirmation. Changes to a ticketed booking go to a BluckFlies agent with the booking attached. It tracks refunds to completion and checks flight status. A return trip is one booking (one booking code, one payment, one ticket per traveller covering both directions). |
| **Talk** | Travellers can speak instead of typing, in English or Arabic, and hear replies read aloud. They can tap the microphone for one message or open a hands-free voice conversation. Spoken turns get short, plain replies in the language spoken, and the agent confirms unclear cities, dates and numbers. Passport names are still typed or spelled. |
| **Stay informed** | E-ticket by email and SMS once payment is confirmed (in English or Arabic), plus "seats held, pay before …" and refund messages. Travellers log in with their phone number and an SMS code to see their tickets on any phone. |
| **Reach us anywhere** | Chat on the website, on WhatsApp or by SMS. On WhatsApp the traveller taps ✓ Yes / ✗ No to confirm; by SMS they reply YES or NO. "Talk to a person" and change requests reach the support team's desk with the booking attached. |
| **Assist** | Gives guidance on entry documents, baggage, airports, check-in and payments (always deferring to official sources) and hands off to a human agent for complaints, special assistance and group bookings. |

## What the agent will never do

- Reserve seats or cancel a booking without the traveller's tap. No agent tool can approve a confirmation.
- Ask for or accept PINs, passwords, OTPs or card numbers.
- Present a flight, fare, PNR or ticket that a tool did not return.
- Access another traveller's bookings. The session is taken from authentication, never from model input.

## Booking lifecycle

```
search → offer (30 min) → proposal ──traveller confirms──▶ held (60 min)
held ──request_payment──▶ payment_pending ──verified payment (webhook or reconciliation)──▶ ticketing ──supplier issues tickets──▶ ticketed
ticketing ──supplier outage──▶ ticketing (retried by reconciliation; already-issued tickets are adopted, never re-issued)
payment_pending ──payment failed / checkout expired──▶ held (retry allowed)
held/payment_pending ──hold timeout (on read or hold sweeper)──▶ expired (payment link voided; late payment refunded in full)
held/payment_pending ──confirmed cancel──▶ cancelled
ticketed (refundable) ──confirmed cancel──▶ refund_pending ──webhook──▶ refunded
```
