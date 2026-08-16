/**
 * Next's edge URL-pattern declaration currently references these names before
 * TypeScript's DOM library exposes them. The runtime is not used by this app;
 * this compatibility declaration keeps the framework's public types complete.
 */
type URLPatternInput = string | URLPatternInit;

interface URLPatternOptions {
  ignoreCase?: boolean;
}
