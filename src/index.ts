// ================================
// Stripe2SevDesk connector
//
// Required environment variables:
// - STRIPE_SECRET
// - STRIPE_WEBHOOK_SECRET
// - SENTRY_DSN (optional)
// - SEVDESK_API_KEY_SECRET
// - SEVDESK_CHECK_ACCOUNT
// ================================

import type {HttpFunction} from '@google-cloud/functions-framework/build/src/functions';
import '@google-cloud/functions-framework/build/src/invoker';
import Stripe from 'stripe';
import {Request, Response} from "express";
import axios, {AxiosError, AxiosInstance, AxiosResponse} from "axios";

const Sentry = require("@sentry/serverless");
const stripe = require('stripe')(process.env.STRIPE_SECRET);
const {SecretManagerServiceClient} = require('@google-cloud/secret-manager');
const secretManagerClient = new SecretManagerServiceClient();

Sentry.GCPFunction.init({
    dsn: process.env.SENTRY_DSN,
    tracesSampleRate: 1.0,
});


/**
 * Handles a Stripe webhook request and pushes changes to the SevDesk API.
 * Delegates the events to subsequent functions.
 *
 * @param {Object} req Cloud Function request context. More info: https://expressjs.com/en/api.html#req
 * @param {Object} res Cloud Function response context.
 */
