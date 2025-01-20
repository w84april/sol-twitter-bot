declare module "http" {
  interface IncomingMessage {
    rawBody: any;
  }
}

/***********************************************************************************************
 * Type Definitions
 * Define the expected structure of the webhook payload
 ***********************************************************************************************/
interface WebhookPayload {
  data?: {
    full_text?: string;
    image_url?: string;
  };
}
