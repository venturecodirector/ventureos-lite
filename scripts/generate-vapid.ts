import webpush from "web-push";

/**
 * Generate a VAPID key pair for Web Push (playbook-v2 P6/1).
 *
 * Run once per deployment: `npm run vapid`. Put both lines in .env. Rotating
 * the pair invalidates every stored subscription, because a browser's
 * subscription is bound to the public key it was created with — so rotate only
 * deliberately, and expect everyone to re-enable push afterwards.
 */
const keys = webpush.generateVAPIDKeys();
// eslint-disable-next-line no-console
console.log(
  [
    "# Web Push (P6/1). Both are required together; rotating them invalidates",
    "# every existing subscription.",
    `VAPID_PUBLIC_KEY=${keys.publicKey}`,
    `VAPID_PRIVATE_KEY=${keys.privateKey}`,
    "VAPID_SUBJECT=mailto:ops@ventureco.group",
  ].join("\n"),
);