export const webhook: HttpFunction = Sentry.GCPFunction.wrapHttpFunction((req: Request, res: Response) => {
    let event;

    try {
        event = stripe.webhooks
            .constructEvent(req.rawBody, req.headers['stripe-signature'], process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        res.status(400).json({error: true, message: err.message});
        return;
    }

    switch (event.type) {
        case 'invoice.finalized':
            onInvoiceFinalized(event.data.object)
                .then(() => res.json({received: true}))
                .catch(error => handleError(res, error))
            break;

        case 'invoice.paid':
            onInvoicePaid(event.data.object)
                .then(() => res.json({received: true}))
                .catch(error => handleError(res, error))
            break;

        case 'invoice.voided':
            onInvoiceVoided(event.data.object)
                .then(() => res.json({received: true}))
                .catch(error => handleError(res, error))
            break;

        case 'customer.created':
        case 'customer.updated':
            onCustomerUpdated(event.data.object)
                .then(() => res.json({received: true}))
                .catch(error => handleError(res, error))
            break;

        case 'payout.paid':
            break;
    }

    res.status(400).send('Event type not supported');

    throw new Error(`Unhandled event type ${event.type}`);
});

/**
 * Creates an invoice in SevDesk.
 *
 * @param invoice
 */
async function onInvoiceFinalized(invoice: Stripe.Invoice): Promise<AxiosResponse> {
    const client = await sevDeskClient()

    // Fetch customer, also see https://stripe.com/docs/expand#with-webhooks.
    const customer = await stripe.customers.retrieve(String(invoice.customer))
    let contactId
    if (null !== customer.metadata && null !== customer.metadata.sevdesk_id) {
        contactId = customer.metadata.sevdesk_id
    } else {
        const contact = await createOrUpdateContact(customer)
        contactId = contact.data.id
    }

    // Populate invoice items
    const invoiceItems = Array.from(invoice.lines.data).map((line: Stripe.InvoiceLineItem) => {
        let taxRate = null;
        if (line.tax_amounts && line.tax_amounts.length) {
            if (line.tax_amounts.length > 1) {
                throw new Error('Multiple tax rates per item are not supported.')
            }

            stripe.taxRates.retrieve(String(line.tax_amounts[0].tax_rate))
                .then((stripeTaxRate: Stripe.TaxRate) => taxRate = stripeTaxRate.percentage)
        }

        return {
            quantity: line.quantity,
            price: line.amount,
            name: line.description,
            text: null,
            discount: null,
            taxRate: taxRate ? taxRate / 100 : null,
            priceGross: null,
            priceTax: null,
            mapAll: true,
            objectName: 'InvoicePos'
        }
    });

    // Create invoice
    try {
        const response = await client.post('/Invoice/Factory/saveInvoice',
            {
                invoice: {
                    invoiceNumber: invoice.number,
                    contact: {
                        id: contactId,
                        objectName: "Contact"
                    },
                    invoiceDate: invoice.created,
                    deliveryDate: 0,
                    deliveryDateUntil: 0,
                    discount: 0,
                    status: 200,
                    contactPerson: null,
                    smallSettlement: false,
                    taxType: invoice.customer_tax_exempt === 'exempt' ? 'eu' : (invoice.customer_tax_exempt === 'reverse' ? 'noteu' : 'default'),
                    currency: invoice.currency.toUpperCase(),
                    invoiceType: 'RE',
                    sendType: 'VM',
                },
                invoicePosSave: invoiceItems
            })

        const invoiceId = response.data.id

        await stripe.invoices.update(invoice.id, {metadata: {sevdesk_id: invoiceId}})

        return response
    } catch (err) {
        return Promise.reject(err)
    }

    // await client.post(`/Invoice/${invoiceId}/sendViaEmail`,
    //     {
    //         toEmail: invoice.customer_email,
    //         subject: null,
    //         text: null,
    //     })
}

/**
 * Cancels an invoice in SevDesk.
 *
 * @param invoice
 */
async function onInvoiceVoided(invoice: Stripe.Invoice): Promise<AxiosResponse> {
    if (null === invoice.metadata || null === invoice.metadata.sevdesk_id) {
        return Promise.reject(Error('No SevDesk link found.'))
    }

    const invoiceId = invoice.metadata.sevdesk_id;

    const client = await sevDeskClient()

    return client.post(`/Invoice/${invoiceId}/cancelInvoice`)
}

/**
 * Books the invoice in SevDesk.
 *
 * @param invoice
 */
async function onInvoicePaid(invoice: Stripe.Invoice): Promise<AxiosResponse> {
    if (null === invoice.metadata || null === invoice.metadata.sevdesk_id) {
        return Promise.reject(Error('No SevDesk link found.'));
    }

    const invoiceId = invoice.metadata.sevdesk_id;

    const client = await sevDeskClient()

    return client.put(`/Invoice/${invoiceId}/bookAmount`, {
        amount: invoice.amount_paid,
        date: new Date().toLocaleDateString('de'),
        type: 'N',
        checkAccount: {
            id: process.env.SEVDESK_CHECK_ACCOUNT,
            objectName: "CheckAccount"
        },
    })
}

/**
 * Creates/updates a customer in SevDesk.
 *
 * @param customer
 */
function onCustomerUpdated(customer: Stripe.Customer): Promise<AxiosResponse> {
    if (null === customer.metadata || null === customer.metadata.sevdesk_id) {
        return createOrUpdateContact(customer)

    }
    const customerId = customer.metadata.sevdesk_id;

    return createOrUpdateContact(customer, customerId)
}

/**
 * Log the error and send a NOK status code to let Stripe retry the webhook.
 *
 * @param res
 * @param error
 */
function handleError(res: Response, error?: AxiosError) {
    console.error(error?.response)

    res.status(500).json({error: true, message: error?.message})

    throw new Error('An error occurred')
}

/**
 * Creates a SevDesk contact or updates an existing one when ID given.
 *
 * @param customer
 * @param customerId
 */
async function createOrUpdateContact(customer: Stripe.Customer, customerId?: String): Promise<AxiosResponse> {
    const client = await sevDeskClient()

    const data = {
        name: customer.name,
        category: {
            id: 3,
            objectName: "Category"
        },
        description: customer.id,
        exemptVat: 'exempt' === customer.tax_exempt,
    }

    if (typeof customer.tax_ids !== "undefined" && customer.tax_ids.data.length) {
        const taxId = customer.tax_ids.data[0]

        Object.assign(data, {
            vatNumber: 'eu_vat' === taxId.type ? taxId.value : null,
            taxType: ('eu_vat' === taxId.type) ? 'eu' : null,
        })
    }

    if (typeof customerId === "undefined") {
        return client.post('/Contact', data)
            .then(response => stripe.customers.update(customer.id, {metadata: {sevdesk_id: response.data.id}}))
    }

    return client.put(`/Contact/${customerId}`, data)
}

async function sevDeskClient(): Promise<AxiosInstance> {
    const apiKey = await accessSecretVersion(String(process.env.SEVDESK_API_KEY_SECRET))

    return axios.create({
        baseURL: 'https://my.sevdesk.de/api/v1/',
        headers: {Authorization: apiKey}
    })
}

async function accessSecretVersion(name: String) {
    const [version] = await secretManagerClient.accessSecretVersion({
        name: name,
    });

    return version.payload.data.toString();
}
