# stripe2sevdesk

Cloud function (Google Cloud Platform) that handles/receives Stripe webhook requests on certain events 
and pushes changes to the SevDesk API.

## Handled stripe events:

#### customer.created

Creates a Customer in SevDesk and updates the Stripe customer to hold the SevDesk internal Customer ID.

#### customer.changed

Updates a Customer in SevDesk.

#### invoice.finalized

As the invoice in Stripe becomes final and immutable, this creates the corresponding Invoice in SevDesk. The ID of the
SevDesk Invoice is attached to the Stripe invoice.

#### customer.finalized

Creates a Customer in SevDesk and sets the SevDesk ID on the Stripe customer.

#### invoice.paid

Books the corresponding SevDesk Invoice.

#### invoice.voided

Cancels the corresponding SevDesk Invoice.

## Set-up

1. Create a webhook in the Stripe dashboard that handles all the above Stripe events.
  
2. Gather the Webhook secret and provide it as environment variable `STRIPE_WEBHOOK_SECRET`.  

3. Create an API key in the Stripe Dashboard. You can limit the key to read-only access to the Webhooks and write access
to invoices and customers. Gather the key, place it in a secret (Google Secret manager) and provide the version name of 
the secret, e.g. `projects/my-project/secrets/my-secret/versions/latest` as environment variable `STRIPE_SECRET`. Make
sure this cloud function has access to the secret.

4. Gather a SevDesk API key, place it in a secret (Google Secret manager) and provide the version name of the secret, 
e.g. `projects/my-project/secrets/my-secret/versions/latest` as environment variable `SEVDESK_API_KEY_SECRET`. Make sure
this cloud function has access to the secret.

5. Create a check-account ("externes Bankkonto") in SevDesk and save its ID in the `SEVDESK_CHECK_ACCOUNT` variable.

5. Gather the Sentry DSN of your Sentry project and provide it as environment variable `SENTRY_DSN`.

6. Deploy the Cloud Function in GCP, preferably using CD (Google Cloud Build). This project already comes with a
`cloudbuild.yaml`.
